/**
 * Native-memory leak reproduction harness for the streaming proxy path.
 *
 * NOT a CI gate. NOT a published artifact. Internal investigation script.
 *
 * Drives four candidate paths in isolation, measures process RSS via
 * process.memoryUsage() (cheap, no debug-endpoint allocation), and
 * reports per-request growth. The point is to falsify-or-confirm the
 * cancel-path hypothesis from upstream tombii/better-ccflare #382.
 *
 * Paths exercised:
 *   (0) instrumentation-control — gcHard() in a tight loop with no real
 *       work. If this path's RSS grows, the harness itself is the leak
 *       source (e.g. a measurement endpoint that allocates), not the
 *       code under test. MUST be near-zero delta for the other paths
 *       to be meaningful.
 *   (a) stream-tee cancel path — upstream read is interrupted by a
 *       downstream cancel before the body is fully consumed
 *   (b) normal complete path — upstream is fully drained through the
 *       teed wrapper (the steady state of /v1/messages streaming)
 *   (c) usage-collector handoff — chunks are fed into the in-process
 *       collector via handleChunk and an end message
 *
 * Each path is run as several batches. Within a batch:
 *   1. force full GC
 *   2. record baseline {rss, heapUsed, external, arrayBuffers}
 *   3. run N iterations
 *   4. force full GC
 *   5. record final
 *   6. report per-request delta
 *
 * Methodology guard: `bun:jsc.heapStats()` is a debug endpoint that
 * allocates a JSC object snapshot each time it is called. Calling it
 * inside the sample function manufactures a leak that is not in the
 * code under test. We therefore avoid heapStats() in the hot path and
 * use `process.memoryUsage()` exclusively. A single end-of-run
 * heapStats() snapshot is taken ONLY for a side-channel cross-check;
 * it never feeds the per-request delta.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";
import { createAnthropicTerminalRecoveryStream } from "../../packages/proxy/src/anthropic-terminal-recovery";
import { combineChunks, teeStream } from "../../packages/proxy/src/stream-tee";
import { initUsageCollector } from "../../packages/proxy/src/usage-collector";

type MemorySample = {
	rssBytes: number;
	heapUsedBytes: number;
	heapTotalBytes: number;
	externalBytes: number;
	arrayBuffersBytes: number;
};

type BatchResult = {
	path:
		| "control"
		| "cancel"
		| "complete"
		| "usage-collector";
	iterations: number;
	streamBytes: number;
	baseline: MemorySample;
	final: MemorySample;
	delta: {
		rssBytes: number;
		heapUsedBytes: number;
		externalBytes: number;
		arrayBuffersBytes: number;
		perRequest: {
			rssBytes: number;
			heapUsedBytes: number;
			externalBytes: number;
		};
	};
};

const jsc = require("bun:jsc") as {
	fullGC: () => void;
	gcAndSweep: () => void;
};

function gcHard(): void {
	// Two-pass: fullGC promotes, gcAndSweep finalizes. The harness wants
	// post-finalization measurements, not "this would have been freed".
	jsc.fullGC();
	jsc.gcAndSweep();
	jsc.fullGC();
}

/**
 * Cheap, allocation-free in-process memory sample. process.memoryUsage()
 * reads /proc/self/status on Linux and the Mach task_info on macOS
 * without allocating JSC objects. The jsc.heapStats() debug endpoint
 * would manufacture a leak here — we never call it on the hot path.
 */
function sampleMemory(): MemorySample {
	const m = process.memoryUsage();
	return {
		rssBytes: m.rss,
		heapUsedBytes: m.heapUsed,
		heapTotalBytes: m.heapTotal,
		externalBytes: m.external,
		arrayBuffersBytes: m.arrayBuffers,
	};
}

function fmtBytes(n: number): string {
	const sign = n >= 0 ? "+" : "";
	if (Math.abs(n) >= 1024 * 1024) {
		return `${sign}${(n / (1024 * 1024)).toFixed(2)} MiB`;
	}
	if (Math.abs(n) >= 1024) {
		return `${sign}${(n / 1024).toFixed(2)} KiB`;
	}
	return `${sign}${n} B`;
}

/**
 * Build a synthetic Anthropic-Messages SSE byte stream of approximately
 * `targetBytes`. The stream is realistic-shaped: a message_start, a
 * few content_block_start / content_block_delta / content_block_stop
 * triples, a message_delta with stop_reason=end_turn, and a
 * message_stop. Chunks are delivered in 4 KiB segments.
 */
