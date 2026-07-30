import type { Database } from "bun:sqlite";

/**
 * Distilled-first, fail-closed prune gate for request_payloads.
 *
 * Replaces the blind age-based cleanup (deletePayloadsOlderThan +
 * deleteOrphanedPayloads + cascading requests.deleteOlderThan) with a gate
 * that only ever deletes a payload row that is BOTH
 *   (a) past the retention window, AND
 *   (b) marked distilled in the `payload_distilled` marker table
 *       (written by the payload distiller, NOT by this codebase).
 *
 * Fail-closed semantics:
 *   - `payload_distilled` table missing entirely  -> delete NOTHING, alert.
 *   - payload old but not marked distilled        -> KEEP it, count it, alert.
 *   - any error mid-run                           -> stop, report, keep data.
 * Data ACCUMULATES and ALERTS rather than being lost when the distiller is
 * broken or has never run.
 *
 * Batching: every DELETE is `... WHERE id IN (SELECT ... LIMIT ?)`, executed
 * in a loop of small independent statements instead of one giant statement.
 * This is what fixes the StartupMaintenance failure observed live
 * ("PostgresError: canceling statement due to statement timeout" on the
 * postgres-backed deployment; multi-GB WAL growth + long write-lock holds on
 * the sqlite backend): each statement now touches at most `batchSize` rows,
 * finishes quickly, and the run yields between batches (onBatch hook), so no
 * single statement can hit a statement timeout or hold the 20GB table locked.
 * A time budget + max-batch cap bound each run; leftover work is picked up by
 * the next periodic run (the gate is resumable by construction).
 *
 * The cascade hazard is also closed: `requests` rows are deleted with
 * `ON DELETE CASCADE` into request_payloads, so old requests are only deleted
 * when their payload is absent or distilled.
 */

export const DISTILLED_TABLE = "payload_distilled";

export interface PruneGateOptions {
	/** Max rows per single DELETE statement (default 200). */
	batchSize?: number;
	/** Hard cap on DELETE statements per run (default 500). */
	maxBatches?: number;
	/** Soft wall-clock budget per run in ms (default 30s). */
	timeBudgetMs?: number;
	/**
	 * Called after every batch statement. Gives the event loop / a test a
	 * seam between statements (no lock is held between batches in WAL mode).
	 */
	onBatch?: (info: {
		phase: PrunePhase;
		batch: number;
		deleted: number;
	}) => void;
}

export type PrunePhase =
	| "payloads_old_distilled"
	| "payloads_orphan_distilled"
	| "requests_old_gated"
	| "markers_orphaned";

export interface PruneGateResult {
	/** True when the gate refused to delete anything (marker table missing / error). */
	failClosed: boolean;
	/** Human-readable reason when failClosed (stable prefix for monitors). */
	reason: string | null;
	/** Payloads deleted (old + distilled). */
	deletedPayloads: number;
	/** Orphan payloads (requests row gone) deleted because distilled. */
	deletedOrphanPayloads: number;
	/** Requests rows deleted (payload absent or distilled — cascade-safe). */
	deletedRequests: number;
	/** Old-but-undistilled payloads RETAINED this run (the alert counter). */
	keptUndistilledPayloads: number;
	/** Undistilled orphan payloads RETAINED this run. */
	keptUndistilledOrphans: number;
	/** Stale distilled-markers removed (marker without payload; housekeeping). */
	deletedStaleMarkers: number;
	/** Number of DELETE statements executed. */
	batches: number;
	/** False when stopped early on maxBatches/timeBudget with work remaining. */
	exhausted: boolean;
}

export interface PruneCutoffs {
	/** Delete payloads for requests with timestamp < payloadCutoffTs (epoch ms). */
	payloadCutoffTs: number;
	/** Delete request rows with timestamp < requestCutoffTs (epoch ms). Omit to skip. */
	requestCutoffTs?: number;
}

const DEFAULTS = {
	batchSize: 200,
	maxBatches: 500,
	timeBudgetMs: 30_000,
} as const;

