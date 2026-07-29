import { formatTokens } from "@ccflare/ui";
import { formatCompactNumber } from "../../lib/chart-utils";
import { AnalyticsAreaChart } from "./AnalyticsAreaChart";

interface TokenUsageChartProps {
	data: Array<{
		time: string;
		tokens: number;
		[key: string]: string | number;
	}>;
	loading?: boolean;
	height?: number;
	viewMode?: "normal" | "cumulative";
	timeRange?: string;
}

export function TokenUsageChart({
	data,
	loading = false,
	height = 400,
	viewMode = "normal",
	timeRange = "24h",
}: TokenUsageChartProps) {
	return (
		<AnalyticsAreaChart
			data={data}
			dataKey="tokens"
			loading={loading}
			height={height}
			viewMode={viewMode}
			timeRange={timeRange}
			colorCumulative="var(--info)"
			gradientId="colorTokens"
			customGradient={(color) => (
				<linearGradient id="colorTokens" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stopColor={color} stopOpacity={0.9} />
					<stop offset="100%" stopColor={color} stopOpacity={0.1} />
				</linearGradient>
			)}
			yAxisTickFormatter={formatCompactNumber}
			tooltipFormatter={(value) => [formatTokens(value as number), "Tokens"]}
		/>
	);
}
