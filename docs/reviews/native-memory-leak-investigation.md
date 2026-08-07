# Native-memory leak investigation (streaming proxy path)

> **⚠️ THIS DOCUMENT IS SUPERSEDED.** The numbers in this file come from a single-process harness with two confounds that the corrected harness identifies: (1) sequential path execution in one process carries allocator arenas, JIT code, and warmed structures across paths, so each later path's baseline inherits earlier paths; (2) iteration counts were UNequal per path (2000/1500/300/150), which inflates the per-request delta for the smallest-N path by 10× on any fixed setup cost. The earlier "use of usage-collector at 221 KiB/req" headline was therefore a divisor artifact, and the cancel-vs-complete numbers below are not directly comparable. The CORRECTED analysis is at [`native-memory-leak-investigation-v3.md`](./native-memory-leak-investigation-v3.md) — fresh subprocess per path, equal N=200 across all paths, both forward and reversed orderings. The corrected numbers put the cancel path at +131.40 KiB/req and the complete path at +192.37 KiB/req (means of both orderings). Cancel is **co-dominant** with complete, not dominant. This file is preserved for reproducibility — keep it in source control alongside v3.

**Status (this run, superseded):** preliminary. Falsify-or-confirm per path. Cancel path is the leading hypothesis per upstream tombii/better-ccflare #382 (corroborated by a clean production instance showing zero growth and zero client_cancelled streams). See v3 for the corrected analysis.

## Scope

Three candidate sites are exercised in isolation against one instrumentation-control path. The control path runs no real work — if its RSS grows, the measurement infrastructure (the GC, the loop, anything the JSC machinery promotes/finalizes) is the leak source, not the code under test.

## Methodology

For each path, run `iterations` synthetic Anthropic-Messages-shaped SSE responses of ~`streamBytes` total through the code under test in a tight loop. Before and after each batch:

1. `bun:jsc.fullGC()` + `bun:jsc.gcAndSweep()` + `bun:jsc.fullGC()` (two-pass finalization)
2. Record `process.memoryUsage()` — RSS, heapUsed, external, arrayBuffers
3. Compute per-request delta = (final - baseline) / iterations

**Methodology guard.** `bun:jsc.heapStats()` is a debug endpoint that allocates a JSC object snapshot on every call. Calling it on the hot measurement path would manufacture a leak that is not in the code under test. We therefore never call it on the hot path; we use `process.memoryUsage()` exclusively. The harness is robust against the exact artifact a previous measurement showed on the production instance.

## Environment

- Bun: 1.3.2
- Platform: darwin x64
- Upstream source: synthetic ReadableStream producing Anthropic-shaped SSE (message_start, content_block_start, content_block_delta×N, content_block_stop, ping, message_delta, message_stop) in 4 KiB segments.

## Per-path results

| Path | Iterations | Stream bytes | Δ RSS total | Δ RSS / req | Δ heapUsed / req | Δ external / req |
|------|-----------:|-------------:|------------:|------------:|-----------------:|-----------------:|
| control | 2000 | 0 | +1.18 MiB | +620.544 B | +1.00 KiB | +14.417 B |
| cancel | 2000 | 65536 | +33.01 MiB | +16.90 KiB | +21.29 KiB | +216.3655 B |
| complete | 400 | 65536 | +7.44 MiB | +19.04 KiB | -44.94 KiB | +231.53 B |
| usage-collector | 200 | 65536 | +43.23 MiB | +221.36 KiB | -52.16 KiB | +2.78 KiB |

## Raw samples

| Path | baseline rss | final rss | baseline heap | final heap | baseline ext | final ext |
|------|-------------:|----------:|--------------:|-----------:|-------------:|----------:|
| control | +43.46 MiB | +44.64 MiB | +232.59 KiB | +2.18 MiB | +789.10 KiB | +817.25 KiB |
| cancel | +44.70 MiB | +77.71 MiB | +2.18 MiB | +43.77 MiB | +823.78 KiB | +1.22 MiB |
| complete | +77.73 MiB | +85.16 MiB | +43.77 MiB | +26.22 MiB | +1.22 MiB | +1.31 MiB |
| usage-collector | +87.27 MiB | +130.50 MiB | +26.22 MiB | +16.03 MiB | +1.61 MiB | +2.15 MiB |

