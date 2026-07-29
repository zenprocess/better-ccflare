# Bun 1.2.23 leak bench — held / cancel / drain

**Status:** **VOID — negative control failed.** Bun 1.2.23 measured `held` at
9.10 / 2.94 / −0.78 KB/req across three independent runs. The harness's
mandatory negative control is that the held case **MUST leak**; on 1.3.2 /
1.3.14 / `#35093` the same harness measures 73–77 KB/req at the same body
size. 1.2.23's measurements are ~30× lower than that floor. Per the spec's
contract, the result is void — we cannot tell whether 1.2.23 is genuinely
better or the harness is broken on this binary.

**Honest read:** 1.2.23 is **unknown**, not "better than 1.3.14".

## TL;DR

| Bun binary       | revision         | held (KB/req) | cancel (KB/req) | consume (KB/req) | Status      |
| ---------------- | ---------------- | ------------- | --------------- | ---------------- | ----------- |
| 1.3.2            | `b131639c`       | 73.26 (leaks) | 83.34 (leaks)   | 12.60            | passes NC   |
| 1.3.14           | release          | 76.62 (leaks) | 78.54 (leaks)   | 10.84            | passes NC   |
| `#35093` build   | `b296b3d58`      | 77.33 (leaks) | −13.51 (flat)   | 10.24            | passes NC   |
| **1.2.23 (run 1)** | `cf1367137d…` | **9.10**      | 15.54           | 15.47            | **VOID**    |
| **1.2.23 (run 2)** | `cf1367137d…` | **2.94**      | 4.71 (re-run)   | —                | **VOID**    |
| **1.2.23 (run 3)** | `cf1367137d…` | **−0.78**     | —               | —                | **VOID**    |

(73 015-byte pinned body: `https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js`.
N=500, warmup=50. Per-request KB = `(rss_after − rss_before) / N` on the
client process only. Raw outputs in `bench/results/1.2.23*.json`. Body source
is identical to the 1.3.2 / 1.3.14 / `#35093` runs — same byte count, same
server, same warmup cadence.)

## How Bun 1.2.23 was obtained

- Downloaded directly from the upstream release artifact:
  `https://github.com/oven-sh/bun/releases/download/bun-v1.2.23/bun-darwin-x64.zip`
  → extracted to `/tmp/claude-501/bun-1.2.23/bun-darwin-x64/bun`.
  Confirmed `Bun.version === "1.2.23"`, revision `cf1367137da5775dc23cb57f0e4071776e1ff90f`.
  The download was a single `curl` from `github.com` (sandbox allowlist).
- `bun upgrade --to 1.2.23` was not used because the host's installed Bun is
  1.3.2 and that command would downgrade the host Bun, which is out of scope
  and outside this scratch dir.

## Negative-control failure

The harness's contract — stated in `bench/bun-35093-harness.ts`'s comment
header — is that the `held` case MUST leak. The premise is that without
consuming or cancelling, a `Response` from `fetch()` keeps its off-heap
buffer alive for the lifetime of the JS reference, so 500 such references
should produce ~500 × body-size worth of RSS growth across the loop.

On 1.3.2 / 1.3.14 / `#35093` this holds: 73–77 KB/req with a 73 015-byte body
(coefficient ≈ 1.0× body size, exactly as expected).

On 1.2.23 the three independent runs produced:

| Run  | rss_before_kb | rss_after_kb | delta_kb | per_req_kb | rss sample mid-run (KB)                       |
| ---- | ------------- | ------------ | -------- | ---------- | --------------------------------------------- |
| 1    | 40888         | 45440        | +4552    | **9.10**   | 40888 → 30424 → 26712 → 29996 → 37656 → 45440 |
| 2    | 25084         | 26552        | +1468    | **2.94**   | 25084 → 31228 → 24228 → 21548 → 29848 → 26548 |
| 3    | 24820         | 24432        | −388     | **−0.78**  | 24820 → 25604 → 22320 → 21988 → 30044 → 24432 |

