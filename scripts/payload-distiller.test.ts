/**
 * FIRST tests for payload-distiller. Runner is bun:test — invoke as
 *   bun test scripts/payload-distiller.test.ts
 * (no package.json test alias for scripts/; a 0-run grep will be rejected).
 *
 * Token hygiene: tests use the literal fake value "test-token-not-real" for
 * the ENGRAM_API_TOKEN env var and a guaranteed-empty PATH for the spawn
 * fallback path. The real `cal-infisical` binary never executes in this
 * suite — the spawn-failing test stubs PATH so `Bun.spawnSync` cannot
 * resolve the binary on a developer's machine either.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getEngramToken,
	jsonColumnExpression,
	parseArgs,
	postRollupAndMark,
	scrubSecrets,
	type Args,
} from "./payload-distiller";

// shared fixtures
const EMPTY_PATH_DIR = mkdtempSync(join(tmpdir(), "distiller-empty-path-"));
afterAll(() => {
	rmSync(EMPTY_PATH_DIR, { force: true, recursive: true });
});

function makeArgs(overrides: Partial<Args> = {}): Args {
	return {
		dryRun: false,
		limit: 100,
		scope: "_distill_test",
		source: "ccflare",
		dbUrl: "postgres://test/db",
		engramUrl: "https://engram.test",
		godkbUrl: "https://godkb.test",
		godkb: true,
		verbose: false,
		onlyFailed: false,
		rollupOnly: false,
		...overrides,
	};
}

const ROLLUP = {
	model: "claude-3-5-sonnet",
	account: "acct-1",
	day: "2026-08-04",
	requests: 3,
	failures: 0,
	costUsd: 0.0123,
	totalTokens: 1234,
};

describe("payload-distiller.parseArgs", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		// parseArgs reads these at call time; reset before each test for isolation.
		process.env.DATABASE_URL = "postgres://test/db";
		delete process.env.ENGRAM_URL;
		delete process.env.GODKB_URL;
	});

	afterEach(() => {
		// Restore env: delete keys the test added, restore keys the test removed.
		for (const k of Object.keys(process.env)) {
			if (!(k in originalEnv)) delete process.env[k];
		}
		for (const [k, v] of Object.entries(originalEnv)) {
			process.env[k] = v;
		}
	});

	it("defaults rollupOnly to false", () => {
		expect(parseArgs([]).rollupOnly).toBe(false);
	});

	it("--rollup-only sets rollupOnly to true", () => {
		expect(parseArgs(["--rollup-only"]).rollupOnly).toBe(true);
	});

	it("--only-failed sets onlyFailed to true", () => {
		expect(parseArgs(["--only-failed"]).onlyFailed).toBe(true);
	});

	it("--dry-run sets dryRun to true", () => {
		expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
	});

	it("--rollup-only + --only-failed + --dry-run all combine concurrently", () => {
		const a = parseArgs(["--rollup-only", "--only-failed", "--dry-run"]);
		expect(a.rollupOnly).toBe(true);
		expect(a.onlyFailed).toBe(true);
		expect(a.dryRun).toBe(true);
	});

	it("throws when DATABASE_URL is absent and --db-url not given", () => {
		delete process.env.DATABASE_URL;
		expect(() => parseArgs([])).toThrow(/DATABASE_URL/);
	});

	it("--db-url overrides a missing DATABASE_URL", () => {
		delete process.env.DATABASE_URL;
		const a = parseArgs(["--db-url", "postgres://override/db"]);
		expect(a.dbUrl).toBe("postgres://override/db");
	});

	it("rejects unknown args", () => {
		expect(() => parseArgs(["--made-up"])).toThrow(/unknown arg/);
	});

	it("rejects --scope with disallowed characters", () => {
		expect(() => parseArgs(["--scope", "bad;inject"])).toThrow(/invalid --scope/);
	});
});

describe("payload-distiller.jsonColumnExpression (query shape, OOM guard)", () => {
	it("rollup mode selects the '{}' literal so the body column is never loaded", () => {
		expect(jsonColumnExpression(true)).toBe("'{}'::text AS json");
	});

	it("normal mode selects the real rp.json column", () => {
		expect(jsonColumnExpression(false)).toBe("rp.json");
	});
});

describe("payload-distiller.postRollupAndMark (marking order, fail-closed)", () => {
	it("rollup-only: a failed POST leaves ALL rows unmarked", async () => {
		const markedIds: string[] = [];
		let postCalls = 0;

		const result = await postRollupAndMark(
			ROLLUP,
			["row-a", "row-b", "row-c"],
			makeArgs({ rollupOnly: true }),
			"20260804120000",
			async () => {
				postCalls++;
				return false; // simulate transport failure
			},
			async (id) => {
				markedIds.push(id);
			},
		);

		// POST was attempted exactly once
		expect(postCalls).toBe(1);
		// CRITICAL: no rows reached the sidecar mark
		expect(markedIds).toEqual([]);
		// Counters reflect the fail-closed outcome
		expect(result.distilled).toBe(0);
		expect(result.skipped).toBe(3);
	});

	it("rollup-only: a successful POST marks every row in order", async () => {
		const markedIds: string[] = [];
		let postCalls = 0;

		const result = await postRollupAndMark(
			ROLLUP,
			["row-a", "row-b", "row-c"],
			makeArgs({ rollupOnly: true }),
			"20260804120000",
			async () => {
				postCalls++;
				return true;
			},
			async (id) => {
				markedIds.push(id);
			},
		);

		expect(postCalls).toBe(1);
		// Marks happen in the order the ids were given
		expect(markedIds).toEqual(["row-a", "row-b", "row-c"]);
		expect(result.distilled).toBe(3);
		expect(result.skipped).toBe(0);
	});

	it("rollup-only: marking happens AFTER POST resolves (ordering guarantee)", async () => {
		const events: string[] = [];

		await postRollupAndMark(
			ROLLUP,
			["row-a"],
			makeArgs({ rollupOnly: true }),
			"20260804120000",
			async () => {
				events.push("post:start");
				// simulate a microtask boundary to make ordering observable
				await Promise.resolve();
				events.push("post:end");
				return true;
			},
			async (id) => {
				events.push(`mark:${id}`);
			},
		);

		expect(events).toEqual([
			"post:start",
			"post:end",
			"mark:row-a", // mark MUST come after post:end
		]);
	});

	it("dry-run: postFn is NOT called and markFn is NOT called; counts ids as would-mark", async () => {
		const markedIds: string[] = [];
		let postCalls = 0;

		const result = await postRollupAndMark(
			ROLLUP,
			["row-a", "row-b"],
			makeArgs({ dryRun: true, rollupOnly: true }),
			"20260804120000",
			async () => {
				postCalls++;
				return true;
			},
			async (id) => {
				markedIds.push(id);
			},
		);

		expect(postCalls).toBe(0);
		expect(markedIds).toEqual([]);
		expect(result.distilled).toBe(2);
		expect(result.skipped).toBe(0);
	});

	it("non-rollup-only: POST is emitted but rows are NOT marked", async () => {
		const markedIds: string[] = [];
		let postCalls = 0;

		const result = await postRollupAndMark(
			ROLLUP,
			["row-a", "row-b"],
			makeArgs({ rollupOnly: false }),
			"20260804120000",
			async () => {
				postCalls++;
				return true; // even on success
			},
			async (id) => {
				markedIds.push(id);
			},
		);

		expect(postCalls).toBe(1);
		expect(markedIds).toEqual([]);
		expect(result.distilled).toBe(0);
		expect(result.skipped).toBe(0);
	});

	it("markFn throw propagates so the caller can abort the run (fail-closed)", async () => {
		let marksAttempted = 0;

		await expect(
			postRollupAndMark(
				ROLLUP,
				["row-a", "row-b"],
				makeArgs({ rollupOnly: true }),
				"20260804120000",
				async () => true,
				async () => {
					marksAttempted++;
					throw new Error("INSERT failed (simulated)");
				},
			),
		).rejects.toThrow("INSERT failed");

		// First mark failure aborts; second is never attempted
		expect(marksAttempted).toBe(1);
	});
});

describe("payload-distiller.getEngramToken", () => {
	const originalEnv = { ...process.env };
	const originalPath = process.env.PATH;

	afterEach(() => {
		// Restore env to its pre-test state.
		for (const k of Object.keys(process.env)) {
			if (!(k in originalEnv)) delete process.env[k];
		}
		for (const [k, v] of Object.entries(originalEnv)) {
			process.env[k] = v;
		}
		if (originalPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = originalPath;
		}
	});

	it("env var wins (no spawn invoked, literal fake value)", () => {
		// The brief binds this literal fake value — never read a real token.
		process.env.ENGRAM_API_TOKEN = "test-token-not-real";
		// Even if cal-infisical were on PATH, this would be the answer.
		process.env.PATH = EMPTY_PATH_DIR;
		expect(getEngramToken()).toBe("test-token-not-real");
	});

	it("throws cleanly when neither env nor spawn is available", () => {
		delete process.env.ENGRAM_API_TOKEN;
		// PATH points to a guaranteed-empty dir so the spawn cannot find
		// cal-infisical — the real binary never executes in this test.
		process.env.PATH = EMPTY_PATH_DIR;
		expect(() => getEngramToken()).toThrow(/engram token unavailable/);
	});
});

describe("payload-distiller.scrubSecrets (Bearer redaction)", () => {
	it("redacts a Bearer token in an Authorization header", () => {
		// The Bearer regex and the Authorization regex overlap. Either
		// redacting the token value OR redacting the entire
		// "Authorization: <token>" pair satisfies the security property.
		// The token VALUE must never survive in the output.
		const token = "Bearer abc123def456ghij789klmnop"; // 27 chars, > 16
		const out = scrubSecrets(`Authorization: ${token}`);
		expect(out).not.toContain("abc123def456ghij789klmnop");
		expect(out).toContain("[REDACTED]");
	});

	it("redacts an embedded Bearer token in extracted payload text", () => {
		// The kind of string that ends up in payload-derived observation bodies.
		const payload =
			"prompt: send request with Authorization: Bearer xyzABCdefGHIjklMNOpqr and finish";
		const out = scrubSecrets(payload);
		expect(out).not.toContain("xyzABCdefGHIjklMNOpqr");
		expect(out).toContain("[REDACTED]");
	});

	it("leaves short tokens alone (does not over-match)", () => {
		// 3-char payload after Bearer is below the 16+ length threshold.
		expect(scrubSecrets("Bearer abc")).toBe("Bearer abc");
	});
});