function makeSseStream(targetBytes: number): {
	stream: ReadableStream<Uint8Array>;
	totalChunks: number;
	chunkSize: number;
	totalBytes: number;
} {
	const chunkSize = 4 * 1024;
	const encoder = new TextEncoder();
	const events: string[] = [
		'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","type":"message","role":"assistant","content":[],"model":"claude-test","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
		'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
	];
	const filler = "x".repeat(2048);
	const overhead =
		"event: ping\ndata: {\"type\":\"ping\"}\n\n".length +
		'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'
			.length +
		'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n'
			.length +
		'event: message_stop\ndata: {"type":"message_stop"}\n\n'.length +
		events.reduce((s, e) => s + e.length, 0);
	const totalFiller = Math.max(
		1,
		Math.floor((targetBytes - overhead) / filler.length),
	);
	const delta = `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${filler.repeat(totalFiller)}"}}\n\n`;
	events.push(delta);
	events.push(
		'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
	);
	events.push('event: ping\ndata: {"type":"ping"}\n\n');
	events.push(
		'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
	);
	events.push('event: message_stop\ndata: {"type":"message_stop"}\n\n');

	const allBytes = events.map((e) => encoder.encode(e));
	const totalBytes = allBytes.reduce((s, b) => s + b.length, 0);
	const segments: Uint8Array[] = [];
	for (const buf of allBytes) {
		for (let i = 0; i < buf.length; i += chunkSize) {
			segments.push(buf.subarray(i, Math.min(i + chunkSize, buf.length)));
		}
	}

	let idx = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (idx >= segments.length) {
				controller.close();
				return;
			}
			const chunk = segments[idx++];
			controller.enqueue(chunk);
		},
		cancel() {
			idx = Number.POSITIVE_INFINITY;
		},
	});
	return { stream, totalChunks: segments.length, chunkSize, totalBytes };
}

/* ------------------------------------------------------------------ *
 * Path 0: instrumentation control
 *
 * gcHard() in a tight loop with no real work. The point is to
 * falsify the harness as a leak source. If control grows, the
 * measurement infrastructure (gc itself, the loop, anything the
 * JSC GC machinery promotes/finalizes) is responsible — not the
 * code under test. A real reproduction must show delta_cancel
 * significantly greater than delta_control.
 * ------------------------------------------------------------------ */
async function runControlPath(iterations: number): Promise<BatchResult> {
	gcHard();
	const baseline = sampleMemory();
	for (let i = 0; i < iterations; i++) {
		// Yield to the event loop so the GC has a chance to run between
		// iterations even when the loop is otherwise saturated.
		if (i % 50 === 0) {
			await new Promise((r) => setImmediate(r));
			jsc.fullGC();
		}
	}
	gcHard();
	const final = sampleMemory();
	return finalizeBatch("control", iterations, 0, baseline, final);
}

/* ------------------------------------------------------------------ *
 * Path A: stream-tee cancel
 *
 * Mirrors the upstream tombii/better-ccflare #382 hypothesis site.
 * The downstream reader is cancelled after the first chunk has been
 * delivered but before the upstream is drained. The point is to
 * expose any native buffer the cancel() handler leaks via Bun
 * ReadableStream semantics.
 * ------------------------------------------------------------------ */
async function runCancelPath(
	iterations: number,
	streamBytes: number,
): Promise<BatchResult> {
	gcHard();
	const baseline = sampleMemory();
	for (let i = 0; i < iterations; i++) {
		const { stream } = makeSseStream(streamBytes);
		const teed = teeStream(stream, { maxBytes: 1024 * 1024 });
		const reader = teed.getReader();
		await reader.read();
		// Simulate client walking away after first chunk.
		await reader.cancel("client_cancel");
	}
	gcHard();
	const final = sampleMemory();
	return finalizeBatch("cancel", iterations, streamBytes, baseline, final);
}

/* ------------------------------------------------------------------ *
 * Path B: normal complete consumption
 *
 * Mirrors the 96.4% steady-state of /v1/messages streaming: the
 * downstream consumer reads the entire teed stream to completion.
 * The tee wrapper retains a copy of up to maxBytes for analytics; if
 * that retention path leaks native memory we should see it here even
 * though no cancel was ever issued.
 * ------------------------------------------------------------------ */
