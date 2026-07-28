import { C } from "../../theme.ts";
import { formatAxisValue, getSparkChar, normalizeData } from "./utils.ts";

export interface LineChartData {
	x: string;
	y: number;
}

interface LineChartProps {
	data: LineChartData[];
	height?: number;
	width?: number;
	title?: string;
	color?: string;
	showAxes?: boolean;
}

export function LineChart({
	data,
	height = 10,
	width = 40,
	title,
	color = C.chart2,
	showAxes = true,
}: LineChartProps) {
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

	const values = data.map((d) => d.y);
	const { normalized, max, min } = normalizeData(values, height - 1);

	// Create the chart grid
	const chart: string[][] = Array(height)
		.fill(null)
		.map(() => Array(width).fill(" "));

	// Plot the points
	const xStep = Math.max(1, Math.floor(data.length / width));
	for (let i = 0; i < width && i * xStep < data.length; i++) {
		const dataIndex = i * xStep;
		const value = normalized[dataIndex];
		const y = height - 1 - Math.round(value);

		if (y >= 0 && y < height) {
			const char = getSparkChar(values[dataIndex], min, max);
			chart[y][i] = char;
		}
	}
	const rowKeyCounts = new Map<string, number>();
	const keyedRows = chart.map((row) => {
		const baseKey = row.join("");
		const count = (rowKeyCounts.get(baseKey) ?? 0) + 1;
		rowKeyCounts.set(baseKey, count);
		return {
			key: count === 1 ? baseKey : `${baseKey}-${count}`,
			row,
		};
	});

	return (
		<box flexDirection="column">
			{title && (
				<box marginBottom={1}>
					<text fg={C.text}>
						<strong>{title}</strong>
					</text>
				</box>
			)}

			{showAxes && (
				<box>
					<text fg={C.muted}>{formatAxisValue(max).padStart(6)} ┤</text>
				</box>
			)}

			{keyedRows.map(({ key, row }, y) => (
				<box key={key}>
					{showAxes && y === Math.floor(height / 2) && (
						<text fg={C.muted}>
							{formatAxisValue((max + min) / 2).padStart(6)}{" "}
						</text>
					)}
					{showAxes && y !== Math.floor(height / 2) && (
						<text>{" ".repeat(6)} </text>
					)}
					{showAxes && <text fg={C.muted}>│</text>}
					<text fg={color}>{row.join("")}</text>
				</box>
			))}

			{showAxes && (
				<>
					<box>
						<text fg={C.muted}>
							{formatAxisValue(min).padStart(6)} └{"─".repeat(width)}
						</text>
					</box>
					<box marginLeft={8}>
						<text fg={C.muted}>
							{data[0].x}
							{" ".repeat(
								Math.max(
									0,
									width - data[0].x.length - data[data.length - 1].x.length,
								),
							)}
							{data[data.length - 1].x}
						</text>
					</box>
				</>
			)}
		</box>
	);
}
