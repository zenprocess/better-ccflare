import { formatTokensPerSecond } from "@ccflare/ui";
import { useChartColors } from "../../hooks/useChartColors";
import { formatCompactNumber } from "../../lib/chart-utils";
import { BaseAreaChart } from "./BaseAreaChart";

interface TokenSpeedChartProps {
	data: Array<{
		time: string;
		avgTokensPerSecond: number;
		[key: string]: string | number;
	}>;
	loading?: boolean;
	height?: number;
	timeRange?: string;
}

export function TokenSpeedChart({
	data,
	loading = false,
	height = 400,
	timeRange = "24h",
}: TokenSpeedChartProps) {
	const colors = useChartColors();
	const isLongRange = timeRange === "7d" || timeRange === "30d";

	// Filter out null values for better chart display
	const filteredData = data.map((point) => ({
		...point,
		avgTokensPerSecond: point.avgTokensPerSecond || 0,
	}));

	const gradient = (
		<linearGradient id="colorSpeed" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0%" stopColor={colors.chart3} stopOpacity={0.9} />
			<stop offset="100%" stopColor={colors.chart3} stopOpacity={0.1} />
		</linearGradient>
	);

	return (
		<BaseAreaChart
			data={filteredData}
			dataKey="avgTokensPerSecond"
			loading={loading}
			height={height}
			color={colors.chart3}
			gradientId="colorSpeed"
			customGradient={gradient}
			strokeWidth={2}
			xAxisAngle={isLongRange ? -45 : 0}
			xAxisTextAnchor={isLongRange ? "end" : "middle"}
			xAxisHeight={isLongRange ? 60 : 30}
			yAxisTickFormatter={formatCompactNumber}
			tooltipFormatter={(value) => [
				formatTokensPerSecond(value as number),
				"Output Speed",
			]}
			animationDuration={1000}
		/>
	);
}
