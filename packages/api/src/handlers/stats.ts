import type { DatabaseOperations } from "@ccflare/database";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@ccflare/http";
import { Logger } from "@ccflare/logger";
import type { MutationResult, StatsWithAccounts } from "@ccflare/types";

const log = new Logger("StatsHandler");

/**
 * Create a stats handler
 */
export function createStatsHandler(dbOps: DatabaseOperations) {
	return (): Response => {
		try {
			const statsRepository = dbOps.getStatsRepository();

			const stats = statsRepository.getAggregatedStats();
			const activeAccounts = statsRepository.getActiveAccountCount();
			const accountsWithStats = statsRepository.getAccountStats(10, true);
			const recentErrors = statsRepository.getRecentErrors();
			const topModels = statsRepository.getTopModels();

			const response: StatsWithAccounts = {
				totalRequests: stats.totalRequests,
				successRate: stats.successRate,
				activeAccounts,
				avgResponseTime: Math.round(stats.avgResponseTime || 0),
				totalTokens: stats.totalTokens,
				totalCostUsd: stats.totalCostUsd,
				topModels,
				avgTokensPerSecond: stats.avgTokensPerSecond,
				accounts: accountsWithStats,
				recentErrors,
			};

			return jsonResponse(response);
		} catch (error) {
			log.error("Failed to compute statistics", error);
			return errorResponse(InternalServerError("Failed to compute statistics"));
		}
	};
}

/**
 * Create a stats reset handler
 */
export function createStatsResetHandler(dbOps: DatabaseOperations) {
	return (): Response => {
		try {
			dbOps.resetStats();

			const result: MutationResult = {
				success: true,
				message: "Statistics reset successfully",
			};
			return jsonResponse(result);
		} catch (error) {
			log.error("Failed to reset statistics", error);
			return errorResponse(InternalServerError("Failed to reset statistics"));
		}
	};
}
