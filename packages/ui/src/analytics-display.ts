import type { TimeRange } from "@ccflare/types";
import { TIME_RANGES } from "./constants";

export type SuccessRateTone = "good" | "warning" | "bad";

export function getSuccessRateTone(successRate: number): SuccessRateTone {
	if (successRate >= 95) {
		return "good";
	}

	if (successRate >= 80) {
		return "warning";
	}

	return "bad";
}

export function getSuccessRateTermColor(
	successRate: number,
): "green" | "yellow" | "red" {
	switch (getSuccessRateTone(successRate)) {
		case "good":
			return "green";
		case "warning":
			return "yellow";
		default:
			return "red";
	}
}

export function getSuccessRateTextClass(successRate: number): string {
	switch (getSuccessRateTone(successRate)) {
		case "good":
			return "text-success";
		case "warning":
			return "text-warning";
		default:
			return "text-destructive";
	}
}

export function getTimeRangeLabel(range: TimeRange): string {
	return TIME_RANGES[range];
}

export const TIME_RANGE_OPTIONS = (
	Object.entries(TIME_RANGES) as Array<[TimeRange, string]>
).map(([value, label]) => ({
	value,
	label,
}));
