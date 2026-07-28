import type { ReactNode } from "react";
import { Area, AreaChart } from "recharts";
import { useChartColors } from "../../hooks/useChartColors";
import { BaseXYChartFrame } from "./BaseXYChartFrame";
import type { CommonChartProps } from "./chart-utils";

interface BaseAreaChartProps extends CommonChartProps {
	dataKey: string;
	color?: string;
	gradientId?: string;
	customGradient?: ReactNode;
	strokeWidth?: number;
	fillOpacity?: number;
}

export function BaseAreaChart({
	data,
	dataKey,
	xAxisKey = "time",
	loading = false,
	height = "medium",
	color,
	gradientId = "colorGradient",
	customGradient,
	strokeWidth = 2,
	fillOpacity = 1,
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
	margin,
	className = "",
	error = null,
	emptyState,
	onChartClick,
}: BaseAreaChartProps) {
	const colors = useChartColors();
	const effectiveColor = color ?? colors.primary;

	const defaultGradient = (
		<linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
			<stop offset="5%" stopColor={effectiveColor} stopOpacity={0.8} />
			<stop offset="95%" stopColor={effectiveColor} stopOpacity={0.1} />
		</linearGradient>
	);

	return (
		<BaseXYChartFrame
			chartComponent={AreaChart}
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
			defs={customGradient || defaultGradient}
		>
			<Area
				type="monotone"
				dataKey={dataKey}
				stroke={effectiveColor}
				strokeWidth={strokeWidth}
				fillOpacity={fillOpacity}
				fill={`url(#${gradientId})`}
				animationDuration={animationDuration}
			/>
		</BaseXYChartFrame>
	);
}
