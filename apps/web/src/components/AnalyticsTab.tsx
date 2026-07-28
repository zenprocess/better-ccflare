import { formatCost } from "@ccflare/core";
import type { TimeRange } from "@ccflare/types";
import { ACCOUNT_PROVIDERS } from "@ccflare/types";
import { formatPercentage, formatTokens } from "@ccflare/ui";
import { format } from "date-fns";
import { useMemo, useState } from "react";
import { useAnalytics } from "../hooks/queries";
import {
	AnalyticsControls,
	CumulativeGrowthChart,
	CumulativeTokenComposition,
	type FilterState,
	MainMetricsChart,
	ModelAnalytics,
	PerformanceIndicatorsChart,
	TokenSpeedAnalytics,
	TokenUsageBreakdown,
} from "./analytics";
import { ProviderBadge } from "./ProviderBadge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";

const DEFAULT_PROVIDERS = ACCOUNT_PROVIDERS;

export function AnalyticsTab() {
	const [timeRange, setTimeRange] = useState<TimeRange>("1h");
	const [selectedMetric, setSelectedMetric] = useState("requests");
	const [filterOpen, setFilterOpen] = useState(false);
	const [viewMode, setViewMode] = useState<"normal" | "cumulative">("normal");
	const [modelBreakdown, setModelBreakdown] = useState(false);
	const [filters, setFilters] = useState<FilterState>({
		providers: [],
		accounts: [],
		models: [],
		status: "all",
	});

	// Fetch analytics data with automatic refetch on dependency changes
	const { data: analytics, isLoading: loading } = useAnalytics(
		timeRange,
		filters,
		viewMode,
		modelBreakdown,
	);

	// Get unique accounts and models from analytics data
	const availableAccounts = useMemo(
		() => analytics?.accountPerformance?.map((a) => a.name) || [],
		[analytics],
	);
	const availableProviders = useMemo(
		() =>
			Array.from(
				new Set([
					...DEFAULT_PROVIDERS,
					...(analytics?.providerBreakdown?.map(
						(provider) => provider.provider,
					) || []),
				]),
			),
		[analytics],
	);
	const availableModels = useMemo(
		() => analytics?.modelDistribution?.map((m) => m.model) || [],
		[analytics],
	);

	// Apply filters to data
	const filterData = <T extends { errorRate?: number | string }>(
		data: T[],
	): T[] => {
		if (!analytics) return data;

		return data.filter((point) => {
			// Status filter
			if (filters.status !== "all") {
				const errorRate =
					typeof point.errorRate === "string"
						? parseFloat(point.errorRate)
						: point.errorRate || 0;
				if (filters.status === "success" && errorRate > 50) return false;
				if (filters.status === "error" && errorRate <= 50) return false;
			}

			// For time series data, we can't filter by specific accounts/models
			// Those filters will be applied to the other charts
			return true;
		});
	};

	// Transform time series data for charts
	const data = filterData(
		analytics?.timeSeries.map((point) => ({
			time:
				timeRange === "30d"
					? format(new Date(point.ts), "MMM d")
					: format(new Date(point.ts), "HH:mm"),
			requests: point.requests,
			tokens: point.tokens,
			cost: parseFloat(point.costUsd.toFixed(2)),
			responseTime: Math.round(point.avgResponseTime),
			errorRate: parseFloat(point.errorRate.toFixed(1)),
			cacheHitRate: parseFloat(point.cacheHitRate.toFixed(1)),
			avgTokensPerSecond: point.avgTokensPerSecond || 0,
		})) || [],
	);

	// Calculate token usage breakdown
	const tokenBreakdown = analytics?.tokenBreakdown
		? [
				{
					type: "Input Tokens",
					value: analytics.tokenBreakdown.inputTokens,
					percentage: 0,
				},
				{
					type: "Cache Read",
					value: analytics.tokenBreakdown.cacheReadInputTokens,
					percentage: 0,
				},
				{
					type: "Cache Creation",
					value: analytics.tokenBreakdown.cacheCreationInputTokens,
					percentage: 0,
				},
				{
					type: "Output Tokens",
					value: analytics.tokenBreakdown.outputTokens,
					percentage: 0,
				},
			].map((item) => {
				const total = analytics.totals.totalTokens || 1;
				return { ...item, percentage: Math.round((item.value / total) * 100) };
			})
		: [];

	// Use real model performance data from backend with filters
	const _modelPerformance =
		analytics?.modelPerformance
			?.filter(
				(perf) =>
					filters.models.length === 0 || filters.models.includes(perf.model),
			)
			?.map((perf) => ({
				model: perf.model,
				avgTime: Math.round(perf.avgResponseTime),
				p95Time: Math.round(perf.p95ResponseTime),
				errorRate: parseFloat(perf.errorRate.toFixed(1)),
			})) || [];

	// Use real cost by model data with filters
	const costByModel =
		analytics?.costByModel
			?.filter(
				(model) =>
					filters.models.length === 0 || filters.models.includes(model.model),
			)
			?.slice(0, 4) || [];

	// Count active filters
	const activeFilterCount =
		filters.providers.length +
		filters.accounts.length +
		filters.models.length +
		(filters.status !== "all" ? 1 : 0);

	return (
		<div className="space-y-6">
			{/* Controls */}
			<AnalyticsControls
				timeRange={timeRange}
				setTimeRange={setTimeRange}
				viewMode={viewMode}
				setViewMode={(mode) => {
					setViewMode(mode);
					// Disable per-model breakdown when switching to cumulative
					if (mode === "cumulative") {
						setModelBreakdown(false);
					}
				}}
				filters={filters}
				setFilters={setFilters}
				availableProviders={availableProviders}
				availableAccounts={availableAccounts}
				availableModels={availableModels}
				activeFilterCount={activeFilterCount}
				filterOpen={filterOpen}
				setFilterOpen={setFilterOpen}
				loading={loading}
				onRefresh={() => setTimeRange(timeRange)}
			/>

			{/* Cumulative View - Show cumulative charts first */}
			{viewMode === "cumulative" && analytics && (
				<>
					{/* Beautiful Cumulative Chart */}
					<CumulativeGrowthChart data={data} />

					{/* Cumulative Token Breakdown Ribbon Chart */}
					{tokenBreakdown.length > 0 && (
						<CumulativeTokenComposition tokenBreakdown={tokenBreakdown} />
					)}
				</>
			)}

			{/* Main Metrics Chart */}
			<MainMetricsChart
				data={data}
				rawTimeSeries={analytics?.timeSeries}
				loading={loading}
				viewMode={viewMode}
				timeRange={timeRange}
				selectedMetric={selectedMetric}
				setSelectedMetric={setSelectedMetric}
				modelBreakdown={modelBreakdown}
				onModelBreakdownChange={setModelBreakdown}
			/>

			<Card>
				<CardHeader>
					<CardTitle>Provider Breakdown</CardTitle>
					<CardDescription>
						Request volume, success rate, and usage by provider
					</CardDescription>
				</CardHeader>
				<CardContent>
					{analytics?.providerBreakdown?.length ? (
						<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
							{analytics.providerBreakdown.map((provider) => {
								const requestShare =
									analytics.totals.requests > 0
										? Math.round(
												(provider.requests / analytics.totals.requests) * 100,
											)
										: 0;

								return (
									<div
										key={provider.provider}
										className="rounded-lg border bg-muted/20 p-4"
									>
										<div className="flex items-center justify-between gap-3">
											<ProviderBadge provider={provider.provider} />
											<span className="text-sm text-muted-foreground">
												{requestShare}% of requests
											</span>
										</div>
										<div className="mt-4 grid grid-cols-2 gap-4">
											<div>
												<p className="text-xs text-muted-foreground">
													Requests
												</p>
												<p className="text-2xl font-semibold">
													{provider.requests.toLocaleString()}
												</p>
											</div>
											<div>
												<p className="text-xs text-muted-foreground">
													Success rate
												</p>
												<p className="text-2xl font-semibold">
													{formatPercentage(provider.successRate)}
												</p>
											</div>
											<div>
												<p className="text-xs text-muted-foreground">Tokens</p>
												<p className="text-lg font-medium">
													{formatTokens(provider.totalTokens)}
												</p>
											</div>
											<div>
												<p className="text-xs text-muted-foreground">Cost</p>
												<p className="text-lg font-medium">
													{formatCost(provider.totalCostUsd)}
												</p>
											</div>
										</div>
									</div>
								);
							})}
						</div>
					) : (
						<p className="text-sm text-muted-foreground">
							No provider activity found for the selected filters.
						</p>
					)}
				</CardContent>
			</Card>

			{/* Normal View Charts - Only show in normal mode */}
			{viewMode === "normal" && (
				<>
					{/* Secondary Charts Row */}
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
						<PerformanceIndicatorsChart
							data={data}
							loading={loading}
							modelBreakdown={modelBreakdown}
							rawTimeSeries={analytics?.timeSeries}
							timeRange={timeRange}
						/>
						<TokenUsageBreakdown
							tokenBreakdown={tokenBreakdown}
							timeRange={timeRange}
						/>
					</div>

					{/* Enhanced Model Analytics */}
					<ModelAnalytics
						modelPerformance={analytics?.modelPerformance || []}
						costByModel={costByModel}
						loading={loading}
						timeRange={timeRange}
					/>

					{/* Token Speed Analytics */}
					<TokenSpeedAnalytics
						timeSeriesData={data}
						modelPerformance={analytics?.modelPerformance || []}
						loading={loading}
						timeRange={timeRange}
					/>
				</>
			)}
		</div>
	);
}
