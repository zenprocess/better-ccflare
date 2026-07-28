import { buildAnalyticsQuery, DatabaseFactory } from "@ccflare/database";
import { isTimeRange } from "@ccflare/types";

export interface TimeSeriesDataPoint {
	time: number;
	requests: number;
	tokens: number;
	cost: number;
	responseTime: number;
	errorRate: number;
	cacheHitRate: number;
	successRate: number;
}

export interface ModelDistribution {
	model: string;
	count: number;
	percentage: number;
}

export interface Analytics {
	timeSeries: TimeSeriesDataPoint[];
	modelDistribution: ModelDistribution[];
}

export async function getAnalytics(timeRange: string): Promise<Analytics> {
	const dbOps = DatabaseFactory.getInstance();
	const query = buildAnalyticsQuery({
		range: isTimeRange(timeRange) ? timeRange : "24h",
	});
	const analytics = dbOps.getAnalytics(query.options);
	const modelDistData = analytics.modelDistribution;

	const totalModelRequests = modelDistData.reduce((sum, m) => sum + m.count, 0);

	const modelDistribution = modelDistData.map((m) => ({
		model: m.model,
		count: m.count,
		percentage:
			totalModelRequests > 0 ? (m.count / totalModelRequests) * 100 : 0,
	}));

	return {
		timeSeries: analytics.timeSeries.map((point) => ({
			time: point.ts,
			requests: point.requests,
			tokens: point.tokens,
			cost: point.costUsd,
			responseTime: point.avgResponseTime,
			errorRate: point.errorRate,
			cacheHitRate: point.cacheHitRate,
			successRate: point.successRate,
		})),
		modelDistribution,
	};
}