export function distilledTableExists(db: Database): boolean {
	const row = db
		.query<{ name: string }, [string]>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
		)
		.get(DISTILLED_TABLE);
	return row !== null && row !== undefined;
}

/** Count old payloads NOT marked distilled (the fail-closed backlog). */
export function countUndistilledOldPayloads(
	db: Database,
	payloadCutoffTs: number,
): number {
	const row = db
		.query<{ n: number }, [number]>(
			`SELECT COUNT(*) AS n
			 FROM request_payloads rp
			 JOIN requests r ON r.id = rp.id
			 LEFT JOIN ${DISTILLED_TABLE} pd ON pd.id = rp.id
			 WHERE r.timestamp < ? AND pd.id IS NULL`,
		)
		.get(payloadCutoffTs);
	return row?.n ?? 0;
}

/** Count ALL old payloads regardless of distilled state (used when the marker table is missing). */
function countOldPayloads(db: Database, payloadCutoffTs: number): number {
	const row = db
		.query<{ n: number }, [number]>(
			`SELECT COUNT(*) AS n
			 FROM request_payloads rp
			 JOIN requests r ON r.id = rp.id
			 WHERE r.timestamp < ?`,
		)
		.get(payloadCutoffTs);
	return row?.n ?? 0;
}

function countUndistilledOrphans(db: Database): number {
	const row = db
		.query<{ n: number }, []>(
			`SELECT COUNT(*) AS n
			 FROM request_payloads rp
			 LEFT JOIN requests r ON r.id = rp.id
			 LEFT JOIN ${DISTILLED_TABLE} pd ON pd.id = rp.id
			 WHERE r.id IS NULL AND pd.id IS NULL`,
		)
		.get();
	return row?.n ?? 0;
}

interface BatchState {
	batches: number;
	startedAt: number;
	batchSize: number;
	maxBatches: number;
	timeBudgetMs: number;
	onBatch?: PruneGateOptions["onBatch"];
	exhausted: boolean;
}

/**
 * Run one bounded batched-DELETE loop. Each iteration is an independent
 * short statement; stops when a batch deletes fewer rows than batchSize
 * (source drained) or when the run-wide caps are hit.
 */
function batchedDelete(
	db: Database,
	phase: PrunePhase,
	sql: string,
	params: Array<number | string>,
	state: BatchState,
): number {
	let total = 0;
	for (;;) {
		if (state.batches >= state.maxBatches) {
			state.exhausted = false;
			return total;
		}
		if (Date.now() - state.startedAt >= state.timeBudgetMs) {
			state.exhausted = false;
			return total;
		}
		const res = db.run(sql, [...params, state.batchSize]);
		const deleted = res.changes;
		state.batches += 1;
		total += deleted;
		state.onBatch?.({ phase, batch: state.batches, deleted });
		if (deleted < state.batchSize) {
			return total; // drained
		}
	}
}

function emptyResult(): PruneGateResult {
	return {
		failClosed: false,
		reason: null,
		deletedPayloads: 0,
		deletedOrphanPayloads: 0,
		deletedRequests: 0,
		keptUndistilledPayloads: 0,
		keptUndistilledOrphans: 0,
		deletedStaleMarkers: 0,
		batches: 0,
		exhausted: true,
	};
}

/**
 * The prune gate. Synchronous (bun:sqlite is synchronous); every statement
 * it issues is bounded by opts.batchSize rows.
 *
 * NEVER deletes: undistilled payloads, requests whose payload is undistilled
 * (cascade guard), anything at all when `payload_distilled` does not exist.
 */
