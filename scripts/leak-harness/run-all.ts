/**
 * Orchestrator for the leak-harness. Spawns each candidate path as a
 * fresh subprocess (independent baseline), at identical iteration count
 * N, in two orderings — forward and reversed. Aggregates results into
 * a single report.
 *
 * Why this exists: the previous single-process version of run.ts
 * carried allocator arenas, JIT code, and warmed structures between
 * paths, so each later path's "delta" inherited growth from earlier
 * paths. It also used unequal N per path (1500/1500/300/150), so any
 * fixed per-path setup cost divided into a much bigger per-request
 * number on the path with smaller N. The ranking produced by that
 * harness could not distinguish a real signal from those artifacts.
 *
 * This orchestrator:
 *   1. Runs each path as its own Bun subprocess (Bun.spawn). Each
 *      child starts with an independent baseline. Baselines are not
 *      carried over.
 *   2. Uses the SAME iteration count N for every path including
 *      control. Per-request deltas are now directly comparable across
 *      paths — no divisor artifact.
 *   3. Runs the path order twice — once forward, once reversed. If the
 *      ranking is real it survives reordering. If it flips, it was
 *      accumulation (the later paths in a run inherit something the
 *      earlier paths established).
 *   4. Keeps the instrumentation-control path at the same N as the
 *      others. The control path is the falsify guard.
 *   5. The watch-rss.ts sidecar can be run in parallel against the
 *      longest path for an out-of-band RSS cross-check; this is
 *      unchanged from the previous harness.
 */

import { spawn } from "bun";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ChildOutput, fmtBytes } from "./run";

const PATHS_ALL: ChildOutput["path"][] = [
	"control",
	"cancel",
	"complete",
	"usage-collector",
];
const PATHS_NO_COLLECTOR: ChildOutput["path"][] = PATHS_ALL.filter(
	(p) => p !== "usage-collector",
);

const repoRoot = resolve(import.meta.dir, "..", "..");

async function runChild(
	path: ChildOutput["path"],
	iterations: number,
	streamBytes: number,
	timeoutMs: number,
): Promise<ChildOutput> {
	const cmd = [
		"bun",
		"run",
		"scripts/leak-harness/run.ts",
		"--path",
		path,
		"--iterations",
		String(iterations),
		"--stream-bytes",
		String(streamBytes),
	];
	const proc = spawn({
		cmd,
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "inherit",
		stdin: "ignore",
		env: { ...process.env },
	});
	const stdoutPromise = new Response(proc.stdout).text();
	const exitedPromise = proc.exited;
	const timeoutPromise = new Promise<"timeout">((resolve) =>
		setTimeout(() => resolve("timeout"), timeoutMs),
	);
	const winner = await Promise.race([exitedPromise, timeoutPromise]);
	if (winner === "timeout") {
		try {
			proc.kill();
		} catch {
			// best-effort
		}
		throw new Error(
			`[orchestrator] child for ${path} exceeded timeout of ${timeoutMs}ms — killed`,
		);
	}
	const exitCode = winner;
	const stdoutText = await stdoutPromise;
	if (exitCode !== 0) {
		throw new Error(
			`[orchestrator] child for ${path} exited with code ${exitCode}: ${stdoutText.slice(0, 500)}`,
		);
	}
	const trimmed = stdoutText.trim();
	const lastLine = trimmed.split("\n").pop() ?? "";
	let parsed: ChildOutput;
	try {
		parsed = JSON.parse(lastLine) as ChildOutput;
	} catch (err) {
		throw new Error(
			`[orchestrator] child for ${path} produced non-JSON output: ${lastLine.slice(0, 200)}`,
		);
	}
	if (parsed.path !== path) {
		throw new Error(
			`[orchestrator] child for ${path} reported path=${parsed.path}`,
		);
	}
	return parsed;
}

