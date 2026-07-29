import { DatabaseFactory } from "@ccflare/database";
import * as cliCommands from "./cli";

export interface Stats {
	totalRequests: number;
	successRate: number;
	activeAccounts: number;
	avgResponseTime: number;
	totalTokens: number;
	totalCostUsd: number;
	avgTokensPerSecond: number | null;
	tokenDetails?: {
		inputTokens: number;
		cacheReadInputTokens: number;
		cacheCreationInputTokens: number;
		outputTokens: number;
	};
	accounts: Array<{
		name: string;
		requestCount: number;
		successRate: number;
	}>;
	recentErrors: string[];
}

export async function getStats(): Promise<Stats> {
	const dbOps = DatabaseFactory.getInstance();
	const statsRepository = dbOps.getStatsRepository();

	// Get overall statistics using the consolidated repository
	const stats = statsRepository.getAggregatedStats();
	const activeAccounts = statsRepository.getActiveAccountCount();

	// Get per-account stats using the consolidated repository
	const accountsWithStats = statsRepository.getAccountStats(10, false);

	// Get recent errors
	const recentErrors = statsRepository.getRecentErrors();

	return {
		totalRequests: stats.totalRequests,
		successRate: stats.successRate,
		activeAccounts,
		avgResponseTime: Math.round(stats.avgResponseTime || 0),
		totalTokens: stats.totalTokens,
		totalCostUsd: stats.totalCostUsd,
		avgTokensPerSecond: stats.avgTokensPerSecond,
		tokenDetails:
			stats.inputTokens || stats.outputTokens
				? {
						inputTokens: stats.inputTokens,
						cacheReadInputTokens: stats.cacheReadInputTokens,
						cacheCreationInputTokens: stats.cacheCreationInputTokens,
						outputTokens: stats.outputTokens,
					}
				: undefined,
		accounts: accountsWithStats,
		recentErrors,
	};
}

export async function resetStats(): Promise<void> {
	const dbOps = DatabaseFactory.getInstance();
	dbOps.resetStats();
}

export async function clearHistory(): Promise<void> {
	const dbOps = DatabaseFactory.getInstance();
	dbOps.clearRequestHistory();
}

export async function analyzePerformance(): Promise<void> {
	const dbOps = DatabaseFactory.getInstance();
	cliCommands.analyzePerformance(dbOps);
}
