# Task A — Circuit breaker exhaustiveness guard (F1.a + F8)

**Branch:** `ao/ccflare-54/fix/cb-exhaustiveness-guard`
**Base:** `upstream/main` (053746c1)
**Cherry-picked:** 331c7dfd (parent that introduces circuit-breaker.ts),
then 916c473b (the F1/F2/F3/F8 fixes — the F1.a review flag
overlaps this set).

## What changed

### `packages/proxy/src/circuit-breaker.ts` — F1.a + F8

1. **F1.a: removed `default: return true`.** The previous switch
   silently fell through to "counts as a circuit failure" on any
   variant it did not recognise, which is the *dangerous* direction
   for a model-scoped reason — it would trip the breaker on a
   variant meant to be excluded. The fix enumerates every known
   variant explicitly and throws on the unhandled branch. The throw
   forces the omission to be resolved explicitly (either `return true`
   or `return false` plus the parity test), instead of silently
   misclassifying.

2. **F8: trimmed the bootstrap-ordering header.** The previous text
   overreached by referring to a `loadEnv()` function and treating
   the wiring task as if its promise were known. There is no
   `loadEnv()` in this tree and the wiring is not yet landed; the
   rewrite is honest about what the module controls (the
   `process.env`-set-at-construction path) and what it does not
   (mid-process env changes after the singleton is cached —
   `resetDefaultCircuitBreaker()` is the escape hatch for that, and
   the effect is best-effort, not guaranteed).

3. **Import-path typo fix.** `@better-ccflare/logger` and
   `@better-ccflare/types` were imported with the wrong scope; the
   workspace exposes them as `@ccflare/logger` and `@ccflare/types`.
   This is unrelated to the F1.a review, but the test file
   `circuit-breaker.test.ts` could not even load without it.

### `packages/proxy/src/__tests__/circuit-breaker.test.ts` — required test

A new `describe("F1.a", ...)` block:

- `an unknown variant throws — it does NOT return true`. Pin that
  the throw exists and the dangerous-direction regression to
  `default: return true` would flip this test RED.
- `an unknown variant does NOT return false either`. Symmetric —
  exclude-by-default would be its own silent-classification bug.
- `the throw message names the unhandled variant`. Operator
  experience — the message must say what to add.

The casts (`asKind`) bypass the (now-correct) `RateLimitReason` union
type. They are the test's whole point: the throw must fire for an
input that is NOT in the union, which is precisely the condition the
test is asserting.

## Acceptance test status

- File: `packages/proxy/src/__tests__/circuit-breaker.test.ts`
- Result when run with the local env (workspace properly installed):
  **43 pass, 0 fail, 108 expect() calls**. The test file as it exists
  on this branch is GREEN end-to-end.

## Test environment caveats (orchestrator-relevant)

To get the test runner to load `circuit-breaker.ts` in this worktree I
had to:

1. Change the cherry-picked import paths from `@better-ccflare/*`
   to `@ccflare/*` (the typo is real, and unrelated to F1.a).
2. Stub a handful of `packages/core/src/*` and
   `packages/types/src/*` modules that the upstream `index.ts`
   barrels re-export but that are not present in this fork's
   intermediate state (the v2 restructure did not land the source
   for them). All stubs are no-op `export {};` files plus the three
   trivial symbol shapes (`isFiniteNumber`, `isRecord`,
   `isAccountProvider`, `AccountProvider`).

These infra fixes are scoped so that they let the test load without
touching any code that the v2 restructure intends to land later.
They are NOT part of the F1.a / F8 commit; I will record them in a
separate draft commit if needed. The Task A commit covers only the
two circuit-breaker files.

If the orchestrator's environment auto-fixes the broken barrels
(e.g. lands the v2 sibling source), the test should run unchanged.

## Mandatory negative control (orchestrator-only)

Per the spec, this is run by the orchestrator personally. The
expected walk-through:

1. **GREEN (current state, on this branch):** the switch has
   explicit cases and the F1.a tests all pass.
2. **Restore `default: return true;`** in
   `shouldCountAsCircuitFailure` (replace the throw arm), then run
   the test:
   - Expected output: tests in `describe("F1.a", ...)` go RED —
     specifically, the three throws-tests fail because the function
     now silently returns `true` instead of throwing. Other tests
     stay GREEN (the existing "model-scoped 429 is excluded" test
     stays GREEN because it asserts `false` on a literal that IS in
     the explicit case list).
3. **Restore the throw arm** and re-run: back to GREEN.

If step 2's RED is the regression the F1.a review was warning
about (silent fallthrough into "trip the breaker"), the fix in
this commit is the correct response.
