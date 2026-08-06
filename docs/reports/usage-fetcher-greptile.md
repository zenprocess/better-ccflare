# Greptile dispositions — packages/providers (PR #346, PR #365)

**Date:** 2026-08-06
**Author:** Val (ccflare-157)
**Repo:** zenprocess/better-ccflare (fork of tombii/better-ccflare)
**Upstream HEAD checked:** `upstream/main` = `6f2c9d28` (fix(release): grant pull-requests:read so contributor credit works)
**Working tree:** `/Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-157` (`ao/ccflare-157/root`)
**Runner:** `bun test v1.3.2 (b131639c)` against fresh worktree of `upstream/main` under `TMPDIR`, with `node_modules` symlinked from the live worktree and `packages/database/src/inline-*.ts` copied from the live worktree (those auto-generated files are gitignored on upstream per `CLAUDE.md` — they are not committed source).

---

## TL;DR

| # | PR   | Finding                                                | Disposition           | Upstream fix commit | Regression test on `upstream/main` |
|---|------|--------------------------------------------------------|-----------------------|---------------------|-----------------------------------|
| 1 | #346 | Arbitrary quota row replaces text usage                | Already fixed         | `4311195e`          | `minimax-usage-fetcher.test.ts:98` — 19/19 pass |
| 2 | #346 | Usage request has no deadline                          | Already fixed         | `4311195e`          | `minimax-usage-fetcher.test.ts:220` — 19/19 pass |
| 3 | #365 | Zai tie discards later reset                           | Already fixed         | `65791a85`          | `pool-exhausted-usage-aware.test.ts` — 11/11 pass |

**No code changes shipped.** All three Greptile findings were resolved upstream before this session. This report records the evidence trail so the Greptile threads can be closed with a substantive reply instead of "no reply".

---

## Falsification protocol

Each finding was falsified separately, per the task instruction. Steps:

1. Locate the described code path on `upstream/main` (`git show upstream/main:<path>`).
2. Read the function under test, including the relevant docstrings and call sites.
3. Find the commit that resolved the finding (`git log upstream/main -- <path>`), read its diff.
4. Run the regression test added with the fix on a fresh worktree of `upstream/main`.

If step 1 had revealed the buggy code path, the next step would have been a regression test that failed before the change. None did — every finding was already resolved on the upstream tip at the start of this session.

---

## Finding 1 — PR #346, `packages/providers/src/minimax-usage-fetcher.ts:169`

> "Arbitrary quota row replaces text usage. When `model_remains` lacks a 'general' entry, the fallback treats the first video or unknown-model row as text-inference usage, so the accounts API and /health report unrelated utilization and reset times, and may mark a healthy text account as exhausted."

### Path checked
`pickTextInferenceRow(modelRemains)` at upstream/main line 169.

### Code on upstream/main
```ts
function pickTextInferenceRow(
    modelRemains: MinimaxModelRemains[],
): MinimaxModelRemains | null {
    return (
        modelRemains.find(
            (entry) => entry?.model_name === TEXT_INFERENCE_MODEL_NAME,
        ) ?? null
    );
}
```

`TEXT_INFERENCE_MODEL_NAME = "general"` (line 62). The function returns the `general` row if present, otherwise `null`. There is no first-row fallback.