async function runCompletePath(
	iterations: number,
	streamBytes: number,
): Promise<BatchResult> {
	gcHard();
	const baseline = sampleMemory();
	for (let i = 0; i < iterations; i++) {
		const { stream } = makeSseStream(streamBytes);
		const teed = teeStream(stream, { maxBytes: 1024 * 1024 });
		const reader = teed.getReader();
		while (true) {
			const { done } = await reader.read();
			if (done) break;
		}
	}
	gcHard();
	const final = sampleMemory();
	return finalizeBatch("complete", iterations, streamBytes, baseline, final);
}

/* ------------------------------------------------------------------ *
 * Path C: usage-collector / payload-worker handoff
 *
 * Mirrors the chunk-by-chunk path from stream-tee.onChunk → usage
 * collector.handleChunk → post-end accounting. Uses the real
 * in-process UsageCollector singleton. If end-message accounting or
 * retained-payload bytes leak, this path will show growth even
 * without any cancel.
 * ------------------------------------------------------------------ */
async function runUsageCollectorPath(
	iterations: number,
	streamBytes: number,
): Promise<BatchResult> {
	// Initialize a real UsageCollector against a throwaway SQLite file.
	// The DB writes themselves are not what we are measuring — we are
	// measuring the chunk → parser → retained-state path that the
	// upstream hypothesis could blame. The DB ops run in the
	// asyncWriter background and never block the per-iteration
	// measurement loop.
	const tmpDb = join(
		tmpdir(),
		`leak-harness-${process.pid}-${Date.now()}.db`,
	);
	process.env.BETTER_CCFLARE_DB_PATH = tmpDb;
	const collector = await initUsageCollector(
		() => false,
		() => undefined,
	);
	gcHard();
	const baseline = sampleMemory();
	for (let i = 0; i < iterations; i++) {
		const { stream } = makeSseStream(streamBytes);
		const requestId = `harness-${process.pid}-${Date.now()}-${i}`;
		const startMsg = {
			type: "start" as const,
			requestId,
			accountId: "harness",
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
			requestHeaders: { "content-type": "application/json" },
			requestBody: null,
			responseStatus: 200,
			responseHeaders: {
				"content-type": "text/event-stream",
			},
			isStream: true,
			providerName: "anthropic-test",
			agentUsed: null,
			apiKeyId: null,
			apiKeyName: null,
			retryAttempt: 0,
			failoverAttempts: 0,
		};
		collector.handleStart(startMsg);
		const reader = stream.getReader();
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			collector.handleChunk(requestId, value);
		}
		collector.handleEnd({
			type: "end",
			requestId,
			success: true,
			streamTerminalState: "complete",
		});
	}
	gcHard();
	const final = sampleMemory();
	return finalizeBatch(
		"usage-collector",
		iterations,
		streamBytes,
		baseline,
		final,
	);
}

function finalizeBatch(
	path: BatchResult["path"],
	iterations: number,
	streamBytes: number,
	baseline: MemorySample,
	final: MemorySample,
): BatchResult {
	const drss = final.rssBytes - baseline.rssBytes;
	const dheap = final.heapUsedBytes - baseline.heapUsedBytes;
	const dext = final.externalBytes - baseline.externalBytes;
	const dab = final.arrayBuffersBytes - baseline.arrayBuffersBytes;
	return {
		path,
		iterations,
		streamBytes,
		baseline,
		final,
		delta: {
			rssBytes: drss,
			heapUsedBytes: dheap,
			externalBytes: dext,
			arrayBuffersBytes: dab,
			perRequest: {
				rssBytes: drss / iterations,
				heapUsedBytes: dheap / iterations,
				externalBytes: dext / iterations,
			},
		},
	};
}

