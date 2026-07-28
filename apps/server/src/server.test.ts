import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, mock } from "bun:test";
import { logBus } from "@better-ccflare/logger";
import { MINIMAX_USAGE_REQUEST_TIMEOUT_MS } from "@better-ccflare/providers";
import {
	bootstrapMinimaxUsagePolling,
	clampMinimaxPollingInterval,
	registerMinimaxUsagePolling,
	type UsageCacheRegistrar,
	supportsRefreshBackedUsagePolling,
} from "./server";

describe("supportsRefreshBackedUsagePolling", () => {
	it("includes pollable OAuth providers that need token refresh", () => {
		expect(supportsRefreshBackedUsagePolling("anthropic")).toBe(true);
		expect(supportsRefreshBackedUsagePolling("xai")).toBe(true);
	});

	it("does not include providers whose usage is not polled through this path", () => {
		expect(supportsRefreshBackedUsagePolling("codex")).toBe(false);
		expect(supportsRefreshBackedUsagePolling("qwen")).toBe(false);
		expect(supportsRefreshBackedUsagePolling("nanogpt")).toBe(false);
		expect(supportsRefreshBackedUsagePolling(null)).toBe(false);
	});
});

describe("registerMinimaxUsagePolling", () => {
	function makeAccount(
		overrides: Partial<{
			id: string;
			name: string;
			provider: string;
			api_key: string | null;
		}> = {},
	) {
		return {
			id: "acc-1",
			name: "minimax-account-1",
			provider: "minimax",
			api_key: "test-key",
			...overrides,
		} as unknown as Parameters<typeof registerMinimaxUsagePolling>[0];
	}

	function makeRegistrar() {
		const startPolling = mock(
			(
				_accountId: string,
				_tokenProvider: () => Promise<string>,
				_provider: string,
				_intervalMs: number,
			) => {},
		);
		return {
			registrar: { startPolling } as unknown as UsageCacheRegistrar,
			startPolling,
		};
	}

	it("registers polling for a Minimax account with an API key", () => {
		const { registrar, startPolling } = makeRegistrar();
		const result = registerMinimaxUsagePolling(makeAccount(), registrar, 30_000);

		expect(result).toBe(true);
		expect(startPolling).toHaveBeenCalledTimes(1);
		const call = startPolling.mock.calls[0];
		expect(call?.[0]).toBe("acc-1");
		expect(call?.[2]).toBe("minimax");
		expect(call?.[3]).toBe(30_000);
		expect(typeof call?.[1]).toBe("function");
	});

	it("the registered token provider returns the account's API key", async () => {
		const { registrar, startPolling } = makeRegistrar();
		registerMinimaxUsagePolling(
			makeAccount({ api_key: "secret-key" }),
			registrar,
			30_000,
		);

		const tokenProvider = startPolling.mock.calls[0]?.[1];
		expect(await tokenProvider()).toBe("secret-key");
	});

	it("does not register polling for non-Minimax accounts", () => {
		const { registrar, startPolling } = makeRegistrar();
		// The block calls registerMinimaxUsagePolling only for accounts where
		// accounts.filter((a) => a.provider === "minimax") matched, so the
		// helper itself is the load-bearing gate. If the filter goes away and
		// this helper is called for every provider, the false return here is
		// what keeps the wrong accounts from being polled.
		expect(
			registerMinimaxUsagePolling(
				makeAccount({ provider: "zai", api_key: "k" }),
				registrar,
				30_000,
			),
		).toBe(false);
		expect(
			registerMinimaxUsagePolling(
				makeAccount({ provider: "nanogpt", api_key: "k" }),
				registrar,
				30_000,
			),
		).toBe(false);
		expect(
			registerMinimaxUsagePolling(
				makeAccount({ provider: "anthropic", api_key: "k" }),
				registrar,
				30_000,
			),
		).toBe(false);
		expect(startPolling).toHaveBeenCalledTimes(0);
	});

	it("does not register polling when a Minimax account has no API key", () => {
		const { registrar, startPolling } = makeRegistrar();
		const result = registerMinimaxUsagePolling(
			makeAccount({ api_key: null }),
			registrar,
			30_000,
		);

		expect(result).toBe(false);
		expect(startPolling).toHaveBeenCalledTimes(0);
	});

	it("does not register polling when a Minimax account has an empty API key", () => {
		const { registrar, startPolling } = makeRegistrar();
		const result = registerMinimaxUsagePolling(
			makeAccount({ api_key: "" }),
			registrar,
			30_000,
		);

		expect(result).toBe(false);
		expect(startPolling).toHaveBeenCalledTimes(0);
	});
});

