import { formatCost, getModelShortName } from "@ccflare/core";
import type { TimeRange } from "@ccflare/types";
import {
	formatNumber,
	formatPercentage,
	getSuccessRateTermColor,
	getTimeRangeLabel,
} from "@ccflare/ui";
import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useState } from "react";
import * as tuiCore from "../core";
import { C } from "../theme.ts";
import { BarChart } from "./charts/BarChart.tsx";
import { LineChart } from "./charts/LineChart.tsx";
import { PieChart } from "./charts/PieChart.tsx";
import { SparklineChart } from "./charts/SparklineChart.tsx";

interface AnalyticsScreenProps {
	refreshKey: number;
}

type TuiTimeRange = Exclude<TimeRange, "30d">;
type ChartView = "overview" | "tokens" | "performance" | "costs" | "models";

const TIME_RANGES: { key: string; value: TuiTimeRange; label: string }[] = [
	{ key: "1", value: "1h", label: "1h" },
	{ key: "2", value: "6h", label: "6h" },
	{ key: "3", value: "24h", label: "24h" },
	{ key: "4", value: "7d", label: "7d" },
];

const VIEW_MODES: { key: string; value: ChartView; label: string }[] = [
	{ key: "o", value: "overview", label: "Overview" },
	{ key: "t", value: "tokens", label: "Tokens" },
	{ key: "p", value: "performance", label: "Perf" },
	{ key: "c", value: "costs", label: "Costs" },
	{ key: "d", value: "models", label: "Models" },
];

interface TimeSeriesPoint {
	time: string;
	requests: number;
	tokens: number;
	cost: number;
	responseTime: number;
	errorRate: number;
	cacheHitRate: number;
	successRate: number;
}

