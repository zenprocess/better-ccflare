# ccflare-272 — payload-distiller first tests + PR (REOPENED, hermeticity fix)

Lane: implementation worker. Deliverable: OPEN PR plus green tests.
This report is the handoff artifact for the orchestrator to re-run.

## Status: REOPENED with hermeticity fix

The orchestrator's independent unsandboxed re-run found the spawn-fallback
test was NOT hermetic — `cal-infisical` resolves via absolute path on the
Mac, so the PATH-scrub guard was insufficient. The fixed test injects
the spawn fn so the real binary cannot run in either environment.

## Step 0 — falsification (mandatory first action)

```
$ git merge-base --is-ancestor cdb612592414804c789e5a288776cd284acbf064 main; echo "exit=$?"
exit=1
```

Exit=1 confirms `cdb61259` is **NOT** an ancestor of `main`. The issue is
falsifiable; the work is justified.

## Evidence: no distiller tests existed at base cdb61259

```
$ git ls-tree -r cdb612592414804c789e5a288776cd284acbf064 | grep -i distiller
100644 blob 2402f42f62b87a7cfc40de28b7aeeca6c0962149	scripts/payload-distiller.ts
```

Only the source file. No `payload-distiller.test.ts` (or any distiller-shaped
test file) at the base commit. The brief's "expect zero test files" holds.

## Commits (all pushed, 0 unpushed)

```
$ git log --oneline cdb61259..HEAD
3d9c5be0 fix(distiller): make getEngramToken spawn-fallback test hermetic
64965886 chore(reports): ccflare-272 distiller-tests PR handoff
6dff1250 test(distiller): first tests for payload-distiller + minimal refactor
```

Files changed:
- `scripts/payload-distiller.ts` (refactor: export `parseArgs`, `scrubSecrets`,
  `getEngramToken`, `Args`; extract `jsonColumnExpression(rollupOnly)` and
  `postRollupAndMark(rollup, ids, args, runId, postFn, markFn)`; wrap `main()`
  invocation in `import.meta.main`; add `Spawner` injection to `getEngramToken`
  for hermetic testing. The `'{}'::text AS json` body-skip is preserved so a
  full-corpus pass never loads payload bodies.)
- `scripts/payload-distiller.test.ts` (new, 24 tests; hermetic spawn-fallback).
- `reports/ccflare-272-rollup-pr.md` (this file).

## bun test invocations and real assertion/pass counts

**Environment:** counts below were produced inside the **AO sandbox**
(where the bun test runner executes). The orchestrator will re-run on
the unsandboxed Mac. The fixed test is structurally identical in both
environments because the spawn fn is injected and the real binary
cannot run in either.

### A. New distiller tests

```
$ bun test scripts/payload-distiller.test.ts
```

```
 24 pass
 0 fail
 45 expect() calls
Ran 24 tests across 1 file.
```

