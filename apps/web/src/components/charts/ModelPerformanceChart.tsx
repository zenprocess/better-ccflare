import { formatPercentage } from "@ccflare/ui";
import { useChartColors } from "../../hooks/useChartColors";
import { formatCompactNumber } from "../../lib/chart-utils";
import { BaseScatterChart } from "./BaseScatterChart";

interface ModelPerformanceChartProps {
	data: Array<{
		model: string;
		avgTime: number;
		errorRate: number;
		[key: string]: string | number;
	}>;
	loading?: boolean;
	height?: number;
}

export function ModelPerformanceChart({
	data,
	loading = false,
	height = 300,
}: ModelPerformanceChartProps) {
	const colors = useChartColors();
	return (
		<BaseScatterChart
			data={data}
			xKey="avgTime"
			yKey="errorRate"
			loading={loading}
			height={height}
			fill={colors.primary}
			xAxisLabel="Avg Response Time (ms)"
			xAxisTickFormatter={formatCompactNumber}
			yAxisLabel="Error Rate %"
			tooltipFormatter={(value, name) => {
				if (name === "avgTime") return [`${value}ms`, "Avg Time"];
				if (name === "errorRate")
					return [formatPercentage(Number(value)), "Error Rate"];
				return [`${value}`, name || ""];
			}}
			tooltipStyle={{
				backgroundColor: colors.success,
				border: `1px solid ${colors.success}`,
				borderRadius: "var(--radius)",
				color: "#fff",
			}}
			renderLabel={(entry) => entry.model}
		/>
	);
}
