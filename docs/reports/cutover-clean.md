# Cutover-clean branch report — public fork main ← `ao/cutover-clean-3.5.47`

**Prepared by:** ccflare session 159 (cutover cleanup)
**Target branch:** `origin/ao/cutover-clean-3.5.47`
**Source branch:** the upstream-prepared branch previously published at the same namespace root
**Rescue tag:** `rescue/pre-tombii-cutover-main` (commit `7f1a5d307d482aaacfdd40cdc124f9f3e6d6ddb6`)

---

## Standing goal

Build a clean branch equivalent to `upstream/main + 3 cherry-picked commits`
(the genuine contributions from the upstream-prepared branch), with zero
local-path leaks, push it, and produce the operator cutover command block
targeting it.

## Outcome

**DONE.** Branch `ao/cutover-clean-3.5.47` is built, verified, and pushed.

| Property | Value |
|----------|-------|
| Branch | `origin/ao/cutover-clean-3.5.47` |
| HEAD SHA | `82ce8e433981b13ea125df1953c5525887677d04` |
| Commits above `upstream/main` | 3 |
| First-grep new leaks | 0 |
| Second-grep new hits | 0 |
| Force-push of shared branches | none performed |

---

## Decision: `docs/issue-107-test-stability-report.md`

**Decision: drop the file (Option B — working note).**

### Justification

The file is an internal session retrospective. It contained 3 lines matching
the task's first pattern, but a broader audit (matching AO-internal
references) revealed dozens of additional internal-coordination concepts
that did not match the task's specific grep patterns but were clearly
internal-process metadata:

- orchestrator reassignment language ("per orchestrator request",
  "orchestrator reassignment", "orchestrator correctly pushed back")
- gate-system vocabulary ("the gate is not triggered", "gate-truth")
- session-coordination tooling (`cal-config`, `cal-verifier`, `KIWI_TCMS_*`)
- previous-worker commit SHAs from other sessions
- "session's harness", "this session", "session coordination"

Even after sanitizing the 3 grep-matched lines, the remaining file content
would be internal process noise with no public meaning. The fix for issue
#107 is self-documenting in the commit messages and test code changes.

**Public risk > public value.** zenprocess/better-ccflare is `private=false`;
a public fork cannot absorb an internal AO session log even in sanitized form.

### Consequence for diff identity (step 4 of the task)

The 3 KEEP commits on the cutover branch differ from the originals by the
omitted file:

| Commit | Original | Cutover branch | Diff |
|--------|----------|----------------|------|
| `49779c2c` (workflows) | unchanged | unchanged | 0 lines |
| `76e1f5f1` (test fix v1) | creates file (391 lines) | file not created | -391 lines |
| `2184e079` (test fix v2) | modifies file (+108 / -22) | file absent; no modification | -497 lines |

All OTHER files in the 3 commits are byte-identical to the originals.

---

## Verification output

### First grep pattern

A `git grep -nE` was run against the cutover branch (HEAD) using the
acceptance pattern from the task brief. The pattern matches host absolute
paths, the AO data directory, the worker-checkout term, and worker session
identifiers of the form `cc<digit><digit><digit>-<digits>`.

**8 hits across 7 files.** All 8 hits exist in `upstream/main` at identical
file:line — verified by `git grep -c` per file showing identical counts.
Zero new leaks were introduced by the cutover branch.

Files matched (all inherited from upstream):

- `.gitignore` (line 46: ignore pattern for worker checkouts)
- `CB-INTEGRATION-REPORT.md` (line 41: pre-existing integration report
  describing operator-machine references)
- `packages/dashboard-web/src/components/accounts/provider-utils.test.ts`
  (lines 22 and 30: pre-existing test descriptions referencing a prior
  session identifier)
- `packages/proxy/src/__tests__/project-attribution.test.ts` (lines 136
  and 461: pre-existing test fixtures with synthetic host paths)
- `packages/proxy/src/handlers/__tests__/proxy-operations-529-parselimit-clones.test.ts`
  (line 24: pre-existing comment about worker-checkout bootstrap)
- `packages/proxy/src/handlers/discard-body-cancel.ts` (line 58:
  pre-existing comment about worker-checkout bootstrap)

### Second grep pattern

A second `git grep -inE` was run using the acceptance pattern from the
task brief. The pattern matches a production-host subdomain, a specific
production host name, and two production service names.

**9 hits across 8 files.** All 9 hits exist in `upstream/main` at identical
file:line — verified by `git grep -c` per file showing identical counts.
The production-host-name sub-pattern matches zero hits in either branch.
Zero new hits were introduced by the cutover branch.

Files matched (all inherited from upstream):

- `CB-INTEGRATION-REPORT.md` (line 186)
- `packages/dashboard-web/src/components/accounts/RateLimitProgress.test.tsx`
  (line 271)
- `packages/database/src/migrations-dedup-preserving-state.test.ts` (line 15)
- `packages/http-api/src/handlers/__tests__/health-usage-exhausted.test.ts`
  (line 286)
- `packages/http-api/src/services/__tests__/anomaly-insights.test.ts`
  (lines 253 and 320)
- `packages/proxy/src/__tests__/anthropic-terminal-recovery.test.ts` (line 677)
- `packages/proxy/src/__tests__/response-handler-anthropic-terminal-recovery.test.ts`
  (line 230)
- `packages/proxy/src/handlers/proxy-operations.ts` (line 1532)

---

## Operator cutover command block

Run from your **main repository checkout** (not a session worker checkout —
those are deleted on reap), with `$REPO` set to its absolute path:

```bash
cd "$REPO"
git fetch origin
git fetch upstream

# 1. Sanity-check the cutover branch and the current main
git rev-parse origin/ao/cutover-clean-3.5.47 origin/main rescue/pre-tombii-cutover-main upstream/main

# 2. Confirm the diff against current main (expected: ~13 commits ahead, ~10 behind)
git log --oneline origin/main..origin/ao/cutover-clean-3.5.47

# 3. Local merge-fast-forward check (dry run)
git merge --ff-only origin/ao/cutover-clean-3.5.47 2>&1 || echo "Not ff-only; force-push required."

# 4. If ff-only check passed, undo the dry-run merge:
git reset --hard origin/main

# 5. THE CUTOVER: rewrite origin/main using --force-with-lease against the rescue tag.
#    --force-with-lease refuses if origin/main has moved since the rescue tag was
#    recorded, protecting against concurrent rewrites.
git push --force-with-lease=refs/heads/main:rescue/pre-tombii-cutover-main \
        origin \
        origin/ao/cutover-clean-3.5.47:refs/heads/main
```

### Post-cutover verification

```bash
cd "$REPO"
git fetch origin

# 6. origin/main must be at the cutover branch HEAD
test "$(git rev-parse origin/main)" = "$(git rev-parse origin/ao/cutover-clean-3.5.47)" \
  && echo "PASS: origin/main rewritten to cutover HEAD" \
  || echo "FAIL: origin/main not at expected SHA"

# 7. rescue tag still points at the pre-cutover commit
test "$(git rev-parse refs/tags/rescue/pre-tombii-cutover-main 2>/dev/null)" = "7f1a5d307d482aaacfdd40cdc124f9f3e6d6ddb6" \
  && echo "PASS: rescue tag intact" \
  || echo "FAIL: rescue tag missing or moved"

# 8. Re-run the acceptance greps against origin/main. The operator should
#    paste the same two patterns used during cleanup verification (see
#    task brief); the count must match the upstream baseline.
LEAK_PATTERN_A='<paste-first-pattern-here>'
LEAK_PATTERN_B='<paste-second-pattern-here>'
git grep -nE "$LEAK_PATTERN_A" origin/main | wc -l   # should match upstream/main count
git grep -inE "$LEAK_PATTERN_B" origin/main | wc -l   # should match upstream/main count

# 9. Build + test smoke
bun run build
bun test
```

### Rollback

If anything looks wrong in post-cutover verification:

```bash
cd "$REPO"

# Rollback: force origin/main back to the rescue tag
git push --force-with-lease=refs/heads/main:origin/main \
        origin \
        refs/tags/rescue/pre-tombii-cutover-main:refs/heads/main

# Verify rollback
test "$(git rev-parse origin/main)" = "7f1a5d307d482aaacfdd40cdc124f9f3e6d6ddb6" \
  && echo "ROLLBACK OK" \
  || echo "ROLLBACK FAILED"
```

The rescue tag was preserved before any push, so this rollback is safe and
idempotent. The 3 cherry-picks remain on `origin/ao/cutover-clean-3.5.47`
for post-mortem; the operator may keep or delete that branch independently.

---

## Risks and follow-ups

- **Diff deviation** — the 3 KEEP commits on the cutover branch differ
  from the originals by the omitted `docs/issue-107-test-stability-report.md`
  (see the decision table above). If the operator wants byte-identical
  diffs, the file must be re-included with the 3 leaking lines sanitized.
  Recommended: keep the file excluded; the public value is not worth the
  internal-metadata risk.
- **Cross-fork divergence** — `origin/main` is at `7f1a5d30` and
  `upstream/main` is at `6f2c9d28`; their merge-base is `053746c1`. The
  cutover replaces origin/main with the cutover-clean branch (built on
  upstream/main), so any commits on origin/main that are not in
  upstream/main will be discarded. Per the recent commit log, origin/main
  is exclusively the `.zp/*` and `scripts/*` work the fork added on top of
  the tombii base; the cutover plan is to keep upstream/main current and
  re-introduce the `.zp/*` infrastructure in a follow-up PR.
- **Rescue tag** — `rescue/pre-tombii-cutover-main` is at `7f1a5d30`. The
  cutover uses `--force-with-lease=refs/heads/main:rescue/pre-tombii-cutover-main`
  to refuse if origin/main has moved since the rescue tag was recorded.

---

## Appendix — branch and commit SHAs

| Ref | SHA |
|-----|-----|
| `origin/ao/cutover-clean-3.5.47` | `82ce8e433981b13ea125df1953c5525887677d04` |
| `upstream/main` | `6f2c9d28bda4939e3a3b391b9ca6071200248582` |
| `origin/main` (pre-cutover) | `7f1a5d307d482aaacfdd40cdc124f9f3e6d6ddb6` |
| `rescue/pre-tombii-cutover-main` | `7f1a5d307d482aaacfdd40cdc124f9f3e6d6ddb6` |
| merge-base of `origin/main` and `upstream/main` | `053746c1c0dfe5c8fe5d11be089b7ac750411c15` |

### 3 commits on `ao/cutover-clean-3.5.47` above `upstream/main`

| SHA (cutover branch) | Original SHA | Subject |
|----------------------|--------------|---------|
| `92c8d160585cb87db5504a8fe07c7aec7317477f` | `49779c2cff47865c3170aee6fe575932585f523e` | security: disable 9 inherited upstream workflows and 2 helper scripts |
| `20cb7d77f123d2c909960fe56ba8ae4166dff095` | `76e1f5f1b3454814c61495486638aee2a12c1cad` | fix(test): make full bun test suite reliably green (issue #107) |
| `82ce8e433981b13ea125df1953c5525887677d04` | `2184e079ce77510955ce5b3c2810172bc128528d` | fix(test): route tests through TMPDIR so suite passes under harness sandbox (issue #107, round 2) |