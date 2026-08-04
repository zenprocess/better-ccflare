# ccflare-272 — payload-distiller first tests + PR

Lane: implementation worker. Deliverable: OPEN PR plus green tests.
This report is the handoff artifact for the orchestrator to re-run.

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

## Commit and push

```
$ git log -1 --oneline
6dff1250 test(distiller): first tests for payload-distiller + minimal refactor

$ git push origin feat/dreaming-rollup-and-pg-prune
   cdb61259..6dff1250  feat/dreaming-rollup-and-pg-prune -> feat/dreaming-rollup-and-pg-prune
```

Files changed:
- `scripts/payload-distiller.ts` (refactor: export `parseArgs`, `scrubSecrets`,
  `getEngramToken`, `Args`; extract `jsonColumnExpression(rollupOnly)` and
  `postRollupAndMark(rollup, ids, args, runId, postFn, markFn)`; wrap `main()`
  invocation in `import.meta.main`. The `'{}'::text AS json` body-skip is
  preserved so a full-corpus pass never loads payload bodies.)
- `scripts/payload-distiller.test.ts` (new, 22 tests).

## bun test invocations and real assertion/pass counts

### A. New distiller tests

```
$ bun test scripts/payload-distiller.test.ts
```

```
 22 pass
 0 fail
 39 expect() calls
Ran 22 tests across 1 file. [1.17s]
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

4. Token resolution (`getEngramToken`, 2 tests) + Bearer redaction (`scrubSecrets`, 3 tests):
   - env var wins (literal fake value `test-token-not-real`)
   - spawn fallback throws cleanly when both env and `PATH` are absent
     (PATH stubs to a guaranteed-empty dir so `cal-infisical` never executes)
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
Ran 17 tests across 2 files. [2.59s]
```

### Combined run (the brief's single acceptance command)

```
$ bun test scripts/payload-distiller.test.ts packages/database/src/prune-gate.test.ts packages/runtime-server/src/prune-alerts.test.ts
```

```
 39 pass
 0 fail
 111 expect() calls
Ran 39 tests across 3 files.
```

## PR created on the correct target repo

```
$ gh pr view --repo zenprocess/better-ccflare 18  (REST API; gh pr create output)
created #18 https://github.com/zenprocess/better-ccflare/pull/18
```

Target proof (`gh api repos/zenprocess/better-ccflare/pulls/18`):

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
  "is_cross_repo": false
}
```

- `--repo zenprocess/better-ccflare` was passed explicitly to `gh pr create`
  (the repo-targeting guard).
- `head_repo` and `base_repo` are both `zenprocess/better-ccflare`. Not pushed
  to `upstream` (tombii/better-ccflare). Cross-repo is `false`.
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

## PR body (verbatim from gh pr create)

```
Track ao-company #272.

Adds the first tests for scripts/payload-distiller.ts and a minimal, behavior-preserving refactor so the exportable surface is testable.

Tests (bun test scripts/payload-distiller.test.ts):
  - parseArgs: --rollup-only, --only-failed, --dry-run (alone and combined); DATABASE_URL-absent error path; --scope validation; unknown arg rejection.
  - jsonColumnExpression: rollup-only mode returns the '{}'::text AS json OOM guard; normal mode returns rp.json.
  - postRollupAndMark: rollup-only + failed POST leaves rows unmarked; rollup-only + successful POST marks rows in order; ordering guarantee (mark runs strictly after POST resolves); dry-run + rollup-only does not call postFn or markFn but counts ids as would-mark; non-rollup-only POSTs but does not mark; markFn throw propagates so the caller can abort.
  - getEngramToken: env var wins (literal fake value 'test-token-not-real'); spawn fallback throws cleanly when both env and PATH are absent (PATH is stubbed to a guaranteed-empty dir so cal-infisical never executes).
  - scrubSecrets: redacts Bearer tokens of >=16 chars (header form and embedded-in-payload form); leaves short tokens alone.

Refactor (scripts/payload-distiller.ts):
  - export parseArgs, scrubSecrets, getEngramToken, Args.
  - extract jsonColumnExpression(rollupOnly) returning the SQL fragment string.
  - extract postRollupAndMark(rollup, ids, args, runId, postFn, markFn) so the POST-then-mark ordering is testable with mocked fetch/insert.
  - wrap main() invocation in import.meta.main so tests can import the module.
  - The '{}'::text body-skip is preserved so a full-corpus pass never loads payload bodies.

bun test scripts/payload-distiller.test.ts
  22 pass, 0 fail, 39 expect() calls
bun test packages/database/src/prune-gate.test.ts packages/runtime-server/src/prune-alerts.test.ts
  17 pass, 0 fail, 72 expect() calls (no regression on adjacent suites)

DO NOT MERGE: deliverable ends at the OPEN PR. Merging onto main is an operator/control-plane lane decision (cdb61259 is pinned by an ao-company scheduled job).
```

## Acceptance command (single command the orchestrator re-runs)

```
bun test scripts/payload-distiller.test.ts packages/database/src/prune-gate.test.ts packages/runtime-server/src/prune-alerts.test.ts
```

Exit 0 + non-zero real assertion counts + presence of an OPEN PR on
`zenprocess/better-ccflare` against base `main` from head
`feat/dreaming-rollup-and-pg-prune` ⇒ task complete.