export function AnalyticsScreen({ refreshKey }: AnalyticsScreenProps) {
	const [timeRange, setTimeRange] = useState<TuiTimeRange>("24h");
	const [chartView, setChartView] = useState<ChartView>("overview");
	const [stats, setStats] = useState<tuiCore.Stats | null>(null);
	const [loading, setLoading] = useState(true);
	const [timeSeries, setTimeSeries] = useState<TimeSeriesPoint[]>([]);
	const [models, setModels] = useState<tuiCore.ModelDistribution[]>([]);

	useKeyboard((key) => {
		// Time range shortcuts
		for (const tr of TIME_RANGES) {
			if (key.name === tr.key) {
				setTimeRange(tr.value);
				return;
			}
		}
		// View mode shortcuts
		for (const vm of VIEW_MODES) {
			if (key.name === vm.key) {
				setChartView(vm.value);
				return;
			}
		}
	});

	const loadData = useCallback(async () => {
		try {
			setLoading(true);
			const [s, analytics] = await Promise.all([
				tuiCore.getStats(),
				tuiCore.getAnalytics(timeRange),
			]);
			setStats(s);
			setModels(analytics.modelDistribution);

			const transformed = analytics.timeSeries.map((pt) => {
				const t = new Date(pt.time);
				return {
					time:
						timeRange === "7d"
							? t.toLocaleDateString("en", { weekday: "short" })
							: t.toLocaleTimeString("en", {
									hour: "2-digit",
									minute: "2-digit",
								}),
					requests: pt.requests,
					tokens: pt.tokens,
					cost: pt.cost,
					responseTime: pt.responseTime,
					errorRate: pt.errorRate,
					cacheHitRate: pt.cacheHitRate,
					successRate: pt.successRate,
				};
			});
			setTimeSeries(transformed);
			setLoading(false);
		} catch {
			setLoading(false);
		}
	}, [timeRange]);

	useEffect(() => {
		loadData();
		const interval = setInterval(loadData, 30000);
		return () => clearInterval(interval);
	}, [loadData]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey triggers manual refresh
	useEffect(() => {
		loadData();
	}, [refreshKey, loadData]);

	if (loading || !stats) {
		return (
			<box padding={1}>
				<text fg={C.dim}>Loading analytics...</text>
			</box>
		);
	}

	const reqSparkline = timeSeries.map((d) => d.requests);
	const tokenSparkline = timeSeries.map((d) => d.tokens);
	const costSparkline = timeSeries.map((d) => d.cost);
	const respData = timeSeries.map((d) => ({ x: d.time, y: d.responseTime }));

	const modelData = models.slice(0, 5).map((m, i) => ({
		label: m.model,
		value: m.count,
		color: [C.chart1, C.chart2, C.chart3, C.chart4, C.chart5][i % 5],
	}));

	const accountBarData = stats.accounts.map((a) => ({
		label: a.name,
		value: a.requestCount,
		color: getSuccessRateTermColor(a.successRate),
	}));

	const renderChart = () => {
		switch (chartView) {
			case "overview":
				return (
					<box flexDirection="column" gap={1}>
						<text fg={C.text}>
							<strong>Request Volume & Performance</strong>
						</text>
						<box flexDirection="column">
							<SparklineChart
								data={reqSparkline}
								label="Requests"
								color={C.chart2}
								showCurrent
							/>
							<SparklineChart
								data={tokenSparkline}
								label="Tokens  "
								color={C.chart1}
								showCurrent
							/>
							<SparklineChart
								data={costSparkline}
								label="Cost    "
								color={C.success}
								showCurrent
							/>
						</box>
						<LineChart
							data={respData.slice(-20)}
							title="Response Time (ms)"
							height={8}
							width={50}
							color={C.chart3}
						/>
					</box>
				);

			case "tokens":
				return (
					<box flexDirection="column" gap={1}>
						{stats.tokenDetails && (
							<BarChart
								title="Token Usage Breakdown"
								data={[
									{
										label: "Input",
										value: stats.tokenDetails.inputTokens,
										color: C.chart1,
									},
									{
										label: "Cache Read",
										value: stats.tokenDetails.cacheReadInputTokens,
										color: C.chart2,
									},
									{
										label: "Cache Create",
										value: stats.tokenDetails.cacheCreationInputTokens,
										color: C.info,
									},
									{
										label: "Output",
										value: stats.tokenDetails.outputTokens,
										color: C.success,
									},
								]}
								width={40}
								showValues
							/>
						)}
						<box flexDirection="column" marginTop={1}>
							<text fg={C.text}>
								<strong>Token Efficiency</strong>
							</text>
							<box flexDirection="row" gap={1} marginTop={1}>
								<text fg={C.dim}>Avg tokens/req:</text>
								<text fg={C.chart1}>
									<strong>
										{formatNumber(
											stats.totalRequests > 0
												? Math.round(stats.totalTokens / stats.totalRequests)
												: 0,
										)}
									</strong>
								</text>
							</box>
							{stats.tokenDetails && (
								<box flexDirection="row" gap={1}>
									<text fg={C.dim}>Cache hit rate:</text>
									<text fg={C.chart2}>
										<strong>
											{formatPercentage(
												stats.tokenDetails.inputTokens > 0
													? (stats.tokenDetails.cacheReadInputTokens /
															stats.tokenDetails.inputTokens) *
															100
													: 0,
											)}
										</strong>
									</text>
								</box>
							)}
						</box>
					</box>
				);

			case "performance":
				return (
					<box flexDirection="column" gap={1}>
						<BarChart
							title="Account Performance (Requests)"
							data={accountBarData}
							width={35}
							showValues
						/>
						<box flexDirection="column" marginTop={1}>
							<text fg={C.text}>
								<strong>Performance Metrics</strong>
							</text>
							<box flexDirection="row" gap={1} marginTop={1}>
								<text fg={C.dim}>Success Rate:</text>
								<text fg={getSuccessRateTermColor(stats.successRate)}>
									<strong>{formatPercentage(stats.successRate)}</strong>
								</text>
							</box>
							<box flexDirection="row" gap={1}>
								<text fg={C.dim}>Avg Response:</text>
								<text fg={C.chart3}>
									<strong>{formatNumber(stats.avgResponseTime)}ms</strong>
								</text>
							</box>
							{stats.avgTokensPerSecond !== null && (
								<box flexDirection="row" gap={1}>
									<text fg={C.dim}>Output Speed:</text>
									<text fg={C.chart2}>
										<strong>
											{formatNumber(stats.avgTokensPerSecond)} tok/s
										</strong>
									</text>
								</box>
							)}
						</box>
					</box>
				);

			case "costs":
				return (
					<box flexDirection="column" gap={1}>
						<text fg={C.text}>
							<strong>Cost Analysis</strong>
						</text>
						<SparklineChart
							data={costSparkline}
							label="Cost Trend"
							color={C.success}
							showMinMax
							showCurrent
						/>
						<box flexDirection="column" marginTop={1}>
							<box flexDirection="row" gap={1}>
								<text fg={C.dim}>Total Cost:</text>
								<text fg={C.success}>
									<strong>{formatCost(stats.totalCostUsd)}</strong>
								</text>
							</box>
							<box flexDirection="row" gap={1}>
								<text fg={C.dim}>Avg per request:</text>
								<text fg={C.chart1}>
									{formatCost(
										stats.totalRequests > 0
											? stats.totalCostUsd / stats.totalRequests
											: 0,
									)}
								</text>
							</box>
							<box flexDirection="row" gap={1}>
								<text fg={C.dim}>Projected daily:</text>
								<text fg={C.muted}>
									{formatCost(
										stats.totalCostUsd *
											(24 /
												(timeRange === "1h"
													? 1
													: timeRange === "6h"
														? 6
														: timeRange === "24h"
															? 24
															: 168)),
									)}
								</text>
							</box>
						</box>
					</box>
				);

			case "models":
				return (
					<box flexDirection="column" gap={1}>
						<PieChart title="Model Distribution" data={modelData} showLegend />
						<box flexDirection="column" marginTop={1}>
							<text fg={C.text}>
								<strong>Model Performance</strong>
							</text>
							<box flexDirection="column" marginTop={1}>
								{models.slice(0, 5).map((model) => {
									const short = getModelShortName(model.model);
									const color = short.includes("opus")
										? C.chart3
										: short.includes("sonnet")
											? C.chart2
											: C.chart1;
									return (
										<box key={model.model} flexDirection="row" gap={1}>
											<text fg={C.dim}>{model.model}:</text>
											<text fg={color}>
												{formatNumber(model.count)} (
												{formatPercentage(model.percentage)})
											</text>
										</box>
									);
								})}
							</box>
						</box>
					</box>
				);
		}
	};

	return (
		<scrollbox flexGrow={1} focused>
			<box flexDirection="column" padding={1} gap={1}>
				{/* Controls bar */}
				<box flexDirection="row" gap={2}>
					<text fg={C.dim}>
						Time:{" "}
						{TIME_RANGES.map((tr) => (
							<span
								key={tr.key}
								fg={tr.value === timeRange ? C.accent : C.muted}
							>
								[{tr.key}]{tr.label}{" "}
							</span>
						))}
					</text>
					<text fg={C.dim}>
						View:{" "}
						{VIEW_MODES.map((vm) => (
							<span
								key={vm.key}
								fg={vm.value === chartView ? C.accent : C.muted}
							>
								[{vm.key}]{vm.label}{" "}
							</span>
						))}
					</text>
				</box>

				{/* Time range label */}
				<text fg={C.text}>
					<strong>{getTimeRangeLabel(timeRange)}</strong> · {chartView}
				</text>

				{/* Chart content */}
				{renderChart()}
			</box>
		</scrollbox>
	);
}
