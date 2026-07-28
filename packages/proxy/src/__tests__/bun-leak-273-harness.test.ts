/**
 * Leak harness for issue #273 — ccflare-side mitigation for the Bun
 * off-heap fetch leak (oven-sh/bun#35093).
 *
 * Bun ≥1.3.2 holds an off-heap body backing store per abandoned
 * `Response` until either (a) the body's underlying stream is cancelled
 * or (b) GC finalises the native source. The ccflare fix (a) — every
 * failover-discarded Response has its body explicitly cancelled.
 *
 * Strategy: drive the full Bun.fetch path against a real upstream (the
 * MiniMax API at api.minimax.io, which is reachable from this worktree
 * per the sandbox network allowlist) and compare RSS growth with vs
 * without the cancel. On Bun 1.3.2 we observe the leak signature
 * (~100–300+ KB/req on this body) and the cancel mitigation reduces it
 * significantly — though not down to the literal zero the upstream
 * oven-sh/bun#35093 PR claims. That residual is documented and the
 * harness asserts on the *ratio* between cancelled and uncancelled
 * paths, which is the robust distinguishing signal.
 *
 * The orchestrator's mandatory negative-control run removes only the
 * `.cancel()` call and confirms the harness's ratio-assertion goes RED.
 *
 * Run: bun test packages/proxy/src/__tests__/bun-leak-273-harness.test.ts
 *
 * NOTE: gated behind `BUN_LEAK_273_RUN=1` because it (a) exercises a
 * real-network egress path, (b) is RSS-sensitive on shared CI machines,
 * and (c) competes for the upstream's rate limit. Without the gate the
 * default `bun test packages/proxy/src/__tests__/` acceptance run is
 * not perturbed by a flake-prone network+RSS measurement.
 */
import { describe, expect, it } from "bun:test";

const ITERATIONS = 25;
const SHOULD_RUN = process.env.BUN_LEAK_273_RUN === "1";

const TEST_ENDPOINT =
	"https://api.minimax.io/v1/text/chatcompletion_v2";

function makeRequestBody(): string {
	return JSON.stringify({
		model: "MiniMax-Text-01",
		max_tokens: 16,
		messages: [{ role: "user", content: "hi" }],
	});
}

async function fetchDiscarded(): Promise<void> {
	const r = await fetch(TEST_ENDPOINT, {
		method: "POST",
		headers: {
			Authorization: "Bearer leak-273-test",
			"Content-Type": "application/json",
		},
		body: makeRequestBody(),
	});
	// Pathological code path — fetch, then drop the Response without
	// touching the body. This is exactly what happens on the
	// failover-discard branch in proxy-operations.ts BEFORE the fix.
	void r;
}

async function fetchDiscardedCancelBody(): Promise<void> {
	const r = await fetch(TEST_ENDPOINT, {
		method: "POST",
		headers: {
			Authorization: "Bearer leak-273-test",
			"Content-Type": "application/json",
		},
		body: makeRequestBody(),
	});
	if (r.body) {
		// The ccflare fix: cancel the body before the Response becomes
		// unreachable. We await so the test isn't subject to a race
		// between the cancel promise and the next iteration's fetch.
		await r.body.cancel();
	}
}

function rssKB(): number {
	return Math.round(process.memoryUsage().rss / 1024);
}

async function settleRSS(durationMs = 250): Promise<void> {
	// RSS can change asynchronously after `fetch` returns because of
	// connection-pool reuse, socket GC, and allocator fragmentation.
	// Wait briefly before sampling so the measurement isn't dominated
	// by in-flight buffer churn.
	await new Promise((r) => setTimeout(r, durationMs));
}

describe("issue #273 — Bun off-heap fetch leak: harness", () => {
	if (!SHOULD_RUN) {
		it.skip("requires BUN_LEAK_273_RUN=1 to enable (real-network + RSS measurement)", () => {
			expect(true).toBe(true);
		});
		return;
	}

	it("measures the leak signature: each fetch grows RSS without body cancel", async () => {
		await settleRSS();
		const before = rssKB();
		for (let i = 0; i < ITERATIONS; i++) {
			await fetchDiscarded();
		}
		await settleRSS();
		const after = rssKB();
		const perReq = (after - before) / ITERATIONS;

		console.log(
			`[harness/no-cancel] iterations=${ITERATIONS} rss before=${before}KB after=${after}KB delta=${after - before}KB perReq=${perReq.toFixed(1)}KB`,
		);

		// The per-request RSS growth is substantial — well above 50 KB.
		// On Bun 1.3.2 we observed ~100–300+ KB/req depending on RSS
		// noise. A reproducer that doesn't reach at least 50 KB/req
		// would mean Bun's leak has been separately fixed or is hidden
		// by allocator reuse, and the harness is no longer detecting the
		// bug — surface that as a failure.
		expect(perReq).toBeGreaterThan(50);
	});

	it("measures the mitigation: body.cancel() flattens RSS growth relative to no-cancel", async () => {
		// Measure no-cancel baseline first so we can compare ratios in
		// the same process — RSS is monotonic on alloc and absolute
		// thresholds are too noisy across machines.
		await settleRSS();
		const noCancelBefore = rssKB();
		for (let i = 0; i < ITERATIONS; i++) {
			await fetchDiscarded();
		}
		await settleRSS();
		const noCancelAfter = rssKB();
		const noCancelPerReq = (noCancelAfter - noCancelBefore) / ITERATIONS;

		// Measure with-cancel.
		await settleRSS();
		const withCancelBefore = rssKB();
		for (let i = 0; i < ITERATIONS; i++) {
			await fetchDiscardedCancelBody();
		}
		await settleRSS();
		const withCancelAfter = rssKB();
		const withCancelPerReq =
			(withCancelAfter - withCancelBefore) / ITERATIONS;

		console.log(
			`[harness/with-cancel] iterations=${ITERATIONS} rss before=${withCancelBefore}KB after=${withCancelAfter}KB delta=${withCancelAfter - withCancelBefore}KB perReq=${withCancelPerReq.toFixed(1)}KB`,
		);
		console.log(
			`[harness/ratio] noCancelPerReq=${noCancelPerReq.toFixed(1)}KB/req withCancelPerReq=${withCancelPerReq.toFixed(1)}KB/req ratio=${withCancelPerReq > 0 ? (noCancelPerReq / withCancelPerReq).toFixed(2) : "inf"}x`,
		);

		// Distinguishing assertion: the cancel path MUST grow RSS at
		// less than half the rate of the no-cancel path. This is the
		// robust signal: independent of absolute RSS noise, dependent
		// only on cancel() actually releasing the off-heap store.
		//
		// If the orchestrator's negative-control run removes ONLY the
		// `.cancel()` call from `fetchDiscardedCancelBody()`, this
		// ratio drops to ~1.0x and the assertion fails — exactly the
		// detection the spec requires.
		expect(withCancelPerReq).toBeLessThan(noCancelPerReq * 0.5);

		// Document the absolute measurement. The fix reduces but does
		// not fully eliminate the leak on Bun 1.3.2 alone — the
		// upstream oven-sh/bun#35093 PR brings it to ~0. We surface
		// the actual number so the operator can decide whether to also
		// require Bun ≥ a PR-shipped version.
		expect(withCancelPerReq).toBeLessThan(noCancelPerReq);
	});
});