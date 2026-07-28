// @ts-nocheck — harness is executed by Bun at runtime, not part of the typecheck graph.
/**
 * Held-reference leak harness for oven-sh/bun#35093.
 *
 * The upstream PR fixes a leak in Bun's fetch: when a fully-buffered response body is
 * never consumed and the Response object goes out of scope, the off-heap backing
 * store is only released when the native source is finalized. Holding a JS reference
 * to the Response keeps it alive — and the buffer — for the lifetime of that
 * reference. The PR attaches an abort-signal listener to the Response so aborting
 * releases the buffer immediately.
 *
 * Three cases, run identically:
 *   - held:    fetch(), push Response into a held array. Body never read.  → leak.
 *   - cancel:  fetch(), immediately call body?.cancel().                   → flat.
 *   - consume: fetch(), await arrayBuffer() to drain the body.             → flat.
 *
 * Metric: process.memoryUsage().rss before and after N requests, on the main
 * process only.
 *
 * Usage:
 *   TARGET_URL=https://... N=... WARMUP=... \
 *     bun bench/bun-35093-harness.ts all
 *   TARGET_URL=... bun bench/bun-35093-harness.ts held
 *
 * Notes:
 *   - The harness uses an external URL by default because the sandbox blocks
 *     bind() (no local Bun.serve). The URL is pinned (lodash 4.17.21) so the
 *     body size is stable at 73015 bytes across runs.
 *   - To run with a local server, point TARGET_URL at http://127.0.0.1:<port>/
 *     and serve a fixed-size body externally.
 */

interface CaseResult {
	case: "held" | "cancel" | "consume";
	bun_revision: string;
	bun_version: string;
	target_url: string;
	body_size_bytes: number;
	N: number;
	warmup: number;
	rss_before_kb: number;
	rss_after_kb: number;
	delta_kb: number;
	per_req_kb: number;
	rss_samples_kb: number[];
}

function rssKB(): number {
	return Math.round(process.memoryUsage().rss / 1024);
}

async function runCase(
	c: CaseResult["case"],
	targetUrl: string,
	N: number,
	warmup: number,
): Promise<CaseResult> {
	const held: Response[] = [];

	// Warmup — fetches and reads body so the per-process caches warm.
	for (let i = 0; i < warmup; i++) {
		const r = await fetch(targetUrl);
		await r.arrayBuffer();
	}

	const rssBefore = rssKB();
	const rssSamples: number[] = [rssBefore];

	for (let i = 0; i < N; i++) {
		const r = await fetch(targetUrl);
		if (c === "cancel") {
			try {
				await r.body?.cancel();
			} catch {
				// ignore — body may already be null/locked
			}
			held.push(r);
		} else if (c === "consume") {
			await r.arrayBuffer();
			held.push(r);
		} else {
			// held: do not touch body
			held.push(r);
		}
		if ((i + 1) % 100 === 0) {
			rssSamples.push(rssKB());
		}
	}

	const rssAfter = rssKB();
	const delta = rssAfter - rssBefore;
	const perReq = delta / N;
	// Note: we don't free held[] — the case "held" is specifically about holding
	// references. The script will exit shortly after anyway.
	return {
		case: c,
		bun_revision: Bun.revision ?? "",
		bun_version: Bun.version,
		target_url: targetUrl,
		body_size_bytes: 0, // filled by caller
		N,
		warmup,
		rss_before_kb: rssBefore,
		rss_after_kb: rssAfter,
		delta_kb: delta,
		per_req_kb: Number(perReq.toFixed(2)),
		rss_samples_kb: rssSamples,
	};
}

async function main(): Promise<void> {
	const arg = process.argv[2] ?? "all";
	const N = Number(process.env.N ?? process.env.LEAK_N ?? 500);
	const warmup = Number(process.env.WARMUP ?? process.env.LEAK_WARMUP ?? 50);
	const targetUrl =
		process.env.TARGET_URL ?? "https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js";

	// Probe body size once (so we can record it in results).
	const probe = await fetch(targetUrl);
	const probeBuf = await probe.arrayBuffer();
	const bodySize = probeBuf.byteLength;

	if (arg === "all") {
		const results: CaseResult[] = [];
		// Run cancel first to avoid contaminating held with cancel's residuals,
		// then consume, then held.
		for (const c of ["consume", "cancel", "held"] as const) {
			const r = await runCase(c, targetUrl, N, warmup);
			r.body_size_bytes = bodySize;
			results.push(r);
		}
		console.log(JSON.stringify(results, null, 2));
	} else if (arg === "held" || arg === "cancel" || arg === "consume") {
		const r = await runCase(arg, targetUrl, N, warmup);
		r.body_size_bytes = bodySize;
		console.log(JSON.stringify(r, null, 2));
	} else {
		console.error(`unknown case: ${arg}`);
		process.exit(2);
	}
}

main().catch((err) => {
	console.error("harness error:", err);
	process.exit(1);
});