describe("bootstrapMinimaxUsagePolling", () => {
	function makeAccount(
		overrides: Partial<{
			id: string;
			name: string;
			provider: string;
			api_key: string | null;
		}> = {},
	) {
		return {
			id: "acc-1",
			name: "acc-1",
			provider: "minimax",
			api_key: "test-key",
			...overrides,
		} as unknown as Parameters<typeof bootstrapMinimaxUsagePolling>[0][number];
	}

	function makeRegistrar() {
		const startPolling = mock(
			(
				_accountId: string,
				_tokenProvider: () => Promise<string>,
				_provider: string,
				_intervalMs: number,
			) => {},
		);
		return {
			registrar: { startPolling } as unknown as UsageCacheRegistrar,
			startPolling,
		};
	}

	// This is the regression test for PR #347. The inline bootstrap block in
	// startServer() (around line 1637 pre-refactor) filtered `accounts` for
	// provider === "minimax" and called `registerMinimaxUsagePolling` for each
	// match. The original PR landed a working fetcher + helper but never
	// exercised the wiring path that actually invokes it at startup — mirroring
	// PR #346's "shipped a working fetcher that nothing called" bug. This test
	// pins the wiring: given a realistic mixed-provider account list (the same
	// shape `startServer()` passes), it must register polling for Minimax
	// accounts and nothing else. If the inline bootstrap block in startServer()
	// is removed (and this helper is also removed, since nothing else imports
	// it), the import below fails and every test in this file goes RED.

	it("registers polling for Minimax accounts and ignores other providers", () => {
		const { registrar, startPolling } = makeRegistrar();
		const accounts = [
			makeAccount({ id: "zai-1", name: "zai-1", provider: "zai" }),
			makeAccount({
				id: "minimax-1",
				name: "minimax-1",
				provider: "minimax",
				api_key: "minimax-key-1",
			}),
			makeAccount({ id: "nanogpt-1", name: "nanogpt-1", provider: "nanogpt" }),
			makeAccount({
				id: "minimax-2",
				name: "minimax-2",
				provider: "minimax",
				api_key: "minimax-key-2",
			}),
			makeAccount({
				id: "anthropic-1",
				name: "anthropic-1",
				provider: "anthropic",
			}),
		];

		const registered = bootstrapMinimaxUsagePolling(accounts, registrar, 30_000);

		// Only the two Minimax accounts should appear in the registered list,
		// proving the filter on `provider === "minimax"` is actually applied
		// to the full account list, not just whatever the helper receives.
		expect(registered).toEqual(["minimax-1", "minimax-2"]);
		// And the registrar must have been driven exactly twice — once per
		// Minimax account, never for the zai/nanogpt/anthropic rows that are
		// sitting in the same array.
		expect(startPolling).toHaveBeenCalledTimes(2);
		const calledIds = startPolling.mock.calls.map((c) => c[0]);
		expect(calledIds).toEqual(["minimax-1", "minimax-2"]);
	});

	it("does not register polling when the account list has no Minimax accounts", () => {
		const { registrar, startPolling } = makeRegistrar();
		const accounts = [
			makeAccount({ id: "zai-1", provider: "zai" }),
			makeAccount({ id: "nanogpt-1", provider: "nanogpt" }),
			makeAccount({ id: "anthropic-1", provider: "anthropic" }),
		];

		const registered = bootstrapMinimaxUsagePolling(accounts, registrar, 30_000);

		expect(registered).toEqual([]);
		expect(startPolling).toHaveBeenCalledTimes(0);
	});

	it("registers polling only for Minimax accounts with API keys and skips the rest", () => {
		const { registrar, startPolling } = makeRegistrar();
		const accounts = [
			makeAccount({
				id: "minimax-no-key",
				name: "no-key",
				provider: "minimax",
				api_key: null,
			}),
			makeAccount({
				id: "minimax-empty-key",
				name: "empty-key",
				provider: "minimax",
				api_key: "",
			}),
			makeAccount({
				id: "minimax-good",
				name: "good",
				provider: "minimax",
				api_key: "real-key",
			}),
		];

		const registered = bootstrapMinimaxUsagePolling(accounts, registrar, 30_000);

		expect(registered).toEqual(["minimax-good"]);
		expect(startPolling).toHaveBeenCalledTimes(1);
		expect(startPolling.mock.calls[0]?.[0]).toBe("minimax-good");
	});

	it("forwards the configured interval to every registered Minimax account", () => {
		const { registrar, startPolling } = makeRegistrar();
		const accounts = [
			makeAccount({
				id: "minimax-a",
				name: "a",
				provider: "minimax",
				api_key: "k1",
			}),
			makeAccount({
				id: "minimax-b",
				name: "b",
				provider: "minimax",
				api_key: "k2",
			}),
		];

		bootstrapMinimaxUsagePolling(accounts, registrar, 12_345);

		expect(startPolling).toHaveBeenCalledTimes(2);
		for (const call of startPolling.mock.calls) {
			expect(call[3]).toBe(12_345);
		}
	});

	// F6 — clamp poll interval to at least the request timeout, log once
	// when clamped. The realistic regression is an operator setting
	// usage_poll_interval_ms to 1000 while MINIMAX_USAGE_REQUEST_TIMEOUT_MS
	// stays at 5000; without the clamp, the UsageCache starts the next poll
	// before the previous one's HTTP body has been read, in-flight requests
	// stack, and MiniMax sees a small fleet of overlapping GETs every poll
	// cycle. The test below proves that an interval below the timeout does
	// not produce overlapping in-flight polls — the registrar receives a
	// clamped interval and never a value that would undercut the request
	// timeout.
	//
	// IMPORTANT ORDERING: the "logs WARN exactly once" test MUST run before
	// any other test that triggers clamping, because the implementation
	// emits the WARN at most once per process. bun:test runs tests in
	// declaration order, so this is the first F6 test in the suite. After
	// it runs, the "do NOT clamp / do NOT warn" tests below exercise the
	// post-emission steady state.

	it("logs WARN exactly once when clamping fires (silent clamping is its own bug)", () => {
		interface LogEvent {
			ts: number;
			level: string;
			msg: string;
			data?: unknown;
		}
		const warnEvents: LogEvent[] = [];
		const handler = (event: LogEvent) => {
			if (event.level === "WARN") warnEvents.push(event);
		};
		logBus.on("log", handler);

		const { registrar, startPolling } = makeRegistrar();
		const accounts = [
			makeAccount({
				id: "minimax-clamp",
				name: "clamp",
				provider: "minimax",
				api_key: "k",
			}),
		];

		try {
			// First call with a low interval — fires the WARN.
			bootstrapMinimaxUsagePolling(accounts, registrar, 500);
			// Second call with the same low interval — must NOT fire
			// another WARN. One warn per process is enough; spamming
			// would drown out real signals on every Minimax account.
			bootstrapMinimaxUsagePolling(accounts, registrar, 500);
			// And a third call with a different low interval — same rule.
			bootstrapMinimaxUsagePolling(accounts, registrar, 1_000);

			const clampWarns = warnEvents.filter(
				(e) =>
					e.msg.includes("Minimax usage poll interval") &&
					e.msg.includes("clamping"),
			);
			expect(clampWarns.length).toBe(1);
			// The single WARN must name the clamp target so an operator
			// tailing logs can immediately see why their setting did not
			// take effect.
			const firstWarn = clampWarns[0];
			expect(firstWarn.msg).toContain(
				String(MINIMAX_USAGE_REQUEST_TIMEOUT_MS),
			);

			// All three calls still registered polling — clamping is a
			// "raise the floor" operation, not a "skip the call" one.
			expect(startPolling).toHaveBeenCalledTimes(3);
		} finally {
			logBus.off("log", handler);
		}
	});

	it("clamps an interval below the request timeout up to the timeout", () => {
		const { registrar, startPolling } = makeRegistrar();
		const accounts = [
			makeAccount({
				id: "minimax-low",
				name: "low",
				provider: "minimax",
				api_key: "k",
			}),
		];

		// 1000 ms is well below the 5000 ms request timeout. Before the
		// clamp, this would have been forwarded to UsageCache.startPolling
		// and a new request would have started before the previous one
		// finished, stacking in-flight calls.
		bootstrapMinimaxUsagePolling(accounts, registrar, 1_000);

		expect(startPolling).toHaveBeenCalledTimes(1);
		const forwardedIntervalMs = startPolling.mock.calls[0]?.[3];
		expect(forwardedIntervalMs).toBe(MINIMAX_USAGE_REQUEST_TIMEOUT_MS);
	});

	it("does NOT clamp an interval that is already >= the request timeout", () => {
		const { registrar, startPolling } = makeRegistrar();
		const accounts = [
			makeAccount({
				id: "minimax-ok",
				name: "ok",
				provider: "minimax",
				api_key: "k",
			}),
		];

		// 90000 ms is the default in UsageCache — well above the 5000 ms
		// request timeout. The clamp must be a no-op here, otherwise the
		// operator would get a longer effective interval than they asked
		// for and the WARN would fire on every healthy configuration.
		bootstrapMinimaxUsagePolling(accounts, registrar, 90_000);

		expect(startPolling).toHaveBeenCalledTimes(1);
		const forwardedIntervalMs = startPolling.mock.calls[0]?.[3];
		expect(forwardedIntervalMs).toBe(90_000);
	});

	it("does NOT log a clamp WARN when the configured interval is already >= the request timeout", () => {
		interface LogEvent {
			ts: number;
			level: string;
			msg: string;
			data?: unknown;
		}
		const warnEvents: LogEvent[] = [];
		const handler = (event: LogEvent) => {
			if (event.level === "WARN") warnEvents.push(event);
		};
		logBus.on("log", handler);

		const { registrar } = makeRegistrar();
		const accounts = [
			makeAccount({
				id: "minimax-healthy",
				name: "healthy",
				provider: "minimax",
				api_key: "k",
			}),
		];

		try {
			// Healthy config — 90000 ms >= 5000 ms timeout. The WARN
			// specifically targets misconfiguration, so a correct
			// configuration must stay silent.
			bootstrapMinimaxUsagePolling(accounts, registrar, 90_000);

			const clampWarns = warnEvents.filter((e) =>
				e.msg.includes("clamping"),
			);
			expect(clampWarns.length).toBe(0);
		} finally {
			logBus.off("log", handler);
		}
	});
});

