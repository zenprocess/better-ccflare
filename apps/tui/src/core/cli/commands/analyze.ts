import type { DatabaseOperations } from "@ccflare/database";
import { analyzeDatabasePerformance } from "@ccflare/database";

/**
 * Analyze query performance and index usage
 */
export function analyzePerformance(dbOps: DatabaseOperations): void {
	analyzeDatabasePerformance(dbOps);
}
