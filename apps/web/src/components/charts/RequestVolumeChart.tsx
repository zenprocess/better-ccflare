import { formatNumber } from "@ccflare/ui";
import { formatCompactNumber } from "../../lib/chart-utils";
import { AnalyticsAreaChart } from "./AnalyticsAreaChart";

interface RequestVolumeChartProps {
	data: Array<{
		time: string;
		requests: number;
		[key: string]: string | number;
	}>;
	loading?: boolean;
	height?: number;
	viewMode?: "normal" | "cumulative";
	timeRange?: string;
}

export function RequestVolumeChart({
	data,
	loading = false,
	height = 400,
	viewMode = "normal",
	timeRange = "24h",
}: RequestVolumeChartProps) {
	return (
		<AnalyticsAreaChart
			data={data}
			dataKey="requests"
			loading={loading}
			height={height}
			viewMode={viewMode}
			timeRange={timeRange}
			colorCumulative="var(--chart-3)"
			gradientId="colorRequests"
			customGradient={(color) => (
				<linearGradient id="colorRequests" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stopColor={color} stopOpacity={0.9} />
					<stop offset="50%" stopColor="var(--primary)" stopOpacity={0.7} />
					<stop offset="100%" stopColor="var(--info)" stopOpacity={0.3} />
				</linearGradient>
			)}
			yAxisTickFormatter={formatCompactNumber}
			tooltipFormatter={(value) => [formatNumber(value as number), "Requests"]}
		/>
	);
}
