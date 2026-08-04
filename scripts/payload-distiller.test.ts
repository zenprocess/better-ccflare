/**
 * FIRST tests for payload-distiller. Runner is bun:test — invoke as
 *   bun test scripts/payload-distiller.test.ts
 * (no package.json test alias for scripts/; a 0-run grep will be rejected).
 *
 * Token hygiene: the `getEngramToken` spawn-fallback test is HERMETIC. The
 * test injects a fake spawn function so the real `cal-infisical` binary
 * cannot execute via any path-resolution trick (PATH scrubbing is
 * insufficient — the binary can live at an absolute path on a developer
 * machine). Assertions verify the injected spawn WAS called (or WAS NOT
 * called, in the env-wins case) so a regression to a direct `Bun.spawnSync`
 * call fails loudly. Tests use the literal fake value "test-token-not-real"
 * for the env-stub path; a real token never reaches the test stdout.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	getEngramToken,
	jsonColumnExpression,
	parseArgs,
	postRollupAndMark,
	scrubSecrets,
	type Args,
} from "./payload-distiller";

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
	// Hermeticity contract: these tests MUST inject a fake spawn fn so the
	// real `cal-infisical` binary cannot execute via any path-resolution
	// trick (PATH scrubbing is insufficient — the binary can live at an
	// absolute path on a developer machine). The assertions verify that
	// the injected spawn was called (or NOT called, in the env-wins case)
	// so a regression to a direct `Bun.spawnSync` call fails loudly.

	function failingSpawn(_cmd: string[]): { exitCode: number; stdout: string | null } {
		return { exitCode: 1, stdout: "" };
	}

	function successSpawn(_cmd: string[]): { exitCode: number; stdout: string | null } {
		// This deliberately contains a recognizable marker so a regression
		// that returns its value instead of the env token is grep-able.
		return { exitCode: 0, stdout: "REAL_TOKEN_FROM_SPAWN_SHOULD_NEVER_WIN" };
	}

	it("env var wins (spawn NOT invoked) — env short-circuit is load-bearing", () => {
		// If someone inverts the order (spawn first, then env), the spawn
		// would return "REAL_TOKEN_FROM_SPAWN_..." and the env value would
		// lose. The assertion below catches that regression.
		let spawnCalled = false;
		const fakeSpawn = (cmd: string[]) => {
			spawnCalled = true;
			return successSpawn(cmd);
		};

		const tok = getEngramToken("test-token-not-real", fakeSpawn);
		expect(tok).toBe("test-token-not-real");
		expect(spawnCalled).toBe(false);
	});

	it("throws cleanly when neither env nor spawn is available", () => {
		// Hermetic: the test injects the spawn, so the real binary cannot
		// run. The assertion below verifies the injected spawn was called —
		// if someone reintroduces a direct `Bun.spawnSync` call, the
		// injected closure is bypassed and `spawnCalled` stays false.
		let spawnCalled = false;
		let spawnArgs: string[] | null = null;
		const fakeSpawn = (cmd: string[]) => {
			spawnCalled = true;
			spawnArgs = cmd;
			return failingSpawn(cmd);
		};

		expect(() => getEngramToken(undefined, fakeSpawn)).toThrow(
			/engram token unavailable/,
		);
		// CRITICAL: the spawned call must have been attempted via the
		// injected fn. If the production code calls `Bun.spawnSync`
		// directly, this assertion fails loudly.
		expect(spawnCalled).toBe(true);
		expect(spawnArgs).toEqual(["cal-infisical", "get", "/engram/ENGRAM_API_TOKEN"]);
	});

	it("returns the spawn's stdout when env is unset and the spawn succeeds", () => {
		// Documents the happy-path fallback: a successful spawn returns the
		// stdout value. The harness driver is responsible for sanitizing
		// that output in production; here we just verify the wiring.
		const fakeSpawn = (cmd: string[]) => successSpawn(cmd);
		expect(getEngramToken(undefined, fakeSpawn)).toBe(
			"REAL_TOKEN_FROM_SPAWN_SHOULD_NEVER_WIN",
		);
	});

	it("throws when env is empty string AND spawn fails (empty env does not win)", () => {
		// Edge case: `""` is falsy, so it must NOT short-circuit; the spawn
		// must be attempted. The default `process.env.ENGRAM_API_TOKEN` may
		// be undefined on a CI runner; passing `undefined` explicitly mirrors
		// that. If the env is set to "", the spawn path still runs.
		let spawnCalled = false;
		const fakeSpawn = (cmd: string[]) => {
			spawnCalled = true;
			return failingSpawn(cmd);
		};
		expect(() => getEngramToken("", fakeSpawn)).toThrow(/engram token unavailable/);
		expect(spawnCalled).toBe(true);
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