describe("clampMinimaxPollingInterval (F6 unit-level guard)", () => {
	// Stand-alone clamp helper. Exercised here without going through the
	// full bootstrap so a regression in the clamp math (e.g. someone
	// flipping the comparison to `>` and accepting a value at exactly the
	// boundary) is caught before the integration path even runs.

	it("returns MINIMAX_USAGE_REQUEST_TIMEOUT_MS when the input is below it", () => {
		expect(clampMinimaxPollingInterval(0)).toBe(
			MINIMAX_USAGE_REQUEST_TIMEOUT_MS,
		);
		expect(clampMinimaxPollingInterval(1)).toBe(
			MINIMAX_USAGE_REQUEST_TIMEOUT_MS,
		);
		expect(clampMinimaxPollingInterval(4_999)).toBe(
			MINIMAX_USAGE_REQUEST_TIMEOUT_MS,
		);
	});

	it("returns the input unchanged when the input is at or above MINIMAX_USAGE_REQUEST_TIMEOUT_MS", () => {
		expect(clampMinimaxPollingInterval(MINIMAX_USAGE_REQUEST_TIMEOUT_MS)).toBe(
			MINIMAX_USAGE_REQUEST_TIMEOUT_MS,
		);
		expect(clampMinimaxPollingInterval(5_001)).toBe(5_001);
		expect(clampMinimaxPollingInterval(90_000)).toBe(90_000);
	});
});

