import { C } from "../../theme.ts";
import { createBar, formatAxisValue } from "./utils.ts";

export interface BarChartData {
	label: string;
	value: number;
	color?: string;
}

interface BarChartProps {
	data: BarChartData[];
	width?: number;
	showValues?: boolean;
	title?: string;
}

export function BarChart({
	data,
	width = 30,
	showValues = true,
	title,
}: BarChartProps) {
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

	const maxValue = Math.max(...data.map((d) => d.value));
	const maxLabelLen = Math.max(...data.map((d) => d.label.length));

	return (
		<box flexDirection="column">
			{title && (
				<box marginBottom={1}>
					<text fg={C.text}>
						<strong>{title}</strong>
					</text>
				</box>
			)}
			{data.map((item) => {
				const bar = createBar(item.value, maxValue, width, false);
				const color = item.color || C.chart1;
				return (
					<box key={`${item.label}-${item.value}`} flexDirection="row">
						<text fg={C.dim}>{item.label.padEnd(maxLabelLen + 1)}</text>
						<text fg={color}>{bar}</text>
						{showValues && (
							<text fg={C.muted}> {formatAxisValue(item.value)}</text>
						)}
					</box>
				);
			})}
		</box>
	);
}
