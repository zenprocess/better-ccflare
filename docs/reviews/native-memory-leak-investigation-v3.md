# Native-memory leak investigation (streaming proxy path) — corrected harness

**Status:** corrected. Falsify-or-confirm per path, with the two confounds the previous harness could not distinguish from signal removed.

## Scope

Three candidate sites are exercised in isolation against one instrumentation-control path. The control path runs no real work — if its RSS grows, the measurement infrastructure (the GC, the loop, anything the JSC machinery promotes/finalizes) is the leak source, not the code under test.

## Methodology

For each path, run `iterations` synthetic Anthropic-Messages-shaped SSE responses of ~`streamBytes` total through the code under test in a tight loop. Before and after each batch:

1. `bun:jsc.fullGC()` + `bun:jsc.gcAndSweep()` + `bun:jsc.fullGC()` (two-pass finalization)
2. Record `process.memoryUsage()` — RSS, heapUsed, external, arrayBuffers
3. Compute per-request delta = (final - baseline) / iterations

**Methodology guard.** `bun:jsc.heapStats()` is a debug endpoint that allocates a JSC object snapshot on every call. Calling it on the hot measurement path would manufacture a leak that is not in the code under test. We therefore never call it on the hot path; we use `process.memoryUsage()` exclusively.

**Carry-over fix.** Each path runs as its own Bun subprocess (spawned via `Bun.spawn`). Baselines are not carried over from a previous path: allocator arenas, JIT code, and warmed structures do not bleed into the next measurement.

**Equal-divisor fix.** All four paths run at the SAME iteration count N. Per-request deltas are directly comparable across paths; no path has a divisor advantage.

**Ordering-reversal check.** Paths are run in forward order `[control, cancel, complete, usage-collector]` and again in reversed order. If the per-path ranking survives reordering, it is real signal. If it flips, it was accumulation.

## Environment

- Bun: 1.3.2
- Platform: darwin x64
- Iterations per path: 200
- Stream bytes: 262144
- Upstream source: synthetic ReadableStream producing Anthropic-shaped SSE (message_start, content_block_start, content_block_delta×N, content_block_stop, ping, message_delta, message_stop) in 4 KiB segments.

## Per-path results — forward order

Order: control → cancel → complete. Each row is a fresh subprocess.

| Path | PID | Iterations | Stream bytes | Δ RSS total | Δ RSS / req | Δ heapUsed / req | Δ external / req |
|------|----:|-----------:|-------------:|------------:|------------:|-----------------:|-----------------:|
| control | 23082 | 200 | 0 | +732.00 KiB | +3.66 KiB | +9.99 KiB | +95.255 B |
| cancel | 23083 | 200 | 262144 | +25.52 MiB | +130.68 KiB | +154.37 KiB | +2.86 KiB |
| complete | 23086 | 200 | 262144 | +38.03 MiB | +194.72 KiB | +204.41 KiB | +3.00 KiB |

### Raw samples — forward

| Path | baseline rss | final rss | baseline heap | final heap | baseline ext | final ext |
|------|-------------:|----------:|--------------:|-----------:|-------------:|----------:|
| control | +43.82 MiB | +44.53 MiB | +232.59 KiB | +2.18 MiB | +786.81 KiB | +805.42 KiB |
| cancel | +42.73 MiB | +68.25 MiB | +1.35 MiB | +31.50 MiB | +788.68 KiB | +1.33 MiB |
| complete | +42.86 MiB | +80.89 MiB | +1.34 MiB | +41.27 MiB | +788.93 KiB | +1.36 MiB |

## Per-path results — reversed order

Order: complete → cancel → control. Each row is a fresh subprocess.

| Path | PID | Iterations | Stream bytes | Δ RSS total | Δ RSS / req | Δ heapUsed / req | Δ external / req |
|------|----:|-----------:|-------------:|------------:|------------:|-----------------:|-----------------:|
| complete | 23093 | 200 | 262144 | +37.05 MiB | +189.72 KiB | +204.44 KiB | +4.23 KiB |
| cancel | 23094 | 200 | 262144 | +26.26 MiB | +134.46 KiB | +154.45 KiB | +2.87 KiB |
| control | 23095 | 200 | 0 | +708.00 KiB | +3.54 KiB | +0 B | +44.58 B |

### Raw samples — reversed

| Path | baseline rss | final rss | baseline heap | final heap | baseline ext | final ext |
|------|-------------:|----------:|--------------:|-----------:|-------------:|----------:|
| complete | +43.15 MiB | +80.20 MiB | +1.35 MiB | +41.28 MiB | +788.35 KiB | +1.60 MiB |
| cancel | +42.57 MiB | +68.83 MiB | +1.33 MiB | +31.50 MiB | +785.22 KiB | +1.33 MiB |
| control | +41.95 MiB | +42.64 MiB | +1.34 MiB | +1.34 MiB | +784.95 KiB | +793.66 KiB |

## Side-by-side ranking (Δ RSS / req)

| Path | Forward | Reversed | Both positive? |
|------|--------:|---------:|:---------------|
| control | +3.66 KiB | +3.54 KiB | yes |
| cancel | +130.68 KiB | +134.46 KiB | yes |
| complete | +194.72 KiB | +189.72 KiB | yes |

## Interpretation

- **Control noise floor.** Forward: +3.66 KiB/req. Reversed: +3.54 KiB/req. Worst case used as the floor below.

## Verdict

Per-request RSS growth, mean of forward and reversed runs: control +3.60 KiB, cancel +132.57 KiB, complete +192.22 KiB, usage-collector (excluded — see Limitations).

Forward ranking (high → low): complete > cancel > control. Reversed ranking: complete > cancel > control.


Verdict on the cancel-path hypothesis (upstream tombii/better-ccflare#382):

Cancel vs control (signal over noise floor): forward +127.02 KiB/req, reversed +130.92 KiB/req.
Cancel vs complete (relative size): forward -64.04 KiB/req, reversed -55.26 KiB/req.

**Cancel path is co-dominant.** It grows RSS more than the control noise floor in BOTH orderings (forward +127.02 KiB/req, reversed +130.92 KiB/req). The signal survives reordering, so it is not accumulation. Mean per-request growth: +132.57 KiB.

## Limitations

- The harness runs paths serially via subprocess spawn (not concurrently). Production concurrency is still not modeled.
- Each path runs in a fresh process; this isolates the carry-over confound but does not isolate any process-level JIT warm-up that occurs within a path's own iterations.
- The usage-collector path was EXCLUDED from this run (`LEAK_INCLUDE_COLLECTOR=false`). In a fresh Bun subprocess, `initUsageCollector()` + `AsyncDbWriter` against a throwaway SQLite file consumes more than the per-path timeout budget (>60 s on the first iteration in fresh process). This is a third confounder on top of carry-over and unequal N, and removing it from the run keeps the cancel-vs-complete comparison clean. The earlier single-process harness's collector numbers remain confounded.
- `bun:jsc.heapStats()` is not called on the hot path. RSS-only measurement means we miss JSC-internal fragmentation that does not manifest as RSS; we rely on `process.memoryUsage()` because it is allocation-free.