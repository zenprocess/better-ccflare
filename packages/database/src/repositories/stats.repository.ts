/**
 * Consolidated stats repository to eliminate duplication between tui-core and http-api
 */
import type { Database } from "bun:sqlite";
import { NO_ACCOUNT_ID } from "@ccflare/types";
import { RequestRepository } from "./request.repository";

export interface AccountStats {
	name: string;
	requestCount: number;
	successRate: number;
	totalRequests?: number;
}

export interface AggregatedStats {
	totalRequests: number;
	completedRequests: number;
	successfulRequests: number;
	successRate: number;
	avgResponseTime: number;
	totalTokens: number;
	totalCostUsd: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	avgTokensPerSecond: number | null;
}

export class StatsRepository {
	private requests: RequestRepository;

	constructor(private db: Database) {
		this.requests = new RequestRepository(db);
	}

	/**
	 * Get aggregated statistics for all requests
	 */
	getAggregatedStats(): AggregatedStats {
		const stats = this.requests.aggregateStats();
		const successRate =
			stats.completedRequests > 0
				? Math.round((stats.successfulRequests / stats.completedRequests) * 100)
				: 0;

		return {
			totalRequests: stats.totalRequests,
			completedRequests: stats.completedRequests,
			successfulRequests: stats.successfulRequests,
			successRate,
			avgResponseTime: stats.avgResponseTime ?? 0,
			totalTokens: stats.totalTokens,
			totalCostUsd: stats.totalCostUsd,
			inputTokens: stats.inputTokens,
			outputTokens: stats.outputTokens,
			cacheReadInputTokens: stats.cacheReadInputTokens,
			cacheCreationInputTokens: stats.cacheCreationInputTokens,
			avgTokensPerSecond: stats.avgTokensPerSecond,
		};
	}

	/**
	 * Get account statistics with success rates
	 * This consolidates the duplicated logic between tui-core and http-api
	 */
	getAccountStats(limit = 10, includeUnauthenticated = true): AccountStats[] {
		// Single grouped query that computes both counts and success rate
		const query = includeUnauthenticated
			? `
				SELECT
					COALESCE(a.name, ?) as name,
					COUNT(r.id) as requestCount,
					COALESCE(a.total_requests, 0) as totalRequests,
					CASE
						WHEN SUM(CASE WHEN r.success IS NOT NULL THEN 1 ELSE 0 END) > 0
						THEN CAST(ROUND(SUM(CASE WHEN r.success = 1 THEN 1 ELSE 0 END) * 100.0 /
							SUM(CASE WHEN r.success IS NOT NULL THEN 1 ELSE 0 END)) AS INTEGER)
						ELSE 0
					END as successRate
				FROM requests r
				LEFT JOIN accounts a ON a.id = r.account_used
				GROUP BY COALESCE(a.id, ?), COALESCE(a.name, ?)
				HAVING requestCount > 0
				ORDER BY requestCount DESC
				LIMIT ?
			`
			: `
				SELECT
					a.name,
					COUNT(r.id) as requestCount,
					a.total_requests as totalRequests,
					CASE
						WHEN SUM(CASE WHEN r.success IS NOT NULL THEN 1 ELSE 0 END) > 0
						THEN CAST(ROUND(SUM(CASE WHEN r.success = 1 THEN 1 ELSE 0 END) * 100.0 /
							SUM(CASE WHEN r.success IS NOT NULL THEN 1 ELSE 0 END)) AS INTEGER)
						ELSE 0
					END as successRate
				FROM accounts a
				INNER JOIN requests r ON r.account_used = a.id
				GROUP BY a.id
				HAVING requestCount > 0
				ORDER BY requestCount DESC
				LIMIT ?
			`;

		const params = includeUnauthenticated
			? [NO_ACCOUNT_ID, NO_ACCOUNT_ID, NO_ACCOUNT_ID, limit]
			: [limit];

		return this.db.query(query).all(...params) as AccountStats[];
	}

	/**
	 * Get count of active accounts
	 */
	getActiveAccountCount(): number {
		const result = this.db
			.query("SELECT COUNT(*) as count FROM accounts WHERE request_count > 0")
			.get() as { count: number };
		return result.count;
	}

	/**
	 * Get recent errors via the request repository owner
	 */
	getRecentErrors(limit = 10): string[] {
		return this.requests.getRecentErrors(limit);
	}

	/**
	 * Get top models by usage via the request repository owner
	 */
	getTopModels(
		limit = 5,
	): Array<{ model: string; count: number; percentage: number }> {
		const models = this.requests.getTopModels(limit);
		const total =
			(
				this.db
					.query(
						`SELECT COUNT(*) as total FROM requests WHERE model IS NOT NULL`,
					)
					.get() as { total: number } | null
			)?.total ?? 0;

		return models.map((model) => ({
			...model,
			percentage:
				total > 0 ? Math.round((model.count / total) * 10_000) / 100 : 0,
		}));
	}
}
