/**
 * Native-memory leak reproduction harness for the streaming proxy path.
 *
 * NOT a CI gate. NOT a published artifact. Internal investigation script.
 *
 * Drives ONE candidate path in isolation, measures process RSS via
 * process.memoryUsage() (cheap, no debug-endpoint allocation), and
 * reports per-request growth. The point is to falsify-or-confirm the
 * cancel-path hypothesis from upstream tombii/better-ccflare #382.
 *
 * Single-path mode: the orchestrator (run-all.ts) spawns this script
 * once per (path, ordering) pair as a fresh subprocess. Each child
 * starts with an independent baseline — no allocator arenas, no JIT
 * code, no warmed structures carried over from a previous path. This
 * addresses the carry-over confound present in earlier single-process
 * versions of the harness.
 *
 * Paths exercised (selected via --path):
 *   control         — gcHard() in a tight loop with no real work. If
 *                     this path's RSS grows, the harness itself is the
 *                     leak source (e.g. a measurement endpoint that
 *                     allocates), not the code under test. MUST be
 *                     near-zero delta for the other paths to be
 *                     meaningful.
 *   cancel          — stream-tee cancel path; upstream read is
 *                     interrupted by a downstream cancel before the
 *                     body is fully consumed. Mirrors tombii's
 *                     attribution to Bun ReadableStream.cancel()
 *                     semantics.
 *   complete        — normal full consumption through teed wrapper.
 *                     Steady state of /v1/messages streaming.
 *   usage-collector — chunks are fed into the in-process collector
 *                     via handleChunk and an end message.
 *
 * Methodology guard: `bun:jsc.heapStats()` is a debug endpoint that
 * allocates a JSC object snapshot each time it is called. Calling it
 * inside the sample function manufactures a leak that is not in the
 * code under test. We therefore avoid heapStats() in the hot path and
 * use `process.memoryUsage()` exclusively.
 */

import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
	// Initialize a real UsageCollector against a throwaway SQLite file
	// unique to this child process. The DB writes themselves are not
	// what we are measuring — we are measuring the chunk → parser →
	// retained-state path that the upstream hypothesis could blame.
	// The DB ops run in the asyncWriter background and never block the
	// per-iteration measurement loop.
	const tmpDb = join(
		tmpdir(),
		`leak-harness-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
	);
	process.env.BETTER_CCFLARE_DB_PATH = tmpDb;
	process.stderr.write(`[harness/collector] db=${tmpDb} calling initUsageCollector...\n`);
	const collector = await initUsageCollector(
		() => false,
		() => undefined,
	);
	process.stderr.write(`[harness/collector] initUsageCollector returned, entering loop...\n`);
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
	const result = finalizeBatch(
		"usage-collector",
		iterations,
		streamBytes,
		baseline,
		final,
	);
	try {
		unlinkSync(tmpDb);
	} catch {
		// best-effort cleanup of the throwaway db file
	}
	return result;
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

function parseArgs(argv: string[]): Map<string, string> {
	const args = new Map<string, string>();
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const val = argv[i + 1];
			if (val && !val.startsWith("--")) {
				args.set(key, val);
				i++;
			} else {
				args.set(key, "true");
			}
		}
	}
	return args;
}

type ChildOutput = {
	path: BatchResult["path"];
	iterations: number;
	streamBytes: number;
	pid: number;
	bunVersion: string;
	platform: string;
	arch: string;
	baseline: MemorySample;
	final: MemorySample;
	delta: BatchResult["delta"];
};

async function runSinglePath(
	path: BatchResult["path"],
	iterations: number,
	streamBytes: number,
): Promise<ChildOutput> {
	let result: BatchResult;
	switch (path) {
		case "control":
			result = await runControlPath(iterations);
			break;
		case "cancel":
			result = await runCancelPath(iterations, streamBytes);
			break;
		case "complete":
			result = await runCompletePath(iterations, streamBytes);
			break;
		case "usage-collector":
			result = await runUsageCollectorPath(iterations, streamBytes);
			break;
	}
	return {
		path: result.path,
		iterations: result.iterations,
		streamBytes: result.streamBytes,
		pid: process.pid,
		bunVersion: Bun.version,
		platform: process.platform,
		arch: process.arch,
		baseline: result.baseline,
		final: result.final,
		delta: result.delta,
	};
}

async function main(): Promise<void> {
	process.stderr.write(`[harness] start pid=${process.pid} argv=${JSON.stringify(Bun.argv)}\n`);
	const args = parseArgs(Bun.argv);
	const pathRaw = args.get("path");
	if (
		pathRaw !== "control" &&
		pathRaw !== "cancel" &&
		pathRaw !== "complete" &&
		pathRaw !== "usage-collector"
	) {
		console.error(
			"[harness] --path must be one of control|cancel|complete|usage-collector",
		);
		process.exit(2);
	}
	const path = pathRaw as BatchResult["path"];
	const iterations = Number(args.get("iterations") ?? "300");
	const streamBytes = Number(args.get("stream-bytes") ?? "262144");
	process.stderr.write(`[harness] pid=${process.pid} path=${path} iterations=${iterations} streamBytes=${streamBytes} starting...\n`);

	const result = await runSinglePath(path, iterations, streamBytes);
	process.stderr.write(`[harness] pid=${process.pid} path=${path} complete\n`);
	process.stdout.write(JSON.stringify(result) + "\n");
}

void createAnthropicTerminalRecoveryStream; // silence unused-import linter
void combineChunks; // ditto

if (import.meta.main) {
	main().catch((err) => {
		console.error("[harness] fatal:", err);
		process.exit(1);
	});
}

export {
	runControlPath,
	runCancelPath,
	runCompletePath,
	runUsageCollectorPath,
	runSinglePath,
	sampleMemory,
	makeSseStream,
	ChildOutput,
	BatchResult,
	MemorySample,
	fmtBytes,
};