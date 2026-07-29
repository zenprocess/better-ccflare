import { AnalyticsAreaChart } from "./AnalyticsAreaChart";

interface ResponseTimeChartProps {
	data: Array<{
		time: string;
		responseTime: number;
		[key: string]: string | number;
	}>;
	loading?: boolean;
	height?: number;
	viewMode?: "normal" | "cumulative";
	timeRange?: string;
}

export function ResponseTimeChart({
	data,
	loading = false,
	height = 400,
	viewMode = "normal",
	timeRange = "24h",
}: ResponseTimeChartProps) {
	return (
		<AnalyticsAreaChart
			data={data}
			dataKey="responseTime"
			loading={loading}
			height={height}
			viewMode={viewMode}
			timeRange={timeRange}
			colorCumulative="var(--chart-3)"
			tooltipFormatter={(value) => [`${value}ms`, "Response Time"]}
		/>
	);
}