function renderMarkdown(
	results: BatchResult[],
	hostInfo: { bunVersion: string; platform: string; arch: string },
): string {
	const lines: string[] = [];
	lines.push("# Native-memory leak investigation (streaming proxy path)");
	lines.push("");
	lines.push(
		"**Status:** preliminary. Falsify-or-confirm per path. Cancel path is the leading hypothesis per upstream tombii/better-ccflare #382 (corroborated by a clean production instance showing zero growth and zero client_cancelled streams).",
	);
	lines.push("");
	lines.push("## Scope");
	lines.push("");
	lines.push(
		"Three candidate sites are exercised in isolation against one instrumentation-control path. The control path runs no real work — if its RSS grows, the measurement infrastructure (the GC, the loop, anything the JSC machinery promotes/finalizes) is the leak source, not the code under test.",
	);
	lines.push("");
	lines.push("## Methodology");
	lines.push("");
	lines.push(
		"For each path, run `iterations` synthetic Anthropic-Messages-shaped SSE responses of ~`streamBytes` total through the code under test in a tight loop. Before and after each batch:",
	);
	lines.push("");
	lines.push(
		"1. `bun:jsc.fullGC()` + `bun:jsc.gcAndSweep()` + `bun:jsc.fullGC()` (two-pass finalization)",
	);
	lines.push(
		"2. Record `process.memoryUsage()` — RSS, heapUsed, external, arrayBuffers",
	);
	lines.push("3. Compute per-request delta = (final - baseline) / iterations");
	lines.push("");
	lines.push(
		"**Methodology guard.** `bun:jsc.heapStats()` is a debug endpoint that allocates a JSC object snapshot on every call. Calling it on the hot measurement path would manufacture a leak that is not in the code under test. We therefore never call it on the hot path; we use `process.memoryUsage()` exclusively. The harness is robust against the exact artifact a previous measurement showed on the production instance.",
	);
	lines.push("");
	lines.push("## Environment");
	lines.push("");
	lines.push(`- Bun: ${hostInfo.bunVersion}`);
	lines.push(`- Platform: ${hostInfo.platform} ${hostInfo.arch}`);
	lines.push(
		"- Upstream source: synthetic ReadableStream producing Anthropic-shaped SSE (message_start, content_block_start, content_block_delta×N, content_block_stop, ping, message_delta, message_stop) in 4 KiB segments.",
	);
	lines.push("");
	lines.push("## Per-path results");
	lines.push("");
	lines.push(
		"| Path | Iterations | Stream bytes | Δ RSS total | Δ RSS / req | Δ heapUsed / req | Δ external / req |",
	);
	lines.push(
		"|------|-----------:|-------------:|------------:|------------:|-----------------:|-----------------:|",
	);
	for (const r of results) {
		lines.push(
			`| ${r.path} | ${r.iterations} | ${r.streamBytes} | ${fmtBytes(r.delta.rssBytes)} | ${fmtBytes(r.delta.perRequest.rssBytes)} | ${fmtBytes(r.delta.perRequest.heapUsedBytes)} | ${fmtBytes(r.delta.perRequest.externalBytes)} |`,
		);
	}
	lines.push("");
	lines.push("## Raw samples");
	lines.push("");
	lines.push(
		"| Path | baseline rss | final rss | baseline heap | final heap | baseline ext | final ext |",
	);
	lines.push(
		"|------|-------------:|----------:|--------------:|-----------:|-------------:|----------:|",
	);
	for (const r of results) {
		lines.push(
			`| ${r.path} | ${fmtBytes(r.baseline.rssBytes)} | ${fmtBytes(r.final.rssBytes)} | ${fmtBytes(r.baseline.heapUsedBytes)} | ${fmtBytes(r.final.heapUsedBytes)} | ${fmtBytes(r.baseline.externalBytes)} | ${fmtBytes(r.final.externalBytes)} |`,
		);
	}
	lines.push("");
	lines.push("## Interpretation");
	lines.push("");
	const ctrl = results.find((r) => r.path === "control");
	const ctrlRss = ctrl?.delta.perRequest.rssBytes ?? 0;
	const summary: string[] = [];
	for (const r of results) {
		if (r.path === "control") {
			summary.push(
				`- **control (no real work)**: Δ RSS / req = ${fmtBytes(r.delta.perRequest.rssBytes)} Δ heapUsed / req = ${fmtBytes(r.delta.perRequest.heapUsedBytes)}. This is the harness-noise floor; all other paths must exceed it to be meaningful.`,
			);
			continue;
		}
		const perReqRss = r.delta.perRequest.rssBytes;
		const signal = perReqRss - ctrlRss;
		summary.push(
			`- **${r.path}**: Δ RSS / req = ${fmtBytes(perReqRss)}, signal over control = ${fmtBytes(signal)}.`,
		);
	}
	lines.push(...summary);
	lines.push("");
	lines.push("## Conclusion");
	lines.push("");
	lines.push(
		"TBD — written after measurement runs complete. The conclusion names the path (if any) whose per-request growth exceeds the control floor by enough to explain a multi-GB RSS over ~26k requests, and either proposes a minimal fix or states plainly that no path was reproduced as a native-memory leak under the tested conditions.",
	);
	lines.push("");
	return lines.join("\n");
}

