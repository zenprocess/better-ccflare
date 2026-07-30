import type { Config } from "@ccflare/config";
import type { DatabaseOperations } from "@ccflare/database";
import { Logger } from "@ccflare/logger";
import { alertOnPruneResult } from "./prune-alerts";

/**
 * Startup maintenance now runs the distilled-first, fail-closed prune gate
 * (see @ccflare/database prune-gate.ts) instead of the old blind age-based
 * delete. Two operational changes:
 *
 *  - Deletes are BATCHED with a bounded time budget, so startup can never
 *    hang or die on one giant DELETE (the live failure mode was
 *    "canceling statement due to statement timeout" from a single statement
 *    over the multi-GB request_payloads table). Leftovers are picked up by
 *    the periodic cleanup — the gate is resumable.
 *
 *  - When the gate keeps old-but-undistilled payloads (or fails closed
 *    because the distiller marker table is missing), it ALERTS via
 *    PRUNE_GATE_ALERT log lines + optional ntfy (CCFLARE_PRUNE_NTFY_URL).
 *    Data accumulates rather than being lost.
 */

/** Bounded time budget for the startup pass; periodic runs finish the rest. */
const STARTUP_PRUNE_TIME_BUDGET_MS = 30_000;

export function runStartupMaintenance(
	config: Config,
	dbOps: DatabaseOperations,
): () => void {
	const log = new Logger("StartupMaintenance");

	let removedAnything = false;
	try {
		const payloadDays = config.getDataRetentionDays();
		const requestDays = config.getRequestRetentionDays();
		const result = dbOps.cleanupOldRequests(
			payloadDays * 24 * 60 * 60 * 1000,
			requestDays * 24 * 60 * 60 * 1000,
			{ timeBudgetMs: STARTUP_PRUNE_TIME_BUDGET_MS },
		);
		removedAnything = result.removedRequests + result.removedPayloads > 0;
		log.info(
			`Startup cleanup removed ${result.removedRequests} requests and ${result.removedPayloads} payloads ` +
				`in ${result.batches} batch(es) (payload=${payloadDays}d, requests=${requestDays}d, ` +
				`keptUndistilled=${result.keptUndistilledPayloads}, exhausted=${result.exhausted})`,
		);
		alertOnPruneResult(result);
	} catch (err) {
		log.error(`Startup cleanup error: ${err}`);
	}

	try {
		// VACUUM blocks the whole DB; only worth it when rows were reclaimed.
		if (removedAnything) {
			dbOps.compact();
			log.info("Database compacted at startup");
		} else {
			log.info("Skipping startup compaction (nothing was removed)");
		}
	} catch (err) {
		log.error(`Database compaction error: ${err}`);
	}

	return () => {};
}
