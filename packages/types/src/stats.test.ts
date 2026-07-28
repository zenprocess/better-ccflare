import { describe, expect, it } from "bun:test";
import {
	isAnalyticsMode,
	isAnalyticsStatusFilter,
	isTimeRange,
	TIME_RANGES,
} from "./stats";
import { isLbStrategy, LB_STRATEGIES } from "./strategy";

describe("stats type guards", () => {
	it("exports the supported strategy and analytics discriminators", () => {
		expect(LB_STRATEGIES).toEqual(["session"]);
		expect(TIME_RANGES).toEqual(["1h", "6h", "24h", "7d", "30d"]);
		expect(isLbStrategy("session")).toBe(true);
		expect(isLbStrategy("round_robin")).toBe(false);
		expect(isTimeRange("24h")).toBe(true);
		expect(isTimeRange("12h")).toBe(false);
		expect(isAnalyticsMode("normal")).toBe(true);
		expect(isAnalyticsMode("cumulative")).toBe(true);
		expect(isAnalyticsMode("delta")).toBe(false);
		expect(isAnalyticsStatusFilter("all")).toBe(true);
		expect(isAnalyticsStatusFilter("success")).toBe(true);
		expect(isAnalyticsStatusFilter("error")).toBe(true);
		expect(isAnalyticsStatusFilter("pending")).toBe(false);
	});
});