describe("readShutdownDrainMs", () => {
	const { readShutdownDrainMs, SHUTDOWN_DRAIN_MS_ENV } = require("./server");

	it("defaults to 60s and parses overrides", () => {
		delete process.env[SHUTDOWN_DRAIN_MS_ENV];
		expect(readShutdownDrainMs()).toBe(60_000);
		process.env[SHUTDOWN_DRAIN_MS_ENV] = "5000";
		expect(readShutdownDrainMs()).toBe(5_000);
		process.env[SHUTDOWN_DRAIN_MS_ENV] = "0";
		expect(readShutdownDrainMs()).toBe(0);
		process.env[SHUTDOWN_DRAIN_MS_ENV] = "nonsense";
		expect(readShutdownDrainMs()).toBe(60_000);
		delete process.env[SHUTDOWN_DRAIN_MS_ENV];
	});

	it("rejects numeric prefixes and clamps oversized values", () => {
		const { MAX_SHUTDOWN_DRAIN_MS } = require("./server");
		// parseInt would read "1abc" as a 1ms drain; treat it as invalid.
		process.env[SHUTDOWN_DRAIN_MS_ENV] = "1abc";
		expect(readShutdownDrainMs()).toBe(60_000);
		// Values beyond the clamp would overflow setTimeout's 32-bit delay and
		// make the watchdog fire immediately.
		process.env[SHUTDOWN_DRAIN_MS_ENV] = "99999999999";
		expect(readShutdownDrainMs()).toBe(MAX_SHUTDOWN_DRAIN_MS);
		// Beyond MAX_SAFE_INTEGER must still clamp, not fall back to 60s.
		process.env[SHUTDOWN_DRAIN_MS_ENV] = "9007199254740992";
		expect(readShutdownDrainMs()).toBe(MAX_SHUTDOWN_DRAIN_MS);
		delete process.env[SHUTDOWN_DRAIN_MS_ENV];
	});
});

