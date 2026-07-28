import { describe, expect, it } from "bun:test";
import {
	extractTrackedModelFromRequestBody,
	normalizeTrackedModel,
	stripCompatibilityModelPrefix,
} from "./model-id";

describe("compat model id helpers", () => {
	it("strips compatibility family prefixes when present", () => {
		expect(stripCompatibilityModelPrefix("openai/gpt-5.4")).toEqual({
			family: "openai",
			model: "gpt-5.4",
		});
		expect(stripCompatibilityModelPrefix("anthropic/claude-sonnet-4")).toEqual({
			family: "anthropic",
			model: "claude-sonnet-4",
		});
	});

	it("normalizes tracked models without changing non-compat ids", () => {
		expect(normalizeTrackedModel(" openai/gpt-4o-mini ")).toBe("gpt-4o-mini");
		expect(normalizeTrackedModel("gpt-4o-mini")).toBe("gpt-4o-mini");
		expect(normalizeTrackedModel("")).toBeUndefined();
	});

	it("extracts a normalized model from encoded request bodies", () => {
		const encoded = Buffer.from(
			JSON.stringify({ model: "anthropic/claude-opus-4.1" }),
		).toString("base64");

		expect(extractTrackedModelFromRequestBody(encoded)).toBe("claude-opus-4.1");
	});
});
