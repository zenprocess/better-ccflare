import { describe, expect, it } from "bun:test";
import { processTokenUsage } from "./TokenUsageDisplay";

describe("processTokenUsage", () => {
	it("treats cached-only usage as displayable data", () => {
		const usage = processTokenUsage({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 18_688,
			totalTokens: 18_688,
		});

		expect(usage.hasData).toBe(true);
		expect(usage.sections.cacheReadTokens).toMatchObject({
			label: "Cache Read Tokens",
		});
	});

	it("includes reasoning tokens when present", () => {
		const usage = processTokenUsage({
			inputTokens: 127,
			outputTokens: 431,
			reasoningTokens: 321,
			totalTokens: 19_246,
		});

		expect(usage.sections.reasoningTokens).toMatchObject({
			label: "Reasoning Tokens",
		});
	});
});
