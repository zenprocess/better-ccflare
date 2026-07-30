import type { Config } from "@ccflare/config";
import type { DatabaseOperations } from "@ccflare/database";
import { errorResponse, jsonResponse } from "@ccflare/http";
import { Logger } from "@ccflare/logger";
import type { CleanupResponse, MutationResult } from "@ccflare/types";

const log = new Logger("MaintenanceHandler");

export function createCleanupHandler(
	dbOps: DatabaseOperations,
	config: Config,
) {
	return (): Response => {
		try {
			const payloadDays = config.getDataRetentionDays();
			const requestDays = config.getRequestRetentionDays();
			const payloadMs = payloadDays * 24 * 60 * 60 * 1000;
			const requestMs = requestDays * 24 * 60 * 60 * 1000;
			const cleanup = dbOps.cleanupOldRequests(payloadMs, requestMs);
			const cutoffIso = new Date(
				Date.now() - Math.min(payloadMs, requestMs),
			).toISOString();
			const cleanupData: CleanupResponse = {
				removedRequests: cleanup.removedRequests,
				removedPayloads: cleanup.removedPayloads,
				cutoffIso,
				keptUndistilledPayloads: cleanup.keptUndistilledPayloads,
				failClosed: cleanup.failClosed,
				reason: cleanup.reason,
				batches: cleanup.batches,
				exhausted: cleanup.exhausted,
			};
			const gateNote = cleanup.failClosed
				? ` — PRUNE GATE FAIL-CLOSED: ${cleanup.reason ?? "unknown"}`
				: cleanup.keptUndistilledPayloads > 0
					? ` — kept ${cleanup.keptUndistilledPayloads} undistilled payload(s)`
					: "";
			const result: MutationResult<CleanupResponse> = {
				success: true,
				message: `Cleaned up ${cleanup.removedRequests} requests and ${cleanup.removedPayloads} payloads${gateNote}`,
				data: cleanupData,
			};
			return jsonResponse(result);
		} catch (error) {
			log.error("Cleanup operation failed", error);
			return errorResponse(
				error instanceof Error ? error : new Error("Cleanup operation failed"),
			);
		}
	};
}

export function createCompactHandler(dbOps: DatabaseOperations) {
	return (): Response => {
		try {
			dbOps.compact();
			const result: MutationResult = {
				success: true,
				message: "Database compacted successfully",
			};
			return jsonResponse(result);
		} catch (error) {
			log.error("Compaction operation failed", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Database compaction failed"),
			);
		}
	};
}
