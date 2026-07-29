import { C } from "../../theme.ts";
import { createSparkline, formatAxisValue } from "./utils.ts";

interface SparklineChartProps {
	data: number[];
	label?: string;
	color?: string;
	showMinMax?: boolean;
	showCurrent?: boolean;
}

export function SparklineChart({
	data,
	label,
	color = C.chart1,
	showMinMax = true,
	showCurrent = true,
}: SparklineChartProps) {
	if (data.length === 0) {
		return <text fg={C.muted}>No data</text>;
	}

	const sparkline = createSparkline(data);
	const min = Math.min(...data);
	const max = Math.max(...data);
	const current = data[data.length - 1];

	return (
		<box flexDirection="row" gap={1}>
			{label && <text fg={C.dim}>{label}:</text>}
			<text fg={color}>{sparkline}</text>
			{showMinMax && (
				<text fg={C.muted}>
					[{formatAxisValue(min)}→{formatAxisValue(max)}]
				</text>
			)}
			{showCurrent && (
				<text fg={color}>
					<strong>{formatAxisValue(current)}</strong>
				</text>
			)}
		</box>
	);
}
