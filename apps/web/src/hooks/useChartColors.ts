import { useMemo } from "react";
import { useTheme } from "../contexts/theme-context";

export interface ChartColors {
	primary: string;
	success: string;
	warning: string;
	error: string;
	info: string;
	chart1: string;
	chart2: string;
	chart3: string;
	chart4: string;
	chart5: string;
}

export function useChartColors(): ChartColors {
	const { resolvedTheme } = useTheme();
	return useMemo(
		() => ({
			primary: resolvedTheme.chart1,
			success: resolvedTheme.success,
			warning: resolvedTheme.warning,
			error: resolvedTheme.error,
			info: resolvedTheme.info,
			chart1: resolvedTheme.chart1,
			chart2: resolvedTheme.chart2,
			chart3: resolvedTheme.chart3,
			chart4: resolvedTheme.chart4,
			chart5: resolvedTheme.chart5,
		}),
		[resolvedTheme],
	);
}

export function useChartColorSequence(): readonly string[] {
	const { resolvedTheme } = useTheme();
	return useMemo(
		() => [
			resolvedTheme.chart1,
			resolvedTheme.chart2,
			resolvedTheme.chart3,
			resolvedTheme.chart4,
			resolvedTheme.chart5,
		],
		[resolvedTheme],
	);
}
