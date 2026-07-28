import type { ReactNode } from "react";
import { useChartColors } from "../../hooks/useChartColors";
import { BaseAreaChart } from "./BaseAreaChart";

type AnalyticsAreaChartProps = {
	data: Array<Record<string, string | number>>;
	dataKey: string;
	loading?: boolean;
	height?: number;
	viewMode?: "normal" | "cumulative";
	timeRange?: string;
	colorNormal?: string;
	colorCumulative?: string;
	gradientId?: string;
	customGradient?: (color: string) => ReactNode;
	yAxisTickFormatter?: (value: number | string) => string;
	tooltipFormatter: (value: number | string) => [string, string];
	tooltipLabelPrefix?: string;
};

export function AnalyticsAreaChart({
	data,
	dataKey,
	loading = false,
	height = 400,
	viewMode = "normal",
	timeRange = "24h",
	colorNormal,
	colorCumulative,
	gradientId,
	customGradient,
	yAxisTickFormatter,
	tooltipFormatter,
	tooltipLabelPrefix = "Cumulative at",
}: AnalyticsAreaChartProps) {
	const colors = useChartColors();
	const isLongRange = timeRange === "7d" || timeRange === "30d";
	const effectiveColor =
		viewMode === "cumulative"
			? (colorCumulative ?? colors.primary)
			: (colorNormal ?? colors.primary);

	return (
		<BaseAreaChart
			data={data}
			dataKey={dataKey}
			loading={loading}
			height={height}
			color={effectiveColor}
			gradientId={gradientId}
			customGradient={customGradient?.(effectiveColor)}
			strokeWidth={viewMode === "cumulative" ? 3 : 2}
			xAxisAngle={isLongRange ? -45 : 0}
			xAxisTextAnchor={isLongRange ? "end" : "middle"}
			xAxisHeight={isLongRange ? 60 : 30}
			yAxisTickFormatter={yAxisTickFormatter}
			tooltipFormatter={tooltipFormatter}
			tooltipLabelFormatter={(label) =>
				viewMode === "cumulative" ? `${tooltipLabelPrefix} ${label}` : label
			}
			animationDuration={1000}
		/>
	);
}
