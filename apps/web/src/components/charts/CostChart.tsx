import { formatCost } from "@ccflare/core";
import { formatCompactCurrency } from "../../lib/chart-utils";
import { AnalyticsAreaChart } from "./AnalyticsAreaChart";

interface CostChartProps {
	data: Array<{
		time: string;
		cost: number;
		[key: string]: string | number;
	}>;
	loading?: boolean;
	height?: number;
	viewMode?: "normal" | "cumulative";
	timeRange?: string;
}

export function CostChart({
	data,
	loading = false,
	height = 400,
	viewMode = "normal",
	timeRange = "24h",
}: CostChartProps) {
	return (
		<AnalyticsAreaChart
			data={data}
			dataKey="cost"
			loading={loading}
			height={height}
			viewMode={viewMode}
			timeRange={timeRange}
			colorCumulative="var(--warning)"
			gradientId="colorCost"
			customGradient={(color) => (
				<linearGradient id="colorCost" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stopColor={color} stopOpacity={0.9} />
					<stop offset="100%" stopColor={color} stopOpacity={0.1} />
				</linearGradient>
			)}
			yAxisTickFormatter={formatCompactCurrency}
			tooltipFormatter={(value) => [formatCost(Number(value)), "Cost"]}
		/>
	);
}