async function runOrdering(
	label: string,
	order: ChildOutput["path"][],
	iterations: number,
	streamBytes: number,
	timeoutMs: number,
): Promise<ChildOutput[]> {
	const results: ChildOutput[] = [];
	for (const path of order) {
		process.stdout.write(
			`[orchestrator] ${label}: spawning ${path} (N=${iterations}, bytes=${streamBytes}, timeout=${timeoutMs}ms)...\n`,
		);
		try {
			const r = await runChild(path, iterations, streamBytes, timeoutMs);
			process.stdout.write(
				`[orchestrator] ${label}: ${path} pid=${r.pid} Δrss=${fmtBytes(r.delta.rssBytes)} perReq=${fmtBytes(r.delta.perRequest.rssBytes)}\n`,
			);
			results.push(r);
		} catch (err) {
			process.stdout.write(
				`[orchestrator] ${label}: ${path} FAILED — ${(err as Error).message}\n`,
			);
			// Re-throw — we want to know if any path fails so we can
			// halt the run rather than report partial numbers.
			throw err;
		}
	}
	return results;
}

function renderReport(opts: {
	iterations: number;
	streamBytes: number;
	forward: ChildOutput[];
	reversed: ChildOutput[];
}): string {
	const { iterations, streamBytes, forward, reversed } = opts;
	const runPaths: ChildOutput["path"][] = Array.from(
		new Set([...forward.map((r) => r.path), ...reversed.map((r) => r.path)]),
	);
	const lines: string[] = [];
	lines.push("# Native-memory leak investigation (streaming proxy path) — corrected harness");
	lines.push("");
	lines.push(
		`**Status:** corrected. Falsify-or-confirm per path, with the two confounds the previous harness could not distinguish from signal removed.`,
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
		"**Methodology guard.** `bun:jsc.heapStats()` is a debug endpoint that allocates a JSC object snapshot on every call. Calling it on the hot measurement path would manufacture a leak that is not in the code under test. We therefore never call it on the hot path; we use `process.memoryUsage()` exclusively.",
	);
	lines.push("");
	lines.push(
		"**Carry-over fix.** Each path runs as its own Bun subprocess (spawned via `Bun.spawn`). Baselines are not carried over from a previous path: allocator arenas, JIT code, and warmed structures do not bleed into the next measurement.",
	);
	lines.push("");
	lines.push(
		"**Equal-divisor fix.** All four paths run at the SAME iteration count N. Per-request deltas are directly comparable across paths; no path has a divisor advantage.",
	);
	lines.push("");
	lines.push(
		"**Ordering-reversal check.** Paths are run in forward order `[control, cancel, complete, usage-collector]` and again in reversed order. If the per-path ranking survives reordering, it is real signal. If it flips, it was accumulation.",
	);
	lines.push("");
	lines.push("## Environment");
	lines.push("");
	const env = forward[0];
	lines.push(`- Bun: ${env.bunVersion}`);
	lines.push(`- Platform: ${env.platform} ${env.arch}`);
	lines.push(`- Iterations per path: ${iterations}`);
	lines.push(`- Stream bytes: ${streamBytes}`);
	lines.push(
		"- Upstream source: synthetic ReadableStream producing Anthropic-shaped SSE (message_start, content_block_start, content_block_delta×N, content_block_stop, ping, message_delta, message_stop) in 4 KiB segments.",
	);
	lines.push("");
	lines.push("## Per-path results — forward order");
	lines.push("");
	lines.push(
		`Order: ${forward.map((r) => r.path).join(" → ")}. Each row is a fresh subprocess.`,
	);
	lines.push("");
	lines.push(
		"| Path | PID | Iterations | Stream bytes | Δ RSS total | Δ RSS / req | Δ heapUsed / req | Δ external / req |",
	);
	lines.push(
		"|------|----:|-----------:|-------------:|------------:|------------:|-----------------:|-----------------:|",
	);
	for (const r of forward) {
		lines.push(
			`| ${r.path} | ${r.pid} | ${r.iterations} | ${r.streamBytes} | ${fmtBytes(r.delta.rssBytes)} | ${fmtBytes(r.delta.perRequest.rssBytes)} | ${fmtBytes(r.delta.perRequest.heapUsedBytes)} | ${fmtBytes(r.delta.perRequest.externalBytes)} |`,
		);
	}
	lines.push("");
	lines.push("### Raw samples — forward");
	lines.push("");
	lines.push(
		"| Path | baseline rss | final rss | baseline heap | final heap | baseline ext | final ext |",
	);
	lines.push(
		"|------|-------------:|----------:|--------------:|-----------:|-------------:|----------:|",
	);
	for (const r of forward) {
		lines.push(
			`| ${r.path} | ${fmtBytes(r.baseline.rssBytes)} | ${fmtBytes(r.final.rssBytes)} | ${fmtBytes(r.baseline.heapUsedBytes)} | ${fmtBytes(r.final.heapUsedBytes)} | ${fmtBytes(r.baseline.externalBytes)} | ${fmtBytes(r.final.externalBytes)} |`,
		);
	}
	lines.push("");
	lines.push("## Per-path results — reversed order");
	lines.push("");
	lines.push(
		`Order: ${reversed.map((r) => r.path).join(" → ")}. Each row is a fresh subprocess.`,
	);
	lines.push("");
	lines.push(
		"| Path | PID | Iterations | Stream bytes | Δ RSS total | Δ RSS / req | Δ heapUsed / req | Δ external / req |",
	);
	lines.push(
		"|------|----:|-----------:|-------------:|------------:|------------:|-----------------:|-----------------:|",
	);
	for (const r of reversed) {
		lines.push(
			`| ${r.path} | ${r.pid} | ${r.iterations} | ${r.streamBytes} | ${fmtBytes(r.delta.rssBytes)} | ${fmtBytes(r.delta.perRequest.rssBytes)} | ${fmtBytes(r.delta.perRequest.heapUsedBytes)} | ${fmtBytes(r.delta.perRequest.externalBytes)} |`,
		);
	}
	lines.push("");
	lines.push("### Raw samples — reversed");
	lines.push("");
	lines.push(
		"| Path | baseline rss | final rss | baseline heap | final heap | baseline ext | final ext |",
	);
	lines.push(
		"|------|-------------:|----------:|--------------:|-----------:|-------------:|----------:|",
	);
	for (const r of reversed) {
		lines.push(
			`| ${r.path} | ${fmtBytes(r.baseline.rssBytes)} | ${fmtBytes(r.final.rssBytes)} | ${fmtBytes(r.baseline.heapUsedBytes)} | ${fmtBytes(r.final.heapUsedBytes)} | ${fmtBytes(r.baseline.externalBytes)} | ${fmtBytes(r.final.externalBytes)} |`,
		);
	}
	lines.push("");
	lines.push("## Side-by-side ranking (Δ RSS / req)");
	lines.push("");
	lines.push("| Path | Forward | Reversed | Both positive? |");
	lines.push("|------|--------:|---------:|:---------------|");
	const byPathForward = new Map(forward.map((r) => [r.path, r]));
	const byPathReversed = new Map(reversed.map((r) => [r.path, r]));
	for (const path of runPaths) {
		const f = byPathForward.get(path);
		const rv = byPathReversed.get(path);
		const fv = f?.delta.perRequest.rssBytes ?? 0;
		const rv2 = rv?.delta.perRequest.rssBytes ?? 0;
		const both = fv > 0 && rv2 > 0 ? "yes" : "no";
		lines.push(
			`| ${path} | ${fmtBytes(fv)} | ${fmtBytes(rv2)} | ${both} |`,
		);
	}
	lines.push("");
	lines.push("## Interpretation");
	lines.push("");
	const ctrlF = byPathForward.get("control");
	const ctrlR = byPathReversed.get("control");
	const ctrlFloor = Math.max(
		ctrlF?.delta.perRequest.rssBytes ?? 0,
		ctrlR?.delta.perRequest.rssBytes ?? 0,
	);
	lines.push(
		`- **Control noise floor.** Forward: ${fmtBytes(ctrlF?.delta.perRequest.rssBytes ?? 0)}/req. Reversed: ${fmtBytes(ctrlR?.delta.perRequest.rssBytes ?? 0)}/req. Worst case used as the floor below.`,
	);
	lines.push("");
	lines.push("## Verdict");
	lines.push("");
	const ranked = runPaths.map((p) => {
		const f = byPathForward.get(p)?.delta.perRequest.rssBytes ?? 0;
		const rv = byPathReversed.get(p)?.delta.perRequest.rssBytes ?? 0;
		return { path: p, forward: f, reversed: rv, mean: (f + rv) / 2 };
	}).sort((a, b) => b.mean - a.mean);
	const ctrlMean = ranked.find((r) => r.path === "control")?.mean ?? 0;
	const cancelMean = ranked.find((r) => r.path === "cancel")?.mean ?? 0;
	const completeMean = ranked.find((r) => r.path === "complete")?.mean ?? 0;
	const collectorMean =
		ranked.find((r) => r.path === "usage-collector")?.mean ?? null;
	const collectorRan = collectorMean !== null;
	const meanParts = [
		`control ${fmtBytes(ctrlMean)}`,
		`cancel ${fmtBytes(cancelMean)}`,
		`complete ${fmtBytes(completeMean)}`,
	];
	if (collectorRan) {
		meanParts.push(`usage-collector ${fmtBytes(collectorMean ?? 0)}`);
	} else {
		meanParts.push("usage-collector (excluded — see Limitations)");
	}
	lines.push(
		`Per-request RSS growth, mean of forward and reversed runs: ${meanParts.join(", ")}.`,
	);
	lines.push("");
	const survive = (() => {
		// Cancel-path ranking in BOTH orderings. Does it stay above
		// control? Does it stay above complete?
		const fwdOrder = forward
			.slice()
			.sort((a, b) => b.delta.perRequest.rssBytes - a.delta.perRequest.rssBytes);
		const revOrder = reversed
			.slice()
			.sort((a, b) => b.delta.perRequest.rssBytes - a.delta.perRequest.rssBytes);
		return {
			fwdOrder: fwdOrder.map((r) => r.path),
			revOrder: revOrder.map((r) => r.path),
		};
	})();
	lines.push(
		`Forward ranking (high → low): ${survive.fwdOrder.join(" > ")}. Reversed ranking: ${survive.revOrder.join(" > ")}.`,
	);
	lines.push("");
	const cancelVsControlForward =
		(byPathForward.get("cancel")?.delta.perRequest.rssBytes ?? 0) -
		(byPathForward.get("control")?.delta.perRequest.rssBytes ?? 0);
	const cancelVsControlReversed =
		(byPathReversed.get("cancel")?.delta.perRequest.rssBytes ?? 0) -
		(byPathReversed.get("control")?.delta.perRequest.rssBytes ?? 0);
	const cancelVsCompleteForward =
		(byPathForward.get("cancel")?.delta.perRequest.rssBytes ?? 0) -
		(byPathForward.get("complete")?.delta.perRequest.rssBytes ?? 0);
	const cancelVsCompleteReversed =
		(byPathReversed.get("cancel")?.delta.perRequest.rssBytes ?? 0) -
		(byPathReversed.get("complete")?.delta.perRequest.rssBytes ?? 0);
	lines.push("");
	lines.push("Verdict on the cancel-path hypothesis (upstream tombii/better-ccflare#382):");
	lines.push("");
	lines.push(
		`Cancel vs control (signal over noise floor): forward ${fmtBytes(cancelVsControlForward)}/req, reversed ${fmtBytes(cancelVsControlReversed)}/req.`,
	);
	lines.push(
		`Cancel vs complete (relative size): forward ${fmtBytes(cancelVsCompleteForward)}/req, reversed ${fmtBytes(cancelVsCompleteReversed)}/req.`,
	);
	lines.push("");
	if (
		cancelVsControlForward > 0 &&
		cancelVsControlReversed > 0 &&
		cancelMean >= ctrlFloor &&
		cancelMean > 0
	) {
		const dominance =
			completeMean > 0 && cancelMean >= completeMean * 1.5
				? "dominant"
				: completeMean > 0 && cancelMean >= completeMean * 0.66
					? "co-dominant"
					: "minor";
		lines.push(
			`**Cancel path is ${dominance}.** It grows RSS more than the control noise floor in BOTH orderings (forward ${fmtBytes(cancelVsControlForward)}/req, reversed ${fmtBytes(cancelVsControlReversed)}/req). The signal survives reordering, so it is not accumulation. Mean per-request growth: ${fmtBytes(cancelMean)}.`,
		);
	} else if (cancelVsControlForward > 0 || cancelVsControlReversed > 0) {
		lines.push(
			`**Cancel path is NOT confirmed as dominant in the corrected harness.** It exceeds the control floor in only one of the two orderings, which is the signature of an accumulation artifact rather than a steady-state per-request leak. Mean per-request growth: ${fmtBytes(cancelMean)}.`,
		);
	} else {
		lines.push(
			`**Cancel path does NOT exceed the control noise floor.** It is consistent with the harness infrastructure, not a real per-request leak. Mean per-request growth: ${fmtBytes(cancelMean)}.`,
		);
	}
	lines.push("");
	lines.push("## Limitations");
	lines.push("");
	lines.push(
		"- The harness runs paths serially via subprocess spawn (not concurrently). Production concurrency is still not modeled.",
	);
	lines.push(
		"- Each path runs in a fresh process; this isolates the carry-over confound but does not isolate any process-level JIT warm-up that occurs within a path's own iterations.",
	);
	if (collectorRan) {
		lines.push(
			"- The usage-collector path's AsyncDbWriter queues DB writes against a per-child throwaway SQLite file; some fraction of the path's growth is still queue-time, not chunk-parser-time, but the equal-N + fresh-process design removes the previous 10× divisor artifact on this path.",
		);
	} else {
		lines.push(
			"- The usage-collector path was EXCLUDED from this run (`LEAK_INCLUDE_COLLECTOR=false`). In a fresh Bun subprocess, `initUsageCollector()` + `AsyncDbWriter` against a throwaway SQLite file consumes more than the per-path timeout budget (>60 s on the first iteration in fresh process). This is a third confounder on top of carry-over and unequal N, and removing it from the run keeps the cancel-vs-complete comparison clean. The earlier single-process harness's collector numbers remain confounded.",
		);
	}
	lines.push(
		"- `bun:jsc.heapStats()` is not called on the hot path. RSS-only measurement means we miss JSC-internal fragmentation that does not manifest as RSS; we rely on `process.memoryUsage()` because it is allocation-free.",
	);
	return lines.join("\n");
}

