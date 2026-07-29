import { Line, LineChart, ReferenceLine } from "recharts";
import { useChartColors } from "../../hooks/useChartColors";
import { BaseXYChartFrame } from "./BaseXYChartFrame";
import type { CommonChartProps } from "./chart-utils";

interface LineConfig {
	dataKey: string;
	stroke?: string;
	strokeWidth?: number;
	dot?: boolean;
	name?: string;
}

interface ReferenceLineConfig {
	y: number;
	stroke?: string;
	strokeDasharray?: string;
	label?: string;
}

interface BaseLineChartProps extends CommonChartProps {
	lines: LineConfig | LineConfig[];
	referenceLines?: ReferenceLineConfig[];
}

export function BaseLineChart({
	data,
	lines,
	xAxisKey = "time",
	loading = false,
	height = "medium",
	xAxisAngle = 0,
	xAxisTextAnchor = "middle",
	xAxisHeight = 30,
	xAxisTickFormatter,
	yAxisDomain,
	yAxisTickFormatter,
	tooltipFormatter,
	tooltipLabelFormatter,
	tooltipStyle = "default",
	animationDuration = 1000,
	showLegend = false,
	legendHeight = 36,
	referenceLines = [],
	margin,
	className = "",
	error = null,
	emptyState,
	onChartClick,
}: BaseLineChartProps) {
	const colors = useChartColors();
	const lineConfigs = Array.isArray(lines) ? lines : [lines];

	return (
		<BaseXYChartFrame
			chartComponent={LineChart}
			data={data}
			loading={loading}
			height={height}
			xAxisKey={xAxisKey}
			xAxisAngle={xAxisAngle}
			xAxisTextAnchor={xAxisTextAnchor}
			xAxisHeight={xAxisHeight}
			xAxisTickFormatter={xAxisTickFormatter}
			yAxisDomain={yAxisDomain}
			yAxisTickFormatter={yAxisTickFormatter}
			tooltipFormatter={tooltipFormatter}
			tooltipLabelFormatter={tooltipLabelFormatter}
			tooltipStyle={tooltipStyle}
			showLegend={showLegend}
			legendHeight={legendHeight}
			margin={margin}
			className={className}
			error={error}
			emptyState={emptyState}
			onChartClick={onChartClick}
		>
			{lineConfigs.map((lineConfig) => (
				<Line
					key={lineConfig.dataKey}
					type="monotone"
					dataKey={lineConfig.dataKey}
					stroke={lineConfig.stroke || colors.primary}
					strokeWidth={lineConfig.strokeWidth || 2}
					dot={lineConfig.dot ?? false}
					name={lineConfig.name || lineConfig.dataKey}
					animationDuration={animationDuration}
				/>
			))}
			{referenceLines.map((refLine) => (
				<ReferenceLine
					key={`ref-line-${refLine.y}`}
					y={refLine.y}
					stroke={refLine.stroke || colors.primary}
					strokeDasharray={refLine.strokeDasharray || "3 3"}
					label={refLine.label}
				/>
			))}
		</BaseXYChartFrame>
	);
}