export function runPruneGate(
	db: Database,
	cutoffs: PruneCutoffs,
	opts: PruneGateOptions = {},
): PruneGateResult {
	const result = emptyResult();
	const state: BatchState = {
		batches: 0,
		startedAt: Date.now(),
		batchSize: Math.max(1, opts.batchSize ?? DEFAULTS.batchSize),
		maxBatches: Math.max(1, opts.maxBatches ?? DEFAULTS.maxBatches),
		timeBudgetMs: Math.max(1, opts.timeBudgetMs ?? DEFAULTS.timeBudgetMs),
		onBatch: opts.onBatch,
		exhausted: true,
	};

	// FAIL CLOSED: no marker table -> the distiller has never run here.
	// Delete nothing (not even request rows: their FK cascade would destroy
	// payloads, and a missing table means we cannot prove anything is safe).
	if (!distilledTableExists(db)) {
		result.failClosed = true;
		result.reason = `PRUNE_GATE_FAIL_CLOSED: marker table '${DISTILLED_TABLE}' missing — distiller has not run; deleting nothing`;
		result.keptUndistilledPayloads = countOldPayloads(
			db,
			cutoffs.payloadCutoffTs,
		);
		return result;
	}

	try {
		// Phase 1: old + distilled payloads -> delete (batched).
		result.deletedPayloads = batchedDelete(
			db,
			"payloads_old_distilled",
			`DELETE FROM request_payloads WHERE id IN (
				SELECT rp.id
				FROM request_payloads rp
				JOIN requests r ON r.id = rp.id
				JOIN ${DISTILLED_TABLE} pd ON pd.id = rp.id
				WHERE r.timestamp < ?
				LIMIT ?)`,
			[cutoffs.payloadCutoffTs],
			state,
		);

		// Phase 2: orphan payloads (requests row already gone) -> delete ONLY
		// if distilled. Undistilled orphans are kept and counted.
		result.deletedOrphanPayloads = batchedDelete(
			db,
			"payloads_orphan_distilled",
			`DELETE FROM request_payloads WHERE id IN (
				SELECT rp.id
				FROM request_payloads rp
				LEFT JOIN requests r ON r.id = rp.id
				JOIN ${DISTILLED_TABLE} pd ON pd.id = rp.id
				WHERE r.id IS NULL
				LIMIT ?)`,
			[],
			state,
		);

		// Phase 3: old request rows — cascade-safe. Only delete a request when
		// it has no payload row (nothing to lose) or its payload is distilled
		// (phase 1 usually removed it already; the cascade then only ever
		// destroys distilled payloads).
		if (typeof cutoffs.requestCutoffTs === "number") {
			result.deletedRequests = batchedDelete(
				db,
				"requests_old_gated",
				`DELETE FROM requests WHERE id IN (
					SELECT r.id
					FROM requests r
					LEFT JOIN request_payloads rp ON rp.id = r.id
					LEFT JOIN ${DISTILLED_TABLE} pd ON pd.id = r.id
					WHERE r.timestamp < ? AND (rp.id IS NULL OR pd.id IS NOT NULL)
					LIMIT ?)`,
				[cutoffs.requestCutoffTs],
				state,
			);
		}

		// Phase 4: housekeeping — markers whose payload no longer exists.
		// (Markers only, never payload data.)
		result.deletedStaleMarkers = batchedDelete(
			db,
			"markers_orphaned",
			`DELETE FROM ${DISTILLED_TABLE} WHERE id IN (
				SELECT pd.id
				FROM ${DISTILLED_TABLE} pd
				LEFT JOIN request_payloads rp ON rp.id = pd.id
				WHERE rp.id IS NULL
				LIMIT ?)`,
			[],
			state,
		);

		// Alert counters: what did we refuse to delete?
		result.keptUndistilledPayloads = countUndistilledOldPayloads(
			db,
			cutoffs.payloadCutoffTs,
		);
		result.keptUndistilledOrphans = countUndistilledOrphans(db);
		result.batches = state.batches;
		result.exhausted = state.exhausted;
		return result;
	} catch (err) {
		// FAIL CLOSED on any mid-run error: report what we did, delete no more.
		result.failClosed = true;
		result.reason = `PRUNE_GATE_FAIL_CLOSED: error mid-run (${err instanceof Error ? err.message : String(err)})`;
		result.batches = state.batches;
		result.exhausted = false;
		return result;
	}
}