async function main(): Promise<void> {
	const args = new Map<string, string>();
	for (let i = 2; i < Bun.argv.length; i++) {
		const arg = Bun.argv[i];
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const val = Bun.argv[i + 1];
			if (val && !val.startsWith("--")) {
				args.set(key, val);
				i++;
			} else {
				args.set(key, "true");
			}
		}
	}
	const outPath =
		args.get("out") ?? "docs/reviews/native-memory-leak-investigation.md";
	const cancelIterations = Number(args.get("cancel-iterations") ?? "5000");
	const completeIterations = Number(
		args.get("complete-iterations") ?? "1000",
	);
	const collectorIterations = Number(
		args.get("collector-iterations") ?? "500",
	);
	const controlIterations = Number(args.get("control-iterations") ?? "5000");
	const streamBytes = Number(args.get("stream-bytes") ?? "262144"); // 256 KiB

	console.log(
		`[harness] control=${controlIterations} cancel=${cancelIterations} complete=${completeIterations} collector=${collectorIterations} bytes=${streamBytes}`,
	);

	console.log("[harness] path 0 (control)...");
	const controlResult = await runControlPath(controlIterations);
	console.log(
		`[harness] control: Δrss=${fmtBytes(controlResult.delta.rssBytes)} Δheap=${fmtBytes(controlResult.delta.heapUsedBytes)}`,
	);

	console.log("[harness] path A (cancel)...");
	const cancelResult = await runCancelPath(cancelIterations, streamBytes);
	console.log(
		`[harness] cancel: Δrss=${fmtBytes(cancelResult.delta.rssBytes)} Δheap=${fmtBytes(cancelResult.delta.heapUsedBytes)}`,
	);

	console.log("[harness] path B (complete)...");
	const completeResult = await runCompletePath(
		completeIterations,
		streamBytes,
	);
	console.log(
		`[harness] complete: Δrss=${fmtBytes(completeResult.delta.rssBytes)} Δheap=${fmtBytes(completeResult.delta.heapUsedBytes)}`,
	);

	console.log("[harness] path C (usage-collector)...");
	const collectorResult = await runUsageCollectorPath(
		collectorIterations,
		streamBytes,
	);
	console.log(
		`[harness] collector: Δrss=${fmtBytes(collectorResult.delta.rssBytes)} Δheap=${fmtBytes(collectorResult.delta.heapUsedBytes)}`,
	);

	const results: BatchResult[] = [
		controlResult,
		cancelResult,
		completeResult,
		collectorResult,
	];
	const md = renderMarkdown(results, {
		bunVersion: Bun.version,
		platform: process.platform,
		arch: process.arch,
	});

	const dir = dirname(outPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(outPath, md, "utf-8");
	console.log(`[harness] wrote ${outPath}`);

	// One-shot, off-the-hot-path heapStats cross-check. We use it to
	// report a single end-of-run extraMemorySize number that gives a
	// directionally consistent number with the RSS trend, but it does
	// NOT feed any per-request delta.
	try {
		const stats = jsc && (require("bun:jsc") as { heapStats?: () => { extraMemorySize: number; objectCount: number } }).heapStats?.();
		if (stats) {
			console.log(
				`[harness] end-of-run heapStats cross-check (off hot path): extraMemorySize=${stats.extraMemorySize} objectCount=${stats.objectCount}`,
			);
		}
	} catch {
		// best-effort
	}
}

void createAnthropicTerminalRecoveryStream; // silence unused-import linter
void combineChunks; // ditto

if (import.meta.main) {
	main().catch((err) => {
		console.error("[harness] fatal:", err);
		process.exit(1);
	});
	try {
		unlinkSync(tmpDb);
	} catch {
		// best-effort cleanup of the throwaway db file
	}
}

export {
	runControlPath,
	runCancelPath,
	runCompletePath,
	runUsageCollectorPath,
	sampleMemory,
	makeSseStream,
};