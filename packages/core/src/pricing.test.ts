import { afterEach, describe, expect, it } from "bun:test";
import { estimateCostUSD } from "./pricing";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("estimateCostUSD", () => {
	it("applies cache_read pricing for cached OpenAI input tokens", async () => {
		globalThis.fetch = Object.assign(
			async () =>
				new Response(
					JSON.stringify({
						openai: {
							models: {
								"gpt-4o": {
									id: "gpt-4o",
									name: "GPT-4o",
									cost: {
										input: 2.5,
										output: 10,
										cache_read: 1.25,
									},
								},
							},
						},
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		await expect(
			estimateCostUSD("gpt-4o", {
				inputTokens: 127,
				cacheReadInputTokens: 18_688,
				outputTokens: 431,
			}),
		).resolves.toBeCloseTo(
			(127 * 2.5 + 18_688 * 1.25 + 431 * 10) / 1_000_000,
			10,
		);
	});
});
