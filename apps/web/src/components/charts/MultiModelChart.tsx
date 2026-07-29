import { formatCost, getModelShortName } from "@ccflare/core";
import { formatNumber, formatTokens, formatTokensPerSecond } from "@ccflare/ui";
import {
	CartesianGrid,
	Legend,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { CHART_HEIGHTS, CHART_PROPS } from "../../constants";
import {
	type ChartColors,
	useChartColorSequence,
	useChartColors,
} from "../../hooks/useChartColors";
import {
	formatCompactCurrency,
	formatCompactNumber,
} from "../../lib/chart-utils";
import { ChartContainer } from "./ChartContainer";
import { getTooltipStyles } from "./chart-utils";

interface MultiModelChartProps {
	data: Array<{
		time: string;
		[model: string]: string | number;
	}>;
	models: string[];
	metric:
		| "requests"
		| "tokens"
		| "cost"
		| "responseTime"
		| "tokensPerSecond"
		| "errorRate"
		| "cacheHitRate";
	loading?: boolean;
	height?: number;
	viewMode?: "normal" | "cumulative";
}

function getModelColor(
	model: string,
	index: number,
	colors: ChartColors,
	chartColors: readonly string[],
): string {
	const modelColors: Record<string, string> = {
		"claude-3.5-sonnet": colors.chart3,
		"claude-3.5-haiku": colors.success,
		"claude-3-opus": colors.info,
		"claude-opus-4": colors.chart4,
	};

	const shortName = getModelShortName(model);
	if (modelColors[shortName]) return modelColors[shortName];
	if (modelColors[model]) return modelColors[model];

	for (const [key, color] of Object.entries(modelColors)) {
		if (model.includes(key) || key.includes(model)) {
			return color;
		}
	}

	return chartColors[index % chartColors.length];
}

function getMetricLabel(metric: string): string {
	switch (metric) {
		case "requests":
			return "Requests";
		case "tokens":
			return "Tokens";
		case "cost":
			return "Cost ($)";
		case "responseTime":
			return "Response Time (ms)";
		case "tokensPerSecond":
			return "Tokens/Second";
		case "errorRate":
			return "Error Rate (%)";
		case "cacheHitRate":
			return "Cache Hit Rate (%)";
		default:
			return metric;
	}
}

function formatValue(value: number, metric: string): string {
	switch (metric) {
		case "cost":
			return formatCost(value);
		case "tokens":
			return formatTokens(value);
		case "tokensPerSecond":
			return formatTokensPerSecond(value);
		case "responseTime":
			return `${value.toFixed(0)}ms`;
		case "errorRate":
		case "cacheHitRate":
			return `${value.toFixed(1)}%`;
		default:
			return formatNumber(value);
	}
}

function formatAxisValue(value: number, metric: string): string {
	switch (metric) {
		case "cost":
			return formatCompactCurrency(value);
		case "tokens":
		case "requests":
			return formatCompactNumber(value);
		case "tokensPerSecond":
			return formatCompactNumber(value);
		case "responseTime":
			return formatCompactNumber(value);
		case "errorRate":
		case "cacheHitRate":
			return `${value.toFixed(0)}%`;
		default:
			return formatCompactNumber(value);
	}
}

export function MultiModelChart({
	data,
	models,
	metric,
	loading = false,
	height = CHART_HEIGHTS.large,
	viewMode = "normal",
}: MultiModelChartProps) {
	const colors = useChartColors();
	const chartColors = useChartColorSequence();
	if (loading || !data || data.length === 0) {
		return (
			<ChartContainer
				loading={loading}
				height={height}
				isEmpty={!loading && (!data || data.length === 0)}
				emptyState={
					<div className="text-muted-foreground">No data available</div>
				}
			>
				<div />
			</ChartContainer>
		);
	}

	return (
		<ResponsiveContainer width="100%" height={height}>
			<LineChart
				data={data}
				margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
			>
				<defs>
					{models.map((model, index) => (
						<linearGradient
							key={model}
							id={`gradient-${model}`}
							x1="0"
							y1="0"
							x2="0"
							y2="1"
						>
							<stop
								offset="0%"
								stopColor={getModelColor(model, index, colors, chartColors)}
								stopOpacity={0.9}
							/>
							<stop
								offset="100%"
								stopColor={getModelColor(model, index, colors, chartColors)}
								stopOpacity={0.3}
							/>
						</linearGradient>
					))}
					<filter id="glow">
						<feGaussianBlur stdDeviation="2" result="coloredBlur" />
						<feMerge>
							<feMergeNode in="coloredBlur" />
							<feMergeNode in="SourceGraphic" />
						</feMerge>
					</filter>
				</defs>
				<CartesianGrid
					strokeDasharray={CHART_PROPS.strokeDasharray}
					className={CHART_PROPS.gridClassName}
				/>
				<XAxis
					dataKey="time"
					fontSize={12}
					angle={data.length > 10 ? -45 : 0}
					textAnchor={data.length > 10 ? "end" : "middle"}
					height={data.length > 10 ? 60 : 30}
				/>
				<YAxis
					fontSize={12}
					tickFormatter={(value) => formatAxisValue(value, metric)}
					label={{
						value: getMetricLabel(metric),
						angle: -90,
						position: "insideLeft",
						style: { textAnchor: "middle", fontSize: 12 },
					}}
				/>
				<Tooltip
					contentStyle={getTooltipStyles("dark")}
					formatter={(value: number) => formatValue(value, metric)}
					labelFormatter={(label) =>
						viewMode === "cumulative" ? `Cumulative at ${label}` : label
					}
				/>
				<Legend
					verticalAlign="top"
					height={36}
					wrapperStyle={{ paddingTop: "10px" }}
				/>
				{models.map((model, index) => (
					<Line
						key={model}
						type="monotone"
						dataKey={model}
						name={model}
						stroke={getModelColor(model, index, colors, chartColors)}
						strokeWidth={viewMode === "cumulative" ? 3 : 2}
						dot={false}
						activeDot={{ r: 6 }}
						filter={viewMode === "cumulative" ? "url(#glow)" : undefined}
						connectNulls={true}
					/>
				))}
			</LineChart>
		</ResponsiveContainer>
	);
}
