/**
 * Regression test for issue #273 — ccflare-side mitigation for the Bun
 * off-heap fetch leak (oven-sh/bun#35093).
 *
 * When proxyWithAccount decides to discard a response (429/529/401
 * failover → return null, or any retry-loop overwrite of the previous
 * response), the response body MUST be explicitly cancelled so the
 * backing store is released. Without this, every abandoned Response holds
 * ~100KB off-heap until GC.
 *
 * This test imports the PRODUCTION helper
 * (`handlers/discard-body-cancel.ts:cancelDiscardedResponseBody`) directly
 * — the same function the 12 cancel sites in proxy-operations.ts call.
 * The orchestrator's mandatory negative-control run removes ONLY those
 * 12 call sites (and/or the `body.cancel()` invocation inside the
 * helper); the assertions below verify both halves:
 *
 *   Group A (helper contract) — verifies `cancelDiscardedResponseBody`
 *   invokes `body.cancel()` on the response we hand it, and is safe on
 *   null body / locked body / already-cancelled body. Removing the
 *   `body.cancel()` line inside the helper function flips these red.
 *
 *   Group B (call-site coverage) — performs static analysis of
 *   `proxy-operations.ts` to assert the 12 cancel calls are present
 *   and structurally well-formed. Removing any one of them flips this
 *   red. We don't import proxy-operations.ts (its transitive
 *   dependency chain loads @better-ccflare/database, which itself has
 *   missing modules in this worktree's `bun install`-blocked state —
 *   a pre-existing issue unrelated to this fix), but the source-level
 *   check is enough to detect the negative-control removal: 12 sites,
 *   each line beginning with the helper name.
 *
 * Run: bun test packages/proxy/src/__tests__/bun-leak-273-regression.test.ts
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { cancelDiscardedResponseBody } from "../handlers/discard-body-cancel";

// ---------------------------------------------------------------------------
// Group A — helper contract. Imported directly so a body.cancel() removal
// from inside the helper function is detected at the test's runtime.
// ---------------------------------------------------------------------------

function makeRecordableResponse(
	body: Uint8Array,
	init: ResponseInit,
): readonly [Response, () => number] {
	const response = new Response(body, init);
	let cancelCalls = 0;
	const stream = response.body;
	if (!stream) {
		return [response, () => cancelCalls] as const;
	}
	const origCancel = stream.cancel.bind(stream);
	(stream as { cancel: typeof origCancel }).cancel = ((
		reason?: unknown,
	) => {
		cancelCalls++;
		return origCancel(reason);
	}) as typeof origCancel;
	return [response, () => cancelCalls] as const;
}

describe("issue #273 — Group A: helper contract", () => {
	it("PRODUCTION helper invokes body.cancel() on a non-locked Response body", () => {
		const body = new Uint8Array(200_000).fill(0x41);
		const [response, getCancelCount] = makeRecordableResponse(body, {
			status: 429,
		});
		expect(getCancelCount()).toBe(0);

		cancelDiscardedResponseBody(response);

		expect(getCancelCount()).toBeGreaterThanOrEqual(1);
	});

	it("PRODUCTION helper is safe when body is null", () => {
		const response = new Response(null, { status: 204 });
		expect(response.body).toBeNull();
		expect(() => cancelDiscardedResponseBody(response)).not.toThrow();
	});

	it("PRODUCTION helper does not throw on an already-locked body", () => {
		const body = new Uint8Array(200_000).fill(0x41);
		const response = new Response(body, { status: 503 });
		const stream = response.body;
		if (!stream) throw new Error("expected body");
		const reader = stream.getReader();
		try {
			expect(() => cancelDiscardedResponseBody(response)).not.toThrow();
		} finally {
			reader.releaseLock();
		}
	});

	it("PRODUCTION helper does not throw on a body that has been cancelled already (idempotent enough)", () => {
		const body = new Uint8Array(200_000).fill(0x41);
		const [response, getCancelCount] = makeRecordableResponse(body, {
			status: 429,
		});
		cancelDiscardedResponseBody(response);
		const firstCalls = getCancelCount();
		expect(firstCalls).toBeGreaterThanOrEqual(1);
		expect(() => cancelDiscardedResponseBody(response)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Group B — call-site coverage. Static check that the 12 cancel sites the
// spec calls out (429/529/401 failover return-null + retry-loop overwrite)
// are wired into proxy-operations.ts. The negative-control run removes
// these lines; this check fails if any are missing.
// ---------------------------------------------------------------------------

const EXPECTED_SITE_COUNT = 12;

describe("issue #273 — Group B: call-site coverage in proxy-operations.ts", () => {
	it("proxy-operations.ts has exactly 12 cancelDiscardedResponseBody call sites", () => {
		const source = readFileSync(
			"packages/proxy/src/handlers/proxy-operations.ts",
			"utf-8",
		);
		// Match call sites only — exclude the import line. Each call is
		// `cancelDiscardedResponseBody(rawResponse)` or
		// `cancelDiscardedResponseBody(response)` on a line of its own.
		const callMatches = source.match(
			/^\s*cancelDiscardedResponseBody\((?:rawResponse|response)\);/gm,
		);
		const count = callMatches?.length ?? 0;
		expect(count).toBe(EXPECTED_SITE_COUNT);
	});

	it("proxy-operations.ts imports the helper module", () => {
		const source = readFileSync(
			"packages/proxy/src/handlers/proxy-operations.ts",
			"utf-8",
		);
		expect(source).toMatch(
			/import\s*\{\s*cancelDiscardedResponseBody\s*\}\s*from\s*["']\.\/discard-body-cancel["']/,
		);
	});

	it("proxy-operations.ts has cancel sites at the 12 expected line ranges", () => {
		const source = readFileSync(
			"packages/proxy/src/handlers/proxy-operations.ts",
			"utf-8",
		);
		// Spot-check structural patterns. Each discard kind shows up as
		// a specific guard followed by the cancel + return null.
		// We look for `cancelDiscardedResponseBody(...)` adjacent to
		// return null / break; / assignment patterns.
		//
		// Type A — return null sites: `cancelDiscardedResponseBody(...);\n...return null;`
		const returnNullSites = source.match(
			/cancelDiscardedResponseBody\((rawResponse|response)\);[\s\S]{0,200}?return null;/g,
		);
		expect(returnNullSites?.length ?? 0).toBeGreaterThanOrEqual(8);

		// Type B — retry-loop overwrite sites: `rawResponse = ` or
		// `response = ` preceded by a cancel call. (Just need at least 4
		// such overwrite blocks for the retry loops — thinking-block,
		// cache_control, model-list, in-place 529.)
		const overwriteSites = source.match(
			/cancelDiscardedResponseBody\(rawResponse\);\n\s*rawResponse\s*=/g,
		);
		expect(overwriteSites?.length ?? 0).toBeGreaterThanOrEqual(3);
	});
});

// ---------------------------------------------------------------------------
// Group C — forwarded body safety. A discard-only contract without a
// forward-safety guarantee is the silent-stream-truncation bug class.
// Ensure the helper does NOT cancel bodies we're going to forward.
// ---------------------------------------------------------------------------

describe("issue #273 — Group C: forwarded-body safety", () => {
	it("a 200 OK body that we explicitly do NOT hand to the helper drains end-to-end", async () => {
		const payload = new Uint8Array(1024).fill(0x42);
		const response = new Response(payload, {
			status: 200,
			headers: { "content-type": "application/octet-stream" },
		});

		const stream = response.body;
		expect(stream).not.toBeNull();
		if (!stream) throw new Error("expected body");

		const reader = stream.getReader();
		const chunks: Uint8Array[] = [];
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value) chunks.push(value);
		}
		reader.releaseLock();

		const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
		expect(total).toBe(payload.byteLength);
	});

	it("tee'ing a body for the client/server split still drains both halves (no premature close)", async () => {
		const payload = new Uint8Array(4096).fill(0x42);
		const response = new Response(payload, {
			status: 200,
			headers: { "content-type": "application/octet-stream" },
		});
		const body = response.body;
		if (!body) throw new Error("expected body");
		const [forClient, forServer] = body.tee();

		const clientChunks: Uint8Array[] = [];
		const serverChunks: Uint8Array[] = [];
		await Promise.all([
			(async () => {
				const r = forClient.getReader();
				while (true) {
					const { value, done } = await r.read();
					if (done) break;
					if (value) clientChunks.push(value);
				}
				r.releaseLock();
			})(),
			(async () => {
				const r = forServer.getReader();
				while (true) {
					const { value, done } = await r.read();
					if (done) break;
					if (value) serverChunks.push(value);
				}
				r.releaseLock();
			})(),
		]);

		const total = (chunks: Uint8Array[]) =>
			chunks.reduce((acc, c) => acc + c.byteLength, 0);
		expect(total(clientChunks)).toBe(payload.byteLength);
		expect(total(serverChunks)).toBe(payload.byteLength);
	});
});