describe("trackStreamForShutdown", () => {
	const { trackStreamForShutdown, abortInflightStreams } = require("./server");

	const endlessResponse = () =>
		new Response(
			new ReadableStream<Uint8Array>({
				async pull(controller) {
					controller.enqueue(new TextEncoder().encode("tick\n"));
					await new Promise((r) => setTimeout(r, 20));
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);

	it("errors tracked never-ending streams on abort", async () => {
		const wrapped = trackStreamForShutdown(endlessResponse());
		const reader = wrapped.body?.getReader();
		if (!reader) throw new Error("wrapped response lost its body");
		await reader.read(); // stream is live
		const first = abortInflightStreams();
		expect(first.aborted).toBe(1);
		await first.settled;
		await expect(
			(async () => {
				while (true) {
					const { done } = await reader.read();
					if (done) break;
				}
			})(),
		).rejects.toThrow(/drain deadline/);
		// Registry is drained; a second sweep has nothing to abort.
		const second = abortInflightStreams();
		expect(second.aborted).toBe(0);
		await second.settled;
	});

	it("unregisters streams that complete normally", async () => {
		const wrapped = trackStreamForShutdown(
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("done"));
						controller.close();
					},
				}),
			),
		);
		expect(await wrapped.text()).toBe("done");
		const result = abortInflightStreams();
		expect(result.aborted).toBe(0);
		await result.settled;
	});

	it("passes non-stream responses through untouched", () => {
		const plain = new Response(null, { status: 204 });
		expect(trackStreamForShutdown(plain)).toBe(plain);
	});

	it("resolves abort settlements after source cancellation, not a fixed sleep", async () => {
		let cancelResolved = false;
		const delayedCancelResponse = () =>
			new Response(
				new ReadableStream<Uint8Array>({
					async pull(controller) {
						controller.enqueue(new TextEncoder().encode("tick\n"));
						await new Promise((r) => setTimeout(r, 20));
					},
					async cancel() {
						await new Promise((r) => setTimeout(r, 30));
						cancelResolved = true;
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);

		const wrapped = trackStreamForShutdown(delayedCancelResponse());
		const reader = wrapped.body?.getReader();
		if (!reader) throw new Error("wrapped response lost its body");
		await reader.read();
		const { aborted, settled } = abortInflightStreams();
		expect(aborted).toBe(1);
		expect(cancelResolved).toBe(false);
		await settled;
		expect(cancelResolved).toBe(true);
		reader.cancel().catch(() => {});
	});
});

// Structural guard: assert that startServer() actually invokes
// bootstrapMinimaxUsagePolling in its source. This is the negative control
// for PR #347 — the previous unit-test guard only failed when the EXPORTED
// HELPER was removed, not when the call site was deleted. The realistic
// regression is someone removing the inline bootstrap block in startServer()
// while the helper still sits in the module unused. With this guard, the
// test goes RED the moment the call site disappears, even if the helper
// stays intact.
//
// Why this is structural and not behavioral: startServer() is a full
// process lifecycle (DB init, network bind, signal handlers, dashboard
// wiring, TLS). It is not realistic to invoke it in a unit test without
// dragging in the whole runtime, so this test reads the source file off
// disk and verifies the invocation is present inside startServer()'s body.
// Brittle to renames of either `startServer` or `bootstrapMinimaxUsagePolling`,
// which is by design — if either name changes, the engineer must update
// this guard and confirm the wiring is still in place.
describe("startServer() wiring guards", () => {
	function readStartServerBody(): string {
		const src = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
		const match = src.match(
			/export\s+default\s+async\s+function\s+startServer\b/,
		);
		if (!match || match.index === undefined) {
			throw new Error(
				"startServer default export not found in server.ts — update the wiring guard string",
			);
		}
		// startServer's signature is `startServer(options?: { ... }) {`.
		// Skip past the parameter list by tracking paren depth so we don't
		// latch onto the inline type-literal `{` that opens `options?:`.
		let parenDepth = 0;
		let pastParens = -1;
		for (let i = match.index; i < src.length; i++) {
			const ch = src[i];
			if (ch === "(") parenDepth++;
			else if (ch === ")") {
				parenDepth--;
				if (parenDepth === 0) {
					pastParens = i;
					break;
				}
			}
		}
		if (pastParens < 0) {
			throw new Error("startServer parameter list never closed");
		}
		const openIdx = src.indexOf("{", pastParens);
		if (openIdx < 0) {
			throw new Error("startServer body opening brace not found");
		}
		// Balance braces to find the matching close. Template strings,
		// regex literals, and comments can carry unbalanced braces, but
		// server.ts is well-formed enough that a depth counter is reliable
		// for this function — it does not contain raw `{` inside a template
		// that would fool the simple counter.
		let depth = 0;
		for (let i = openIdx; i < src.length; i++) {
			const ch = src[i];
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					return src.slice(openIdx, i + 1);
				}
			}
		}
		throw new Error("startServer body closing brace not found");
	}

	// The regression we are guarding: PR #347 shipped a working fetcher and
	// a working helper, but the inline bootstrap block in startServer() —
	// the actual production wiring — was the thing missing test coverage.
	// Removing that block (lines ~1670-1688 in server.ts) and keeping the
	// helper exported would not have failed the unit tests in this file
	// before this guard landed. With this guard, deleting that block while
	// leaving the helper intact goes RED.
	it("invokes bootstrapMinimaxUsagePolling inside startServer()", () => {
		const body = readStartServerBody();
		// Match an actual call: `<identifier> (`. Just matching the bare
		// identifier would also pass if someone left a stale comment naming
		// the helper, so we require the opening paren.
		expect(body).toMatch(/bootstrapMinimaxUsagePolling\s*\(/);
	});

	it("passes accounts, usageCache, and the configured poll interval to bootstrapMinimaxUsagePolling", () => {
		const body = readStartServerBody();
		// Check that the call site carries the same arguments the surrounding
		// zai/kilo blocks pass. This catches the regression where someone
		// replaces the full call with a stub like `bootstrapMinimaxUsagePolling()`
		// that compiles and lints but never actually wires the cache.
		const call = body.match(/bootstrapMinimaxUsagePolling\s*\(([\s\S]*?)\)/);
		expect(call).not.toBeNull();
		const args = call?.[1] ?? "";
		// Trim and split on top-level commas (no nested parens expected
		// inside the 3-arg call, but be conservative).
		const argList = args
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		expect(argList.length).toBe(3);
		// First two arguments must be the live runtime objects, not the
		// string literals "accounts" / "usageCache".
		expect(argList[0]).toBe("accounts");
		expect(argList[1]).toBe("usageCache");
		// Third argument must flow through the configured poll interval —
		// i.e. not a hardcoded numeric literal.
		expect(argList[2]).not.toMatch(/^\d+$/);
	});
});
