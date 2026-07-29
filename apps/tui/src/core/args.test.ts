import { describe, expect, it } from "bun:test";
import { parseArgs } from "./args";

describe("parseArgs", () => {
	it("parses all supported --provider values for add-account", () => {
		for (const provider of [
			"anthropic",
			"openai",
			"claude-code",
			"codex",
		] as const) {
			expect(
				parseArgs(["--add-account", "work", "--provider", provider]),
			).toMatchObject({
				addAccount: "work",
				provider,
			});
		}
	});

	it("rejects an unsupported --provider value", () => {
		expect(() =>
			parseArgs(["--add-account", "work", "--provider", "gemini"]),
		).toThrow("Invalid provider");
	});

	it("rejects unsupported flags", () => {
		expect(() =>
			parseArgs([
				"--add-account",
				"work",
				"--provider",
				"anthropic",
				"--legacy-flag",
				"value",
			]),
		).toThrow();
	});

	it("rejects removed get-model flag", () => {
		expect(() => parseArgs(["--get-model"])).toThrow();
	});

	it("rejects removed set-model flag", () => {
		expect(() =>
			parseArgs(["--set-model", "claude-sonnet-4-20250514"]),
		).toThrow();
	});
});
