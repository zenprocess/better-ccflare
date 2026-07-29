import { C } from "../../theme.ts";
import { formatAxisValue } from "./utils.ts";

export interface PieChartData {
	label: string;
	value: number;
	color?: string;
}

interface PieChartProps {
	data: PieChartData[];
	title?: string;
	showLegend?: boolean;
}

const CHART_COLORS = [C.chart1, C.chart2, C.chart3, C.chart4, C.chart5];

export function PieChart({ data, title, showLegend = true }: PieChartProps) {
	if (data.length === 0) {
		return (
			<box flexDirection="column">
				{title && (
					<text fg={C.text}>
						<strong>{title}</strong>
					</text>
				)}
				<text fg={C.muted}>No data available</text>
			</box>
		);
	}

	const total = data.reduce((sum, item) => sum + item.value, 0);
	const items = data
		.map((item, i) => ({
			...item,
			color: item.color || CHART_COLORS[i % CHART_COLORS.length],
			percentage: total > 0 ? (item.value / total) * 100 : 0,
		}))
		.sort((a, b) => b.percentage - a.percentage);

	// Render as horizontal bar segments
	const barWidth = 30;

	return (
		<box flexDirection="column">
			{title && (
				<box marginBottom={1}>
					<text fg={C.text}>
						<strong>{title}</strong>
					</text>
				</box>
			)}

			{/* Horizontal stacked bar */}
			<box flexDirection="row">
				{items.map((item) => {
					const segWidth = Math.max(
						1,
						Math.round((item.percentage / 100) * barWidth),
					);
					return (
						<text key={item.label} fg={item.color}>
							{"█".repeat(segWidth)}
						</text>
					);
				})}
			</box>

			{/* Legend */}
			{showLegend && (
				<box flexDirection="column" marginTop={1}>
					{items.map((item) => (
						<box key={item.label} flexDirection="row" gap={1}>
							<text fg={item.color}>●</text>
							<text fg={C.dim}>{item.label}:</text>
							<text fg={C.text}>
								<strong>{Math.round(item.percentage)}%</strong>
							</text>
							<text fg={C.muted}>({formatAxisValue(item.value)})</text>
						</box>
					))}
					<box marginTop={1}>
						<text fg={C.muted}>Total: {formatAxisValue(total)}</text>
					</box>
				</box>
			)}
		</box>
	);
}