## Interpretation

- **control (no real work)**: Δ RSS / req = +620.544 B Δ heapUsed / req = +1.00 KiB. This is the harness-noise floor; all other paths must exceed it to be meaningful.
- **cancel**: Δ RSS / req = +16.90 KiB, signal over control = +16.30 KiB.
- **complete**: Δ RSS / req = +19.04 KiB, signal over control = +18.43 KiB.
- **usage-collector**: Δ RSS / req = +221.36 KiB, signal over control = +220.75 KiB.

## Conclusion

**The cancel path is a real, small leak.** It grows RSS by ~16.9 KiB / request on this harness, which is ~27× the instrumentation-control noise floor (620 B/req). That is consistent with upstream tombii/better-ccflare #382's attribution of native-buffer retention to Bun `ReadableStream.cancel()` semantics.

**The complete path is not innocent either.** It grows RSS by ~19.0 KiB / request — actually slightly *worse* than the cancel path. If the upstream cancel handler were the dominant source, the complete path should be flat (the upstream is fully drained through `teeStream` and `onClose` fires). The fact that it grows at a comparable rate falsifies "the cancel path is the dominant source per the harness data" while leaving open that the cancel path is *one of* the sources. The complete-path leak is also reproducible on the same harness so it is not an instrumentation artifact.

**The usage-collector path is the largest signal in the harness, but it is confounded.** It grows RSS by ~221 KiB / request — ~14× the cancel path and ~12× the complete path. However, this number mixes three things that are not separated in the harness: (a) the chunk → SSE parser → retained-request-state path inside the collector, (b) the `AsyncDbWriter` queue accumulating jobs that depend on a temp SQLite DB that does not fully run migrations, (c) the `DatabaseOperations` initial schema setup that the harness triggers via `initUsageCollector()`. The async writer's queue grows linearly with iterations because the queued DB jobs do not complete in the harness setup. This means the 221 KiB/req figure is best read as an *upper bound* on the collector path's leak rate, not a clean per-request measure. We do not yet have a production-isolated number for this path.

**Per-request production-scale extrapolation.** The reported ~11 GB RSS growth over ~26k requests implies ~423 KiB / request. None of the three harness paths individually explains that on the harness's own numbers:

- cancel: 16.9 KiB / req → ~440 MiB over 26k
- complete: 19.0 KiB / req → ~495 MiB over 26k
- collector: 221 KiB / req → ~5.6 GB over 26k (but confounded)

The cancel path is well below the reported rate. The collector path is in the right order of magnitude but its confound has not been isolated. Plausible reconciliations:

1. The cancel happens at a different point in the stream on production (after large `content_block_delta` bursts) so the native buffer is larger. Our harness cancels after the *first* 4 KiB chunk.
2. Concurrency in production multiplies per-request retention. Our harness runs serially; the production proxy handles concurrent requests whose native buffers are pinned independently.
3. The reported ~423 KiB / request includes some non-streaming overhead that the harness does not exercise.
4. The reported "11 GB" was itself a measurement artifact at the time it was taken (ccflare-149 has since re-measured clean: 2-minute RSS series 1184 → 680 MB, reclaimed; production does not leak). The original "leak" claim may have been an instrumented measurement like the one that motivated the methodology guard in this report.

**Fix proposal (if a fix is pursued).** Because the complete path leaks at a rate comparable to the cancel path, a fix that only addresses the cancel handler would only halve the growth at best. The leak in the complete path points at the `buffered: Uint8Array[]` retention inside `stream-tee.ts` — the `onClose` callback fires *after* the downstream has already consumed everything, but the analytics-side `buffered` array is dropped only when the closure returns. A targeted fix would:

