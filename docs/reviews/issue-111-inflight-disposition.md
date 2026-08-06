# Issue #111 — In-flight disposition for the primary checkout

**Issue:** [ao-company#111](https://github.com/zenprocess/ao-company/issues/111) — *"[ccflare] [A+ P6] Land or drop the 10 dirty in-flight files and restore the primary checkout"*.
**Primary checkout:** `[operator-local-path]` (read-only from this worker's perspective).
**Worker session:** this AO worker.
**Triage date:** 2026-08-07.
**Salvage branch:** [`ao/ccflare-165/inflight-salvage`](https://github.com/zenprocess/better-ccflare/tree/ao/ccflare-165/inflight-salvage) — pushed to `zenprocess/better-ccflare` (the public fork).

---

## 1. State of the primary checkout at triage time

The issue's 2026-07-31 snapshot described 10 `MM` files on `fix/runaway-loop-session-key`. By the time this worker inspected it on 2026-08-07, the primary checkout had moved: branch `ao/ccflare-<scrubbed>/test-stability-cherrypick` (3 commits ahead of `origin/main`), 23 modified/untracked entries in `git status --porcelain`:

- 22 `MM` test files (all `bUN` test files; the same scope as PR #386)
- 2 `D ` (staged-deletion) docs: `docs/issue-107-test-stability-report.md`, `docs/reports/upstream-test-fixes.md`
- 2 `??` (untracked) reports: `docs/reports/348-idle-timer-brief.md`, `docs/reports/348-regression-risks.md`
- 1 `??` (untracked) `.ao/` directory tree containing `.ao/<scrubbed>/sani-trace.js`

Reasons for the divergence: between the issue filing (2026-07-31) and now (2026-08-07), session `ao/ccflare-<scrubbed>/test-stability-cherrypick` cherry-picked upstream test-stability work, opened PR #386, and the primary checkout accumulated post-PR-#386 confirmation noise. The original `fix/runaway-loop-session-key` branch still exists locally (`a3f6b99d`) but its content is **already on `origin/main`** via a different commit (`c57ffe7d`) — see §3 below.

---

## 2. Classified table

Every dirty path from `git -C [operator-local-path] status --porcelain` (read-only capture). "MM" = staged-then-modified; "D " = staged-deletion; "??" = untracked.

| # | Path (status) | Classification | Where it belongs | Evidence |
|---|---|---|---|---|
| 1 | `__tests__/api-auth.test.ts` (MM) | **REDUNDANT** | — | Working tree matches `origin/main` (diff against `origin/main` = 1 line noise). PR #386 (`060b9d23`) merged the same TMPDIR routing on 2026-08-06. |
| 2 | `apps/cli/__tests__/cli.test.ts` (MM) | **REDUNDANT** | — | Working tree matches `origin/main`. Same PR #386. The 44-line unstaged half re-applies `createdDbPaths` + `BETTER_CCFLARE_DB_PATH` set + file-scope `afterEach` that PR #386 brought in via `060b9d23` + `da1c0269`. The 43-line staged half is the inverse — local undo/redo noise. |
| 3 | `packages/cli-commands/src/commands/__tests__/account-remove-duplicate-guard.test.ts` (MM) | **REDUNDANT** | — | Same shape as #1 (1 line change to `${process.env.TMPDIR \|\| "/tmp"}/…`). On `origin/main`. |
| 4 | `packages/cli-commands/src/commands/__tests__/nanogpt-account.test.ts` (MM) | **REDUNDANT** | — | Same shape. On `origin/main`. |
| 5 | `packages/cli-commands/src/commands/__tests__/qwen-account-reauth.test.ts` (MM) | **REDUNDANT** | — | Working tree matches `origin/main`. The 23-line addition (`actualQwen` capture + `afterAll` restore) is the exact cross-file `mock.module` pollution fix PR #386 cherry-picked from the ccflare fork. |
| 6 | `packages/database/src/adapters/bun-sql-adapter.ts` (MM) | **REDUNDANT** | — | Working tree matches `origin/main`. The `try/catch` around `PRAGMA wal_checkpoint(TRUNCATE)` is verbatim PR #386 commit content. |
| 7 | `packages/http-api/src/handlers/__tests__/account-add-duplicate-guard.test.ts` (MM) | **REDUNDANT** | — | Same shape as #1. On `origin/main`. |
| 8 | `packages/http-api/src/handlers/__tests__/account-remove-handler.test.ts` (MM) | **REDUNDANT** | — | Same shape. On `origin/main`. |
| 9 | `packages/http-api/src/handlers/__tests__/kilo.test.ts` (MM) | **REDUNDANT** | — | Same shape. On `origin/main`. |
| 10 | `packages/http-api/src/handlers/__tests__/model-mappings-update.test.ts` (MM) | **REDUNDANT** | — | Same shape. On `origin/main`. |
| 11 | `packages/http-api/src/handlers/__tests__/nanogpt.test.ts` (MM) | **REDUNDANT** | — | Same shape. On `origin/main`. |
| 12 | `packages/http-api/src/handlers/__tests__/oauth.test.ts` (MM) | **REDUNDANT** | — | Working tree matches `origin/main`. The 34-line addition (`actualProxy` / `actualCodex` / `actualQwen` capture + `afterAll` restore + 4 TMPDIR DB paths) is the cross-file `mock.module` pollution fix PR #386 brought in. |
| 13 | `packages/http-api/src/handlers/__tests__/requests.test.ts` (MM) | **REDUNDANT** | — | Same shape as #1. On `origin/main`. |
| 14 | `packages/providers/src/providers/bedrock/__tests__/error-handler.test.ts` (MM) | **REDUNDANT** | — | Same shape. On `origin/main`. |
| 15 | `packages/proxy/src/__tests__/token-refresh-hierarchy.test.ts` (MM) | **REDUNDANT** | — | Same shape. On `origin/main`. |
| 16 | `packages/proxy/src/__tests__/usage-collector-attribution-tristate.test.ts` (MM) | **REDUNDANT** | — | Same shape. On `origin/main`. |
| 17 | `packages/proxy/src/__tests__/usage-collector-payload-meta.test.ts` (MM) | **REDUNDANT** | — | Same shape. On `origin/main`. |
| 18 | `packages/proxy/src/handlers/__tests__/agent-interceptor.precedence.test.ts` (MM) | **REDUNDANT** | — | Same shape. On `origin/main`. |
| 19 | `packages/proxy/src/handlers/__tests__/agent-interceptor.rewrite-guard.test.ts` (MM) | **REDUNDANT** | — | Same shape. On `origin/main`. |
| 20 | `packages/proxy/src/handlers/__tests__/agent-interceptor.security.test.ts` (MM) | **REDUNDANT** | — | Same shape. On `origin/main`. |
| 21 | `docs/issue-107-test-stability-report.md` (D + ??) | **REDUNDANT** | — | `origin/main` has the same file at the same path (PR #386 brought it in via `eb163fce`). Staged-deletion + untracked copy cancel out — checkout main and the file is there. |
| 22 | `docs/reports/upstream-test-fixes.md` (D + ??) | **LAND (fork-only)** | ccflare-fork session `ccflare-<scrubbed>` audit | Not on `origin/main`. ccflare-<scrubbed> session log explaining the PR #386 cherry-pick rationale + falsify steps. Useful for the fork's audit trail; never upstream. |
| 23 | `docs/reports/348-idle-timer-brief.md` (??) | **LAND (fork-only)** | ccflare-fork issue #348 design brief | Not on `origin/main`. Design brief for `tombii/better-ccflare#348` (body-stream idle timer). Out of scope for #111 but worth preserving for future work on #348. |
| 24 | `docs/reports/348-regression-risks.md` (??) | **LAND (fork-only)** | ccflare-fork issue #348 adversarial analysis | Not on `origin/main`. Adversarial regression risks against the default-on body-idle timeout proposal. Same scope as #23. |
| 25 | `.ao/` (??) | **DROP** | — | AO session metadata. Internal CC company infrastructure identifier — must never reach a public repo. `.gitignore` does **not** currently cover `.ao/` (hygiene gap to fix separately — see §5). |

**Counts:** `REDUNDANT = 21` (19 test files + 1 docs file + 1 unused staged-deletion entry), `LAND = 3` (all fork-only), `DROP = 1` (`.ao/`).

(Counted by unique path. `git status --porcelain` reports 25 lines because the 2 `D `+`??` docs files each appear twice in the index-vs-worktree split.)

---

## 3. Note on the original issue's `fix/runaway-loop-session-key` branch

The issue's 2026-07-31 snapshot named `fix/runaway-loop-session-key` (1 commit ahead of main, SHA `a3f6b99d`) as the branch carrying the dirty work. By 2026-08-07:

- The branch still exists locally at `a3f6b99d` (untouched since 2026-07-31).
- The actual fix landed upstream via `c57ffe7d` *"fix(alerts): key runaway-loop detector on per-agent identity + configurable minRequests"* (a different commit with the same subject — apparently a re-cherry-pick or different PR route). The full title and intent match `a3f6b99d` exactly.
- The branch is also **3981 insertions behind** `origin/main` (the diff `fix/runaway-loop-session-key` → `origin/main` comprises 58 files — `.zp/project.yaml`, `Dockerfile.provenance`, `scripts/verify-live-build.*`, `docs/workflow-audit-114.md`, etc.). These are NOT changes the branch made — they are post-branch additions on `origin/main`.

**Recommendation:** delete the branch (`git branch -D fix/runaway-loop-session-key`) once the operator confirms the fix is present on `origin/main`. The fix is present (verified via `git log origin/main --grep "runaway-loop detector"`).

The issue's other ask — handling `.ao/fix/runaway-loop-session-key` — is superseded by the current `.ao/` content finding: the untracked `.ao/` directory still contains AO session metadata that should be `.gitignore`d and removed from the working tree. See §5.

---

## 4. Salvage branch

**Branch:** `ao/ccflare-165/inflight-salvage`, branched from `origin/main` (HEAD `7f1a5d30`).
**Pushed to:** `https://github.com/zenprocess/better-ccflare.git` (the public fork).
**Contents (3 files, 1191 insertions):**

| File | Source | Hygiene |
|---|---|---|
| `docs/reports/upstream-test-fixes.md` | Primary checkout untracked (215 lines) | Scrubbed: session IDs `ccflare-<scrubbed>` and `ccflare-<scrubbed>`. |
| `docs/reports/348-idle-timer-brief.md` | Primary checkout untracked (727 lines) | Scrubbed: `[operator-local-path]` → `[operator-local-path]`. |
| `docs/reports/348-regression-risks.md` | Primary checkout untracked (248 lines) | Clean (no hygiene hits). |

No PR opened from this branch, per the task instructions. The branch is a recovery location only — the operator can `git show` or `git checkout` individual files when needed.

---

## 5. Operator restore command block

Run from the primary checkout `[operator-local-path]`. This is a **destructive, controlled** sequence — it discards all staged changes, all unstaged changes, and removes the `.ao/` directory tree. Pre-flight and per-step confirmation are recommended.

```bash
# 0. Pre-flight: save what's not on the salvage branch (none — the 3 LAND files are already on ao/ccflare-165/inflight-salvage).
#    If you want a fresh local copy of the 3 LAND files first:
cd [operator-local-path]
git fetch origin ao/ccflare-165/inflight-salvage
git checkout origin/ao/ccflare-165/inflight-salvage -- \
  docs/reports/upstream-test-fixes.md \
  docs/reports/348-idle-timer-brief.md \
  docs/reports/348-regression-risks.md
# (These now appear as modified-but-not-staged because your branch has them deleted/staged.)
# Don't worry about it — the next step cleans up.

# 1. Discard all staged changes (reverts the staged reverts in the MM files
#    and the staged deletions of the docs files).
git restore --staged .

# 2. Reset working tree to HEAD. The 22 MM test files will now match HEAD
#    (which matches origin/main thanks to PR #386). The untracked 348-* and
#    upstream-test-fixes.md contents are preserved on the salvage branch;
#    the on-disk copies are removed here.
git checkout -- .

# 3. Remove the untracked tree that's not part of the salvage branch:
#    .ao/  (and any future AO session metadata).
#    SAFE TO RUN: the salvage branch does not contain .ao/ anywhere.
git clean -fd            # -d because .ao/ is a directory

# 4. Switch to main and fast-forward so the primary checkout is on main,
#    even with origin/main.
git switch main
git pull --ff-only origin main

# 5. Verify acceptance:
git status --porcelain | wc -l                  # expect 0
git branch --show-current                       # expect main
git rev-list --count origin/main..main          # expect 0
git ls-files | grep -c '^\.ao/'                 # expect 0

# 6. (Optional) Drop the dead fix branch now that its work is on origin/main.
git branch -D fix/runaway-loop-session-key

# 7. (Optional) Restore the 3 LAND files on a fork-only branch for the
#    ccflare-fork audit trail. The salvage branch already has them; this
#    step makes them a tracked branch on origin as well.
git fetch origin ao/ccflare-165/inflight-salvage
git switch -c fork-only/issue-111-audit-docs origin/main
git checkout origin/ao/ccflare-165/inflight-salvage -- \
  docs/reports/upstream-test-fixes.md \
  docs/reports/348-idle-timer-brief.md \
  docs/reports/348-regression-risks.md
git commit -m "chore: preserve cherry-pick-era audit + #348 reports (fork-only audit)"
git push -u origin fork-only/issue-111-audit-docs
```

**Rollback (if any step goes wrong):** every file staged for deletion or untracked is also on its respective commit on the cherry-pick branch:

```bash
# Recreate the previous dirty state from the cherry-pick branch HEAD:
git switch ao/ccflare-<scrubbed>/test-stability-cherrypick    # or: ca7e1836
# That's where the staged deletions and untracked files were last seen.
# The 3 LAND files are recoverable from origin/ao/ccflare-165/inflight-salvage:
git checkout origin/ao/ccflare-165/inflight-salvage -- \
  docs/reports/upstream-test-fixes.md \
  docs/reports/348-idle-timer-brief.md \
  docs/reports/348-regression-risks.md
```

The salvage branch on `zenprocess/better-ccflare` is the durable recovery — even if the cherry-pick branch is force-deleted, the 3 LAND files are preserved.

---

## 6. Hygiene gap (separate follow-up)

`.gitignore` on `origin/main` does not cover `.ao/`. The next AO-driven session that touches the ccflare repo should add:

```gitignore
# AO worker session metadata (never commit)
.ao/
```

This is out of scope for #111 but worth flagging. Once added, the `git clean -fd` step above will treat `.ao/` as an ignored path and remove it without prompting.

---

## 7. Verification log

Run from this worker's perspective, not the primary checkout:

```bash
# Salvage branch is reachable from origin (zero unpushed commits):
git rev-list --count ao/ccflare-165/inflight-salvage --not --remotes
# Expected: 0

# Hygiene scan on the diff against origin/main (zero hits expected):
#   Inspect the 4 files in `git diff --name-only origin/main...ao/ccflare-165/inflight-salvage`
#   for any internal infrastructure identifiers — internal hostnames, cc-internal
#   product names, local user paths, AO session paths, or AO session IDs.
#   Pattern lives in the orchestrator's runbook; do not paste it here.
#   Expected: none of the 4 files contain such identifiers.
```

Both checks pass (recorded in this worker's terminal output). The original
commit of this document quoted the hygiene regex verbatim in the verification
block — that commit is on origin as 71ec7b1d; a follow-up commit scrubs the
literal pattern. The pattern itself qualifies as an internal-infra leak when
published to a public repo, so the doc now describes the check by intent
instead.

---

## 8. What was at risk

If the primary checkout had been cleaned up by an automated sweep before this triage ran, the 3 LAND files would have been lost:

- The upstream-test-fixes.md audit log explaining the PR #386 cherry-pick rationale (a cherry-pick-era artifact)
- The 348-idle-timer-brief.md design brief (an issue #348 investigation)
- The 348-regression-risks.md adversarial analysis (an issue #348 follow-up)

None of these are on `origin/main` and none are referenced elsewhere. The salvage branch on the public fork is now the durable recovery location.
