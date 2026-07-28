import { formatCost, getModelShortName } from "@ccflare/core";
import { formatTokensPerSecond } from "@ccflare/ui";
import {
	Area,
	AreaChart,
	Bar,
	CartesianGrid,
	ComposedChart,
	Legend,
	Line,
	ResponsiveContainer,
	Scatter,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { CHART_HEIGHTS, CHART_PROPS } from "../../constants";
import { useChartColors } from "../../hooks/useChartColors";
import { ChartContainer } from "./ChartContainer";
import { getTooltipStyles } from "./chart-utils";

interface ModelComparisonData {
	model: string;
	avgTokensPerSecond: number | null;
	costPer1kTokens: number;
	avgResponseTime: number;
	errorRate: number;
	totalRequests: number;
}

interface ModelPerformanceComparisonProps {
	data: ModelComparisonData[];
	loading?: boolean;
	height?: number;
	viewMode?: "speed-cost" | "performance" | "efficiency";
}

function useModelColors() {
	const colors = useChartColors();

	const modelColors: Record<string, string> = {
		"claude-3.5-sonnet": colors.chart3,
		"claude-3.5-haiku": colors.success,
		"claude-3-opus": colors.info,
		"claude-opus-4": colors.chart4,
	};

	function getModelColor(model: string): string {
		const shortName = getModelShortName(model);
		if (modelColors[shortName]) return modelColors[shortName];
		if (modelColors[model]) return modelColors[model];
		for (const [key, color] of Object.entries(modelColors)) {
			if (model.includes(key) || key.includes(model)) {
				return color;
			}
		}
		return colors.primary;
	}

	return { colors, getModelColor };
}

export function ModelPerformanceComparison({
	data,
	loading = false,
	height = CHART_HEIGHTS.large,
	viewMode = "speed-cost",
}: ModelPerformanceComparisonProps) {
	const { colors, getModelColor } = useModelColors();
	// Filter and prepare data
	const chartData = data
		.filter((d) => d.avgTokensPerSecond !== null && d.avgTokensPerSecond > 0)
		.sort((a, b) => (b.avgTokensPerSecond || 0) - (a.avgTokensPerSecond || 0));

	if (viewMode === "speed-cost") {
		return (
			<ChartContainer
				loading={loading}
				height={height}
				isEmpty={chartData.length === 0}
				emptyState={
					<div className="text-muted-foreground">
						No model performance data available
					</div>
				}
			>
				<ResponsiveContainer width="100%" height={height}>
					<ComposedChart
						data={chartData}
						margin={{ top: 20, right: 30, left: 20, bottom: 80 }}
					>
						<defs>
							<linearGradient id="speedGradient" x1="0" y1="0" x2="0" y2="1">
								<stop offset="0%" stopColor={colors.chart3} stopOpacity={0.9} />
								<stop
									offset="100%"
									stopColor={colors.chart3}
									stopOpacity={0.3}
								/>
							</linearGradient>
							<linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
								<stop
									offset="0%"
									stopColor={colors.warning}
									stopOpacity={0.9}
								/>
								<stop
									offset="100%"
									stopColor={colors.warning}
									stopOpacity={0.3}
								/>
							</linearGradient>
							<filter id="glow">
								<feGaussianBlur stdDeviation="3" result="coloredBlur" />
								<feMerge>
									<feMergeNode in="coloredBlur" />
									<feMergeNode in="SourceGraphic" />
								</feMerge>
							</filter>
						</defs>
						<CartesianGrid
							strokeDasharray={CHART_PROPS.strokeDasharray}
							stroke="rgba(255,255,255,0.1)"
						/>
						<XAxis
							dataKey="model"
							angle={-45}
							textAnchor="end"
							height={80}
							interval={0}
							fontSize={12}
							stroke="rgba(255,255,255,0.5)"
						/>
						<YAxis
							yAxisId="speed"
							orientation="left"
							stroke={colors.chart3}
							fontSize={12}
							label={{
								value: "Tokens/Second",
								angle: -90,
								position: "insideLeft",
								style: { textAnchor: "middle", fill: colors.chart3 },
							}}
						/>
						<YAxis
							yAxisId="cost"
							orientation="right"
							stroke={colors.warning}
							fontSize={12}
							label={{
								value: "Cost per 1K Tokens ($)",
								angle: 90,
								position: "insideRight",
								style: { textAnchor: "middle", fill: colors.warning },
							}}
						/>
						<Tooltip
							contentStyle={{
								backgroundColor: "rgba(0,0,0,0.8)",
								border: "1px solid rgba(255,255,255,0.2)",
								borderRadius: "8px",
								backdropFilter: "blur(8px)",
							}}
							formatter={(value: number, name: string) => {
								if (name === "Speed")
									return [formatTokensPerSecond(value), name];
								if (name === "Cost/1K") return [formatCost(value), name];
								return [value, name];
							}}
						/>
						<Legend
							verticalAlign="top"
							height={36}
							iconType="rect"
							wrapperStyle={{ paddingBottom: "10px" }}
						/>
						<Bar
							yAxisId="speed"
							dataKey="avgTokensPerSecond"
							name="Speed"
							fill="url(#speedGradient)"
							filter="url(#glow)"
						/>
						<Line
							yAxisId="cost"
							type="monotone"
							dataKey="costPer1kTokens"
							name="Cost/1K"
							stroke={colors.warning}
							strokeWidth={3}
							dot={{ fill: colors.warning, r: 4 }}
							filter="url(#glow)"
						/>
					</ComposedChart>
				</ResponsiveContainer>
			</ChartContainer>
		);
	}

	if (viewMode === "performance") {
		return (
			<ChartContainer
				loading={loading}
				height={height}
				isEmpty={chartData.length === 0}
				emptyState={
					<div className="text-muted-foreground">
						No model performance data available
					</div>
				}
			>
				<ResponsiveContainer width="100%" height={height}>
					<ComposedChart
						data={chartData}
						margin={{ top: 20, right: 30, left: 20, bottom: 80 }}
					>
						<defs>
							<linearGradient id="responseGradient" x1="0" y1="0" x2="0" y2="1">
								<stop offset="0%" stopColor={colors.info} stopOpacity={0.9} />
								<stop offset="100%" stopColor={colors.info} stopOpacity={0.3} />
							</linearGradient>
						</defs>
						<CartesianGrid
							strokeDasharray={CHART_PROPS.strokeDasharray}
							className={CHART_PROPS.gridClassName}
						/>
						<XAxis
							dataKey="model"
							angle={-45}
							textAnchor="end"
							height={80}
							interval={0}
							fontSize={12}
						/>
						<YAxis
							yAxisId="time"
							orientation="left"
							fontSize={12}
							label={{
								value: "Response Time (ms)",
								angle: -90,
								position: "insideLeft",
								style: { textAnchor: "middle" },
							}}
						/>
						<YAxis
							yAxisId="error"
							orientation="right"
							fontSize={12}
							label={{
								value: "Error Rate (%)",
								angle: 90,
								position: "insideRight",
								style: { textAnchor: "middle" },
							}}
						/>
						<Tooltip
							contentStyle={getTooltipStyles("dark")}
							formatter={(value: number, name: string) => {
								if (name === "Response Time") return [`${value}ms`, name];
								if (name === "Error Rate") return [`${value}%`, name];
								return [value, name];
							}}
						/>
						<Legend verticalAlign="top" height={36} iconType="rect" />
						<Bar
							yAxisId="time"
							dataKey="avgResponseTime"
							name="Response Time"
							fill="url(#responseGradient)"
						/>
						<Scatter
							yAxisId="error"
							dataKey="errorRate"
							name="Error Rate"
							fill={colors.error}
						/>
					</ComposedChart>
				</ResponsiveContainer>
			</ChartContainer>
		);
	}

	// Efficiency view: Speed vs Cost scatter plot
	return (
		<ChartContainer
			loading={loading}
			height={height}
			isEmpty={chartData.length === 0}
			emptyState={
				<div className="text-muted-foreground">
					No model efficiency data available
				</div>
			}
		>
			<ResponsiveContainer width="100%" height={height}>
				<AreaChart
					data={chartData}
					margin={{ top: 20, right: 30, left: 60, bottom: 80 }}
				>
					<defs>
						{chartData.map((model, index) => (
							<linearGradient
								key={model.model}
								id={`gradient-${index}`}
								x1="0"
								y1="0"
								x2="0"
								y2="1"
							>
								<stop
									offset="0%"
									stopColor={getModelColor(model.model)}
									stopOpacity={0.9}
								/>
								<stop
									offset="100%"
									stopColor={getModelColor(model.model)}
									stopOpacity={0.1}
								/>
							</linearGradient>
						))}
					</defs>
					<CartesianGrid
						strokeDasharray={CHART_PROPS.strokeDasharray}
						stroke="rgba(255,255,255,0.1)"
					/>
					<XAxis
						dataKey="model"
						angle={-45}
						textAnchor="end"
						height={80}
						interval={0}
						fontSize={12}
					/>
					<YAxis
						fontSize={12}
						label={{
							value: "Efficiency Score",
							angle: -90,
							position: "insideLeft",
							style: { textAnchor: "middle" },
						}}
					/>
					<Tooltip
						contentStyle={{
							backgroundColor: "rgba(0,0,0,0.8)",
							border: "1px solid rgba(255,255,255,0.2)",
							borderRadius: "8px",
							backdropFilter: "blur(8px)",
						}}
						content={({ active, payload }) => {
							if (!active || !payload?.[0]) return null;
							const data = payload[0].payload;
							return (
								<div className="p-3 space-y-1">
									<p className="font-semibold">{data.model}</p>
									<p className="text-sm">
										Speed: {formatTokensPerSecond(data.avgTokensPerSecond)}
									</p>
									<p className="text-sm">
										Cost/1K: {formatCost(data.costPer1kTokens)}
									</p>
									<p className="text-sm">
										Efficiency:{" "}
										{(
											(data.avgTokensPerSecond || 0) / data.costPer1kTokens
										).toFixed(2)}
									</p>
								</div>
							);
						}}
					/>
					<Area
						type="monotone"
						dataKey={(data: ModelComparisonData) =>
							(data.avgTokensPerSecond || 0) / data.costPer1kTokens
						}
						stroke={colors.primary}
						strokeWidth={2}
						fill="url(#gradient-0)"
						name="Efficiency Score"
					/>
				</AreaChart>
			</ResponsiveContainer>
		</ChartContainer>
	);
}