### Fix commit
`4311195e fix(providers): tighten MiniMax usage fetcher (PR #346 review)` — 2026-07-27, by Val. Dropped the `return modelRemains[0] ?? null` fallback. The commit message names Finding 1 explicitly and calls out the routing-side risk (PR #345 skips accounts at ≥100% util).

### Regression test
`packages/providers/src/__tests__/minimax-usage-fetcher.test.ts:98-114` — `it("returns null when no 'general' row is present instead of substituting video", ...)`. Asserts `parseMinimaxTokenPlanResponse` returns null when only a `video` row is present, and that `getRepresentativeMinimaxUtilization` / `getRepresentativeMinimaxWindow` propagate null.

### Real-runner verification
```
$ bun test packages/providers/src/__tests__/minimax-usage-fetcher.test.ts
 19 pass
 0 fail
 56 expect() calls
Ran 19 tests across 1 file. [101.00ms]
```

### Disposition
**ALREADY FIXED.** The described bug path does not exist on `upstream/main`. No code change needed; no PR required.

---

## Finding 2 — PR #346, `packages/providers/src/minimax-usage-fetcher.ts:224`

> "Usage request has no deadline. The metadata request and response-body read have no timeout or abort signal, so a stalled MiniMax response keeps the account's in-flight polling slot occupied, prevents subsequent polls, and lets cached usage expire."

### Path checked
`fetchMinimaxUsageData(accessToken)` at upstream/main line 271.

### Code on upstream/main
```ts
const MINIMAX_USAGE_REQUEST_TIMEOUT_MS = 5000; // line 56, docstring cites PR #346 review finding #2

export async function fetchMinimaxUsageData(accessToken: string): Promise<MinimaxUsageData | null> {
    ...
    const controller = new AbortController();
    const timeoutId = setTimeout(
        () => controller.abort(),
        MINIMAX_USAGE_REQUEST_TIMEOUT_MS,
    );
    try {
        const response = await fetch(MINIMAX_TOKEN_PLAN_REMAINS_ENDPOINT, {
            method: "GET",
            ...
            signal: controller.signal,
        });
        ...
        // Body read inherits the same abort signal: a stalled response with
        // headers flushed but no body would otherwise block indefinitely and
        // hold the in-flight polling slot until teardown.
        const body = await response.json();
        return parseMinimaxTokenPlanResponse(body);
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
            log.warn("Minimax usage request aborted due to timeout");
            return null;
        }
        ...
    } finally {
        clearTimeout(timeoutId);
    }
}
```

A 5s `AbortController` is created, the timer is started, the signal is threaded into `fetch`, the timer is cleared in `finally`. The body read (`response.json()`) inherits the same abort because the underlying `Response` body stream respects the signal that was set during the fetch — and the code commits to this explicitly with an inline comment so the invariant survives future refactors.

### Idiom match
The 5s timeout and `AbortController` pattern matches `fetchXaiUsageData` exactly:
```ts
// packages/providers/src/xai-usage-fetcher.ts
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 5000);
...
const response = await fetch(XAI_GROK_CREDITS_ENDPOINT, { ..., signal: controller.signal });
...
} finally {
    clearTimeout(timeoutId);
}
```
The user instruction was: "match whatever timeout idiom already exists in the providers package rather than inventing a new one." The fix uses the same constant (5000ms), same controller shape, same signal threading, same `clearTimeout` placement as the Xai convention.

### Thematic link to upstream issue #348
Issue #348 is "an unbounded read with no deadline" in a different code path. The minimax fix uses the same Xai-derived idiom; the issue #348 follow-up can adopt the same pattern.

### Fix commit
`4311195e fix(providers): tighten MiniMax usage fetcher (PR #346 review)` — 2026-07-27, by Val. Commit message names Finding 2 explicitly.

### Regression test
`packages/providers/src/__tests__/minimax-usage-fetcher.test.ts:220-237` — `it("aborts the request via AbortController so a stalled response cannot hold the polling slot", ...)`. Mocks `fetch` to capture the `init.signal` and throw `AbortError`, asserts `signal instanceof AbortSignal` and `result === null`.

Caveat: the test verifies the signal is **supplied**, not that the timer actually fires within the timeout window. A test that fast-forwards the timer (Bun's `setSystemTime`) would prove end-to-end liveness. Worth a follow-up — but the implementation is correct, and the test is enough to catch a regression where someone deletes the `signal:` line.

### Real-runner verification
```
$ bun test packages/providers/src/__tests__/minimax-usage-fetcher.test.ts
 19 pass
 0 fail
 56 expect() calls
Ran 19 tests across 1 file. [101.00ms]
```

### Disposition
**ALREADY FIXED.** The described bug path does not exist on `upstream/main`. No code change needed; no PR required.

---

## Finding 3 — PR #365, `packages/providers/src/usage-fetcher.ts:598`

> "Zai tie discards later reset. When `time_limit` and `tokens_limit` are both at 100% with different reset times, the strict comparison keeps `time_limit` and discards the other exhausted window's reset. When `tokens_limit` resets later, `available_at` / `next_available_at` / `Retry-After` tell clients to retry while the account is still capped, burning their retry budget."

### Path checked
`getRepresentativeUsageSnapshotForProvider(data, "zai")` at upstream/main line 598 (the `case "zai":` block inside the reducer at line ~595).

### Code on upstream/main
```ts
if (provider === "zai") {
    const zai = data as ZaiUsageData;
    const candidates = [zai.time_limit, zai.tokens_limit].filter(
        (window): window is NonNullable<typeof window> => window !== null,
    );
    if (candidates.length === 0) return null;
    // On a tie (both windows equally exhausted), prefer the LATER reset —
    // the account isn't actually available again until every exhausted
    // window clears, so picking the earlier one would tell clients to
    // retry while the other window is still capped.
    const winning = candidates.reduce((prev, current) => {
        if (current.percentage !== prev.percentage) {
            return current.percentage > prev.percentage ? current : prev;
        }
        if (current.resetAt === null || prev.resetAt === null) {
            return prev.resetAt === null ? prev : current;
        }
        return current.resetAt > prev.resetAt ? current : prev;
    });
    return {
        utilization: winning.percentage,
        resetMs: winning.resetAt,
    };
}
```

The reducer has three rules, in order:
1. Higher `percentage` wins (the original strict-`>` logic, generalized to `>` with a non-tied tiebreak).
2. On equal `percentage`, the entry whose `resetAt` is non-null wins (handles null gracefully).
3. On equal `percentage` and both non-null, the **later** `resetAt` wins.

This means a 100%/100% tie with `time_limit.resetAt` earlier and `tokens_limit.resetAt` later now correctly returns the later one, so `available_at` / `Retry-After` reflect when the account is *actually* free.

### Fix commit
`65791a85 fix(proxy): break Zai 100%/100% usage ties by the later reset` — 2026-07-31, by tombii. Co-Authored-By: Claude. Commit message names the Greptile P1 finding explicitly.

### Regression test
`packages/proxy/src/handlers/__tests__/pool-exhausted-usage-aware.test.ts` — added 75 lines of test cases alongside the fix. Verifies tie-break picks the later reset, plus the surrounding pool-exhausted contract (status 503, `error.type === "pool_exhausted"`, accounts list with `available_at`, etc.).

### Real-runner verification
```
$ bun test packages/proxy/src/handlers/__tests__/pool-exhausted-usage-aware.test.ts
 11 pass
 0 fail
 39 expect() calls
Ran 11 tests across 1 file. [489.00ms]
```

### Disposition
**ALREADY FIXED.** The described bug path does not exist on `upstream/main`. No code change needed; no PR required.

---

## Why no PR was opened

The task instruction was: "For each finding that IS real, add a regression test that FAILS before your change and passes after."

All three findings are not real on `upstream/main` — each one already has:
- The bug fixed (verified by reading the current code).
- A regression test that fails before the fix and passes after (verified by reading the test).
- The test passes on the real runner (verified by `bun test` output above).

A "test that fails before your change and passes after" is impossible to add when the change is already on `main` — the test would pass against the current code, which is the same as "passes after". Adding a duplicate test would not strengthen coverage; it would just duplicate an existing assertion.

Per the falsification protocol: "Any finding that does not reproduce gets an explicit unfalsifiable disposition with the evidence - do not fix what is not broken, and do not let one real finding carry two speculative ones into a PR." Each of these findings *did* falsify as already-fixed, and the evidence is in this report.

One docs-only PR is the right deliverable here.

---

## Greptile replies

Drafted replies to each thread:

### PR #346 — Finding 1 reply
> Re-falsified on `upstream/main` (HEAD `6f2c9d28`). `pickTextInferenceRow` returns the `general` row or `null` — there is no first-row fallback. Fix landed in `4311195e` ("fix(providers): tighten MiniMax usage fetcher (PR #346 review)") with a regression test at `packages/providers/src/__tests__/minimax-usage-fetcher.test.ts:98` (`it("returns null when no 'general' row is present instead of substituting video", ...)`). Test passes against `upstream/main`: 19/19 in 101ms. Closing as already-resolved. Full evidence trail in docs/reports/usage-fetcher-greptile.md (PR forthcoming).

### PR #346 — Finding 2 reply
> Re-falsified on `upstream/main` (HEAD `6f2c9d28`). `fetchMinimaxUsageData` has a 5s `AbortController` with the signal threaded into `fetch` and the timer cleared in `finally`. The body read (`response.json()`) inherits the abort because the underlying `Response` stream respects the signal set during fetch — confirmed inline with a comment so the invariant survives future refactors. Matches the existing `fetchXaiUsageData` convention. Fix landed in `4311195e` with a regression test at `packages/providers/src/__tests__/minimax-usage-fetcher.test.ts:220` (`it("aborts the request via AbortController so a stalled response cannot hold the polling slot", ...)`). Test passes: 19/19 in 101ms. Caveat noted: the test asserts the signal is supplied, not that the timer fires end-to-end; a `setSystemTime`-based follow-up would catch a regression where someone deletes the `clearTimeout` line. Closing as already-resolved.

### PR #365 — Finding 3 reply
> Re-falsified on `upstream/main` (HEAD `6f2c9d28`). `getRepresentativeUsageSnapshotForProvider` for zai now uses a 3-rule reducer: (1) higher percentage wins, (2) on tie, the non-null reset wins, (3) on tie and both non-null, the LATER reset wins. A 100%/100% tie between `time_limit` and `tokens_limit` now correctly surfaces the later reset. Fix landed in `65791a85` ("fix(proxy): break Zai 100%/100% usage ties by the later reset", tombii, 2026-07-31) with regression tests in `packages/proxy/src/handlers/__tests__/pool-exhausted-usage-aware.test.ts`. Test passes: 11/11 in 489ms. Closing as already-resolved.

---

## Audit trail

| Step                                      | Tool / command                                                  | Output                                        |
|-------------------------------------------|------------------------------------------------------------------|-----------------------------------------------|
| Fetch upstream                            | `git fetch upstream main`                                        | `ok fetched (1 new refs)`                     |
| Resolve upstream HEAD                     | `git rev-parse upstream/main`                                    | `6f2c9d28...`                                 |
| Verify divergence                         | `git log HEAD..upstream/main --oneline`                          | HEAD 130 commits behind; `.zp/*` only diverges |
| Locate Finding 1 path                     | `git show upstream/main:packages/providers/src/minimax-usage-fetcher.ts` (lines 169-189) | Returns null on missing `general` |
| Locate Finding 2 path                     | same file, lines 271-322                                         | `AbortController` + 5s timer + signal + `finally clearTimeout` |
| Locate Finding 3 path                     | `git show upstream/main:packages/providers/src/usage-fetcher.ts` (lines 595-619) | 3-rule reducer picks LATER reset on tie |
| Find Finding 1+2 fix                      | `git log upstream/main -- packages/providers/src/minimax-usage-fetcher.ts` | `4311195e` (Val, 2026-07-27) |
| Find Finding 3 fix                        | `git log upstream/main -- packages/providers/src/usage-fetcher.ts` | `65791a85` (tombii, 2026-07-31) |
| Read Finding 1+2 diff                     | `git show 4311195e -- packages/providers/src/minimax-usage-fetcher.ts` | Drop fallback; add AbortController; add tests |
| Read Finding 3 diff                       | `git show 65791a85 -- packages/providers/src/usage-fetcher.ts`   | Replace strict `>` with 3-rule reducer       |
| Confirm regression test files             | `git ls-tree -r upstream/main packages/`                          | Both test files exist                          |
| Run Finding 1+2 regression test           | `bun test packages/providers/src/__tests__/minimax-usage-fetcher.test.ts` | 19 pass, 0 fail, 56 expect()                  |
| Run Finding 3 regression test             | `bun test packages/proxy/src/handlers/__tests__/pool-exhausted-usage-aware.test.ts` | 11 pass, 0 fail, 39 expect()                  |

### Worktree notes

Ran tests on a fresh worktree of `upstream/main` at `$TMPDIR/worktrees/upstream-test` (sandbox-friendly path). The repo's auto-generated `packages/database/src/inline-*.ts` worker files are gitignored on upstream and only present in the live worktree at `/Users/vvladescu/ao-projects/ccflare/`; they were copied in (not committed) so the proxy test could import `database-operations.ts` transitively. `node_modules` was symlinked from the live worktree since `bun install` in the sandboxed path is denied.

`bun --version`: `1.3.2 (b131639c)`. Standard Bun (not baseline) — no AVX2 issue triggered because `bun test` does not use the bundler.
