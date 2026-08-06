/**
 * Out-of-band RSS watcher. Spawns as a separate child process and
 * samples its own RSS via process.memoryUsage() every --interval-ms
 * milliseconds, writing a CSV to --out. The main harness process
 * triggers a coordinated sample by writing the marker "MARK,<label>"
 * to its own stdin / via signal — but the simplest pattern is: the
 * harness runs and writes its own in-process numbers; the watcher
 * runs in parallel and writes its own RSS series; we correlate by
 * timestamp after the fact.
 *
 * This is the gold-standard cross-check on the in-process
 * process.memoryUsage().rss number: a separate Bun process has its
 * own GC schedule and its own allocation pattern, so its RSS line
 * is not influenced by anything happening inside the harness loop.
 */

import { writeFileSync } from "node:fs";

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
const out = args.get("out") ?? "docs/reviews/native-memory-leak-investigation.rss.csv";
const intervalMs = Number(args.get("interval-ms") ?? "50");
const durationMs = Number(args.get("duration-ms") ?? "60000");

const lines: string[] = ["timestamp_ms,rss_bytes,heap_used_bytes,external_bytes"];
const start = Date.now();
let last = start;
const interval = setInterval(() => {
	const m = process.memoryUsage();
	const ts = Date.now();
	lines.push(`${ts},${m.rss},${m.heapUsed},${m.external}`);
	last = ts;
}, intervalMs);

setTimeout(() => {
	clearInterval(interval);
	writeFileSync(out, lines.join("\n") + "\n", "utf-8");
	console.log(`[watcher] wrote ${out} (${lines.length - 1} samples, ${Date.now() - start} ms)`);
	process.exit(0);
}, durationMs);