async function main(): Promise<void> {
	const iterations = Number(Bun.env.LEAK_ITERATIONS ?? "300");
	const streamBytes = Number(Bun.env.LEAK_STREAM_BYTES ?? "262144");
	const pathTimeoutMs = Number(Bun.env.LEAK_PATH_TIMEOUT_MS ?? "180000");
	const includeCollector = Bun.env.LEAK_INCLUDE_COLLECTOR !== "false";
	const outMd =
		Bun.env.LEAK_OUT_MD ??
		"docs/reviews/native-memory-leak-investigation-v3.md";
	const outJson =
		Bun.env.LEAK_OUT_JSON ??
		"docs/reviews/native-memory-leak-investigation-v3.json";

	const paths = includeCollector ? PATHS_ALL : PATHS_NO_COLLECTOR;
	const forward: ChildOutput["path"][] = [...paths];
	const reversed: ChildOutput["path"][] = [...paths].reverse();

	process.stdout.write(
		`[orchestrator] iterations=${iterations} streamBytes=${streamBytes} includeCollector=${includeCollector} timeoutMs=${pathTimeoutMs}\n`,
	);
	const forwardResults = await runOrdering(
		"forward",
		forward,
		iterations,
		streamBytes,
		pathTimeoutMs,
	);
	const reversedResults = await runOrdering(
		"reversed",
		reversed,
		iterations,
		streamBytes,
		pathTimeoutMs,
	);
	const md = renderReport({
		iterations,
		streamBytes,
		forward: forwardResults,
		reversed: reversedResults,
	});
	const dir = dirname(outMd);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(outMd, md, "utf-8");
	writeFileSync(
		outJson,
		JSON.stringify(
			{ iterations, streamBytes, forward: forwardResults, reversed: reversedResults },
			null,
			2,
		),
		"utf-8",
	);
	process.stdout.write(`[orchestrator] wrote ${outMd}\n`);
	process.stdout.write(`[orchestrator] wrote ${outJson}\n`);
}

if (import.meta.main) {
	main().catch((err) => {
		console.error("[orchestrator] fatal:", err);
		process.exit(1);
	});
}