Coverage (mapped to the brief's four required areas):

1. `parseArgs` (8 tests):
   - defaults rollupOnly=false
   - `--rollup-only` sets rollupOnly=true
   - `--only-failed` sets onlyFailed=true
   - `--dry-run` sets dryRun=true
   - `--rollup-only --only-failed --dry-run` all combine
   - DATABASE_URL-absent throws (with `--db-url` absent)
   - `--db-url` overrides a missing DATABASE_URL
   - `--scope` rejects disallowed characters; unknown args rejected

2. Query shape (`jsonColumnExpression`, 2 tests):
   - rollup mode returns the `'{}'::text AS json` OOM guard
   - normal mode returns `rp.json`

3. Marking order (`postRollupAndMark`, 6 tests):
   - rollup-only + failed POST → `markedIds == []`, `skipped == 3`, `distilled == 0`
   - rollup-only + successful POST → marks every row in order
   - rollup-only ordering: mark runs STRICTLY after POST resolves (event log)
   - dry-run + rollup-only → postFn NOT called, markFn NOT called, ids counted as would-mark
   - non-rollup-only → POST emitted but rows NOT marked
   - markFn throw propagates so the caller can abort

4. Token resolution (`getEngramToken`, **4 tests, all hermetic**) + Bearer redaction (`scrubSecrets`, 3 tests):
   - env var wins (literal fake value `test-token-not-real`); spawn NOT called
   - throws cleanly when neither env nor spawn is available; spawn IS called and the assertion verifies the injected closure was invoked (regression to direct `Bun.spawnSync` fails loudly)
   - happy-path fallback: returns the spawn's stdout when env is unset and the spawn succeeds
   - edge case: empty-string env does NOT short-circuit; spawn is still attempted
   - Bearer token redacted in Authorization header
   - Bearer token redacted when embedded in payload-derived text
   - short tokens (< 16 chars) are not over-matched

### B. Adjacent suites — no regression

```
$ bun test packages/database/src/prune-gate.test.ts packages/runtime-server/src/prune-alerts.test.ts
```

```
 17 pass
 0 fail
 72 expect() calls
Ran 17 tests across 2 files.
```

### Combined run (the brief's single acceptance command)

```
$ bun test scripts/payload-distiller.test.ts packages/database/src/prune-gate.test.ts packages/runtime-server/src/prune-alerts.test.ts
```

```
 41 pass
 0 fail
 117 expect() calls
Ran 41 tests across 3 files.
```

## Hermeticity verification (adversarial replay)

I verified the spawn-fallback test catches regressions by temporarily
replacing `spawnInfisical(...)` with a direct `Bun.spawnSync(...)` call
in `getEngramToken`. With the regression applied:

```
$ bun test scripts/payload-distiller.test.ts -t "getEngramToken"
 1 pass
 20 filtered out
 3 fail
 6 expect() calls
Ran 4 tests across 1 file.
```

The 3 failures confirm the test design:
- `spawnCalled` stays false (injected closure bypassed)
- The throws test fails because the real binary was actually invoked
- The empty-env test fails for the same reason

The baseline was restored; the current HEAD passes 24/24.

## PR created on the correct target repo

```
$ gh pr create --repo zenprocess/better-ccflare --base main --head feat/dreaming-rollup-and-pg-prune
created #18 https://github.com/zenprocess/better-ccflare/pull/18
```

Target proof (corrected — the brief's `baseRepository` is not a valid
`gh pr view --json` field; the orchestrator used `url + isCrossRepository`
which is the right approach):

```json
{
  "state": "open",
  "url": "https://github.com/zenprocess/better-ccflare/pull/18",
  "title": "test(distiller): first tests for payload-distiller",
  "head_repo": "zenprocess/better-ccflare",
  "head_owner": "zenprocess",
  "head_ref": "feat/dreaming-rollup-and-pg-prune",
  "base_repo": "zenprocess/better-ccflare",
  "base_owner": "zenprocess",
  "base_ref": "main",
  "isCrossRepo": false
}
```

- `--repo zenprocess/better-ccflare` was passed explicitly to `gh pr create`
  (the repo-targeting guard).
- `head_repo` and `base_repo` are both `zenprocess/better-ccflare`. Not pushed
  to `upstream` (tombii/better-ccflare). `isCrossRepo` is `false`.
- State is **OPEN**. Worker has not merged; the brief withholds merge authority.

## Stale "merged to main" line in the ao-company deploy doc

Per the brief, the orchestrator session should already be aware of this. The
worker did not modify the doc; the relic note is in the original work item
language about an old "merged to main" claim. Routing this is the
orchestrator's job (changes outside the worker's scope).

## Out-of-scope items (capability withheld, no attempt)

- **No merge.** The PR is OPEN. The brief withholds merge authority; the
  operator lane owns the merge strategy (true merge commit, not squash).
- **No `--dry-run --rollup-only` prod run against ccproxy2 via ssh zenstor.**
  The sandbox has no LAN ssh to zenstor and the token flow is Mac-side. A
  network denial there is the egress boundary working as designed.
- **No arming or stubbing of prune paths.** `scripts/prune-payloads-pg.ts`
  rides along as inert code; its env flag and arming file are an operator
  runbook.
- **No `.github/workflows` added.** No GitHub Actions in this repo; gating is
  bun test / qa-pipeline.
- **No issue close.** The orchestrator owns issue close after independent
  re-run of the acceptance commands.

## Token-hygiene evidence (orchestrator confirmed)

- The 3 high-entropy hits in the previous report were hex commit SHAs.
- `scripts/payload-distiller.test.ts` contains 0 token-shaped strings.
- `test-token-not-real` literal stub appears in 3 places (test only).
- No real token value reach git or stdout.

## Acceptance command (single command the orchestrator re-runs)

```
bun test scripts/payload-distiller.test.ts packages/database/src/prune-gate.test.ts packages/runtime-server/src/prune-alerts.test.ts
```

Exit 0 + non-zero real assertion counts + presence of an OPEN PR on
`zenprocess/better-ccflare` against base `main` from head
`feat/dreaming-rollup-and-pg-prune` ⇒ task complete.
