import type { DatabaseOperations } from "@ccflare/database";

/**
 * Reset all account statistics
 */
export function resetAllStats(dbOps: DatabaseOperations): void {
	dbOps.resetStats();
}

/**
 * Clear all request history
 */
export function clearRequestHistory(dbOps: DatabaseOperations): {
	count: number;
} {
	return { count: dbOps.clearRequestHistory() };
}