Every run's RSS samples drop well below `rss_before_kb` mid-loop (run 1: down
to 26 712 KB from 40 888; run 2: down to 21 548 KB from 25 084; run 3: down
to 21 988 KB from 24 820). On 1.3.2 / 1.3.14 / `#35093` the RSS samples are
monotonically increasing — there is no mid-run GC event that releases tens
of MB. **The harness's RSS-delta method assumes RSS only grows during the
loop.** 1.2.23 violates that assumption by GC'ing the held Responses
mid-loop, which collapses the leak signal into noise.

Two non-exclusive explanations for the observed GC:

1. **Bun 1.2.23's fetch implementation does not retain the off-heap buffer
   in the same way 1.3.x does.** In that case 1.2.23 genuinely does not have
   this leak, the harness is faithful, and our published numbers for 1.3.x
   would be an upper bound on production exposure (production runs 1.2.23,
   not 1.3.14). But the spec's mandatory negative control says we cannot
   report this — we have no way to disambiguate it from the next explanation
   using only this harness.
2. **Bun 1.2.23's GC pressure schedule differs enough that the harness's
   one-shot RSS-delta method is unreliable on this binary.** In that case
   1.2.23 may leak just as much as 1.3.14 and the harness is simply blind
   to it on this binary. The harness was designed and validated on 1.3.x.

Either way, the result is void.

## What we cannot conclude

- ❌ That 1.2.23 is "better than 1.3.14" — the harness is not trustworthy on
  this binary, and the spec explicitly forbids reporting that interpretation.
- ❌ That 1.2.23 is "equivalent" — same reason; "equivalent" requires
  measurements that pass the negative control.
- ❌ That production exposure is "less than the 1.3.14 numbers imply" — the
  underlying premise (1.2.23 has less leak) is unverified.
- ❌ That production exposure is "more than the 1.3.14 numbers imply" —
  the alternative (1.2.23 leaks the same but the harness is blind to it on
  this binary) is also live.

## What we CAN conclude

- ✅ The harness, as written, cannot be used to benchmark Bun 1.2.23.
- ✅ Reusing the harness unchanged (per the spec instruction) means 1.2.23
  measurements are not directly comparable to the 1.3.x measurements.
- ✅ Any future attempt to characterize 1.2.23 must either fix the harness
  (e.g. force GC at end, hold a strong-rooted `held[]` outside the harness
  scope, sample `process.memoryUsage().external` plus RSS, or use a larger
  N so the signal dominates GC noise) or use a different methodology
  entirely.
- ✅ The ccflare-side mitigation (`response.body?.cancel()` on discard paths,
  scoped per `orchestrator/specs/bun-leak-273-mitigation.md`) is unaffected
  by this — it's measured on 1.3.14 which the harness handles correctly.

## Method (one paragraph)

The same `bench/bun-35093-harness.ts` from `a4328761` was invoked via
`/tmp/claude-501/bun-1.2.23/bun-darwin-x64/bun bench/bun-35093-harness.ts
{all|held|cancel}`, with `TARGET_URL` defaulted to the pinned 73 015-byte
lodash URL (the same body used in the 1.3.2 / 1.3.14 / `#35093` runs at this
commit), N=500, warmup=50. Per-request KB is
`(rss_after − rss_before) / N` where `rss_before` is sampled before the
N-iteration loop and `rss_after` after. No code was added or modified; the
harness is reused as the spec required.

## Raw artifacts

- `bench/results/1.2.23.json` — first run (all three cases, sequential in
  one client process, results in `consume → cancel → held` order).
- `bench/results/1.2.23-held-r2.json` — second run (held only), to confirm
  the held measurement is reproducible.
- `bench/results/1.2.23-held-r3.json` — third run (held only).
- `bench/results/1.2.23-cancel-r2.json` — re-run of cancel only.

## What I did NOT do

- I did not modify `bench/bun-35093-harness.ts` or any other tracked file
  in this worktree. The spec said do not rewrite the harness.
- I did not push the branch.
- I did not modify any ccflare production code.
- I did not touch `ccmax.zp.digital` or any live service.
- I did not attempt to obtain Bun 1.2.23 from any host other than the
  canonical GitHub release artifact (`github.com` is in the sandbox
  allowlist).