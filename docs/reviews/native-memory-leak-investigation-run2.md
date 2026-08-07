# Native-memory leak investigation (streaming proxy path)

> **⚠️ THIS DOCUMENT IS SUPERSEDED.** Same caveats as Run 1 (above): the single-process harness that produced these numbers has two confounds the corrected harness removes. Per-path iteration counts here were 1500/1500/300/150, so the complete path's per-request figure divides by 300 and the usage-collector figure divides by 150 (more than 10× the divisor for control / cancel at 1500). This makes the per-request columns of the table below not comparable across paths. The CORRECTED analysis is at [`native-memory-leak-investigation-v3.md`](./native-memory-leak-investigation-v3.md). Cancel came in co-dominant with complete (means +131.40 / +192.37 KiB/req), not dominant. This file is preserved for reproducibility.

**Status (this run, superseded):** preliminary. Falsify-or-confirm per path. Cancel path is the leading hypothesis per upstream tombii/better-ccflare #382. See v3 for the corrected analysis.

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
| control | 1500 | 0 | +1.27 MiB | +884.736 B | +1.33 KiB | +17.242 B |
| cancel | 1500 | 262144 | +33.80 MiB | +23.07 KiB | +20.08 KiB | +416.1086666666667 B |
| complete | 300 | 262144 | +13.73 MiB | +46.85 KiB | -11.75 KiB | +138.32 B |
| usage-collector | 150 | 262144 | +48.29 MiB | +329.68 KiB | +98.09 KiB | +5.23 KiB |

## Raw samples

| Path | baseline rss | final rss | baseline heap | final heap | baseline ext | final ext |
|------|-------------:|----------:|--------------:|-----------:|-------------:|----------:|
| control | +43.28 MiB | +44.55 MiB | +233.15 KiB | +2.18 MiB | +788.82 KiB | +814.07 KiB |
| cancel | +44.60 MiB | +78.40 MiB | +2.18 MiB | +31.59 MiB | +820.60 KiB | +1.40 MiB |
| complete | +78.43 MiB | +92.16 MiB | +31.59 MiB | +28.15 MiB | +1.40 MiB | +1.44 MiB |
| usage-collector | +96.43 MiB | +144.72 MiB | +28.15 MiB | +42.52 MiB | +1.55 MiB | +2.32 MiB |

## Interpretation

- **control (no real work)**: Δ RSS / req = +884.736 B Δ heapUsed / req = +1.33 KiB. This is the harness-noise floor; all other paths must exceed it to be meaningful.
- **cancel**: Δ RSS / req = +23.07 KiB, signal over control = +22.21 KiB.
- **complete**: Δ RSS / req = +46.85 KiB, signal over control = +45.99 KiB.
- **usage-collector**: Δ RSS / req = +329.68 KiB, signal over control = +328.82 KiB.

## Conclusion

**This Run 2 conclusion is superseded — see the corrected analysis in [`native-memory-leak-investigation-v3.md`](./native-memory-leak-investigation-v3.md).** The numbers in this file are not directly comparable across rows because iteration counts differ per path; in particular the usage-collector row's 329 KiB/req derives from a path run at N=150, so any fixed-path setup cost divides into a 10× larger per-request number than the same fixed cost on cancel/control (N=1500).

The forward ranking visible in this file (collector > complete > cancel > control) is real, but the *magnitudes* are not — and the ordering between complete and cancel flips in the corrected harness when both confounds are removed: complete comes in at +192.37 KiB/req vs cancel at +131.40 KiB/req, both well above the control noise floor of +3.51 KiB/req, surviving forward + reversed. So in the corrected data, cancel is **co-dominant** with complete (complete is 1.46× cancel), not dominant. A fix scoped only to the cancel handler would address roughly 40% of the reproduced growth — meaningful, but not the whole story.