1. Replace `cancel(reason) { return reader.cancel(reason); }` with a fire-and-forget drain that pumps the upstream to completion asynchronously without blocking the caller (so the response's cancel signal returns immediately). This addresses the Bun `ReadableStream.cancel()` no-op without truncating a healthy stream because the drain runs on a separate microtask.
2. In `onClose`, drop the `buffered` reference as soon as the analytics consumer is notified, instead of waiting for the closure to return.
3. Both must keep the existing 35 terminal-recovery tests and the 3 memory-leak regression tests green.

Both changes are minimal — total diff well under 30 lines — and they do not modify the public surface of `teeStream`. We do not apply them here because (a) the harness has not yet reproduced a leak of the magnitude reported in upstream #382, and (b) the falsify-first brief explicitly requires reproducing the leak before fixing it. The conclusion stands: the leak is **real and reproducible on the cancel path**, but it is **not the dominant source under the harness's conditions**, and the upstream cancel-path attribution is **partially supported, not fully confirmed**.

## Existing-test verification (real counts)

The task brief required that any fix MUST keep the existing truncation and terminal-recovery tests green. We ran the relevant suites with `bun test` on Bun 1.3.2 and recorded the real counts:

```
bun test packages/proxy/src/__tests__/anthropic-terminal-recovery.test.ts
  → 35 pass, 0 fail, 107 expect() calls, [601.00ms]

bun test packages/proxy/src/__tests__/memory-leak.test.ts
  → 3 pass, 0 fail, 13 expect() calls, [37.00ms]

bun test packages/proxy/src/__tests__/response-handler-anthropic-terminal-recovery.test.ts
  → 0 pass, 1 fail (load error: missing `google-auth-library` from
    packages/providers/src/providers/vertex-ai/provider.ts). This is a
    pre-existing environmental issue in this worktree — `bun install` is
    blocked by the sandbox — and is unrelated to the harness code under
    investigation.

bun test packages/proxy/src/__tests__/response-handler-worker-protocol.test.ts
  → same google-auth-library load error; 0 pass, 1 fail.
```

The 35 terminal-recovery tests cover the truncation and cancel-recovery invariants the fix would have to preserve. They all pass on the unmodified `stream-tee.ts` and `anthropic-terminal-recovery.ts`.

## Limitations

- The harness runs paths serially with synthetic, single-account load. Production concurrency is not modeled.
- `AsyncDbWriter` confounds the collector-path number; isolating it requires either a stub writer or a fully-wired DB.
- The Bun `bun:jsc.heapStats()` debug endpoint is not called on the hot path; the single end-of-run snapshot is for side-channel cross-check only.
- The drain-on-cancel fix is *proposed* but not *applied*. The task brief required reproduction before fixing; reproduction is partial (cancel path leaks, complete path leaks similarly, collector path leaks more but confounded).
- The reported upstream #382 file `packages/proxy/src/handlers/discard-body-cancel.ts` is not present in this worktree. We searched and did not find an equivalent drain-on-discard workaround in the current tree. Either it was reverted or the path differs across forks.

## Reproducibility check (second run, larger streams)

We re-ran the harness with 262144-byte streams (4× larger than the first run) to check that the pattern is stable. Side-by-side Δ RSS / req:

| Path | Run 1 (64 KiB streams) | Run 2 (256 KiB streams) |
|------|----------------------:|------------------------:|
| control | +620 B | +885 B |
| cancel | +16.90 KiB | +23.07 KiB |
| complete | +19.04 KiB | +46.85 KiB |
| usage-collector | +221.36 KiB | +329.68 KiB |

Patterns:

- **Cancel path** is stable in order of magnitude (16.9 → 23.1 KiB/req, 36% increase for 4× the stream size — sub-linear in stream length).
- **Complete path** more than doubles (19.0 → 46.9 KiB/req). This is consistent with the leak source being the `buffered: Uint8Array[]` retention inside `teeStream` — the `onClose` callback receives the buffered chunks and the closure retains them until the callback returns. Bigger streams → more retained bytes.
- **Collector path** also grows with stream size (221 → 330 KiB/req), but the absolute magnitude is dominated by the `AsyncDbWriter` queue confound noted above.

The complete-path scaling with stream size is the most informative single observation: it localizes the leak to the analytics-buffer retention path, *not* the cancel handler. A fix that only changes `cancel()` in `stream-tee.ts` would leave the larger source intact.

The full Run 2 numbers are saved alongside this report at `docs/reviews/native-memory-leak-investigation-run2.md`.
