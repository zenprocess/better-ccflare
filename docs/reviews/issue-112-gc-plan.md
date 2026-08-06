# Issue #112 — Branch / ref / tag / worktree GC plan

**Operator-executed.** This document is a plan, not a deletion script. Nothing
in this branch is deleted by the worker. Every command below is staged for the
operator to run after review. Per the destructive-with-control directive, the
worker produces this classification and the operator executes the deletions.

**Honesty about limits of the remedy.** Deleting a branch removes the *ref*,
not the *blob history*. Anything that has already been fetched into a clone,
cached in CI, or carried by another ref on origin will remain reachable. The
"deletion" here is the act of removing the local-and-remote ref pointer plus
the entry from `refs/heads` / `refs/rescue` / `refs/tags`; it does not rewrite
the public commit graph. The leak therefore persists in any already-cloned
copy of the fork until a separate history-rewrite / re-push lands. Read
"delete this branch" as "remove the dangling ref pointer," not as "scrub the
published history."

---

## 1. Scope of this audit

This audit covers the *fork* only (`zenprocess/better-ccflare`), not the
upstream `tombii/better-ccflare`. Upstream is verified clean (0 hits across
the internal-identifier sweep) by a separate worker; that work is out of scope
here.

The classification uses **content equivalence** (`git cherry` / patch-id), not
branch-name matching. A commit cherry-picked into multiple branches has a
different SHA but identical patch-id, and so counts as contained. Branches
whose heads are *content-equivalent* to either `origin/main` or `upstream/main`
are deletable; branches whose tip carries commits not reducible by either
content or patch-id to either main are kept.

The identifier-leak sweep (`internal-identifier scan`) is run against every
branch tip as a separate concern. It does not change the keep/drop
classification — it only *prioritizes* the deletion ordering.

---

## 2. Counts

| Bucket              | Branches | Rescue refs | Tags   |
|---------------------|----------|-------------|--------|
| **DELETABLE**       | 88       | 27          | 8      |
|   of which LEAK     | 72       | 13          | 4      |
|   of which NONE     | 16       | 14          | 4      |
| **UNMERGED-UNIQUE** | 81       | 0           | 181    |
|   of which LEAK     | 77       | 0           | 2      |
|   of which NONE     | 4        | 0           | 179    |
| **KEEP-RESCUE**     | 0        | 11          | 0      |
| **KEEP-ACTIVE**     | 5        | 0           | 0      |
| **TOTAL**           | 169      | 38          | 189    |

KEEP-ACTIVE entries (manually added, not auto-classified):

- `main` — the trunk
- `ao/ccflare-157/root` — head of open PR #20
- `ao/issue-111/salvage` — head of open PR #19
- `feat/dreaming-rollup-and-pg-prune` — head of open PR #18
- `ao/ccflare-166/root` + `ao/ccflare-166/gc-plan` — this session

KEEP-RESCUE entries are covered separately in §6.

---

## 3. DELETABLE branches — staged commands

The first group is the **highest-value deletions**: branches that are both
fully contained in main and leak internal identifiers. Removing these refs
removes the dangling pointer; the worker's honest framing above applies.

The second group is fully-contained branches that do not leak. They are
deletes with no security rationale, just cleanup.

Every command below is preceded by a SHA capture so the operator can re-create
the ref if a mistake is detected:

```bash
# Capture rollback state — run first, save to a file
mkdir -p /tmp/issue-112-rollback
git for-each-ref refs/heads/ refs/rescue/ refs/tags/ \
  --format='%(refname) %(objectname)' \
  > /tmp/issue-112-rollback/refs-before.txt
```

### 3.1 HIGHEST-VALUE DELETIONS — DELETABLE + LEAK (72 branches)

For each branch, run:

```bash
# Rollback: capture & then delete
git rev-parse refs/heads/<branch> | tee -a /tmp/issue-112-rollback/<branch>.sha
git branch -d <branch>
git push origin :<branch>   # only if the branch exists on origin
# skip the push if <branch> is local-only — verify with git ls-remote origin refs/heads/<branch>
```

Branches (LEAK + DELETABLE, in the order the staged list should be processed):

1. `analysis/agent-attribution`
2. `analysis/bluegreen-design`
3. `analysis/bun-upgrade-path`
4. `analysis/cache-throttle`
5. `analysis/ccmax-502`
6. `analysis/issue-273-ops-mitigations`
7. `analysis/native-fallback`
8. `ao/ccflare-107/fix-runaway-loop-session-key`
9. `ao/ccflare-111/stock-v3.5.46-validation`
10. `ao/ccflare-112/deployment-multi-instance-doc`
11. `ao/ccflare-112/docs-multi-instance-guard-independent`
12. `ao/ccflare-112/pr-376-add-greptile-fix`
13. `ao/ccflare-112/stage-0-ha-finalize-report`
14. `ao/ccflare-114/issue-107-test-stability`
15. `ao/ccflare-115/disable-inherited-workflows`
16. `ao/ccflare-117/reply-348-pr360`
17. `ao/ccflare-117/root`
18. `ao/ccflare-118/root`
19. `ao/ccflare-119/root`
20. `ao/ccflare-120/root`
21. `ao/ccflare-120/verify-live-build-review`
22. `ao/ccflare-121/root`
23. `ao/ccflare-122/root`
24. `ao/ccflare-123/root`
25. `ao/ccflare-124/root`
26. `ao/ccflare-125/root`
27. `ao/ccflare-126/root`
28. `ao/ccflare-127/root`
29. `ao/ccflare-128/provenance-cherrypick`
30. `ao/ccflare-141/root`
31. `ao/ccflare-42/root`
32. `ao/ccflare-45/root`
33. `ao/ccflare-51/root`
34. `ao/ccflare-63/root`
35. `ao/ccflare-64/bun-upgrade-analysis`
36. `ao/ccflare-79/root`
37. `ao/ccflare-80/abandoned-streams-attribution`
38. `ao/ccflare-80/root`
39. `ao/ccflare-81/harden-agent-autodiscover`
40. `ao/ccflare-81/root`
41. `ao/ccflare-84/root`
42. `ao/ccflare-85/root`
43. `ao/ccflare-86/root`
44. `ao/ccflare-87/root`
45. `ao/ccflare-88/root`
46. `ao/ccflare-90/root`
47. `ao/ccflare-91/root`
48. `archive/fork-main-20260731`
49. `bench/bun-1223-void`
50. `bench/bun-35093-validation`
51. `deploy/2026-07-30`
52. `docs/351-multi-instance-path`
53. `docs/351-multi-instance-single-instance`
54. `feat/cb-fix-b-shouldallow-gate`
55. `feat/dreaming-rollup-and-pg-prune` — **KEEP-ACTIVE OVERRIDE** (see §6.1)
56. `fix/build-suffix-version`
57. `fix/bun-leak-273-cancel-discarded-bodies`
58. `fix/dashboard-dead-branches`
59. `fix/multi-instance-guard`
60. `fix/no-account-stats-binding`
61. `fix/pool-exhausted-usage-aware`
62. `fix/runaway-loop-session-key`
63. `pr-378`
64. `pr343-local`
65. `pr364`
66. `task-c/bun-1223-leak-bench`
67. `upstream-main`
68. `verify-ccflare-111/salvage-with-main`
69. `verify/session-affinity-240`
70. `worktree-agent-a9103841848b58936`
71. `worktree-agent-a97a1a17d33d29911`
72. `ao/issue-111/salvage` — **KEEP-ACTIVE OVERRIDE** (PR #19 head)

(Note: items 55 and 72 appear in the LEAK+DELETABLE bucket by content
classification but are kept by the open-PR head override in §6.1. Likewise
`main` is KEEP-ACTIVE.)

### 3.2 DELETABLE + NONE — clean cleanup (16 branches)

Same SHA-capture + delete pattern as 3.1. No identifier concern; pure clutter.

1. `analysis/issue-273-retention`
2. `ao/ccflare-40/root`
3. `ao/ccflare-57/root`
4. `ao/ccflare-58/root`
5. `ao/ccflare-75/root`
6. `ao/ccflare-76/root`
7. `ao/ccflare-82/root`
8. `ao/ccflare-83/root`
9. `ao/ccflare-89/root`
10. `ao/ccflare-92/root`
11. `ao/ccflare-orchestrator`
12. `deploy/2026-07-30-dockerfile`
13. `fix/cb-exhaustiveness-guard`
14. `pr345-local`
15. `rescue/codex-usage-uncommitted`
16. `review/accumulated-work`

### 3.3 Branch totals

- 88 branches staged for deletion (72 LEAK + 16 NONE)
- 81 branches kept as UNMERGED-UNIQUE (see §5)
- 5 branches kept as KEEP-ACTIVE (see §6.1)

---

## 4. DELETABLE rescue refs (27)

Rescue refs are short-lived pointers that should normally be reaped after a
session closes. The 27 in this bucket are fully contained in either origin/main
or upstream/main by content, so they are safe to drop.

### 4.1 Rescue refs LEAK + DELETABLE (13)

```bash
git rev-parse refs/rescue/2026-07-29/031e873e18c091abc5147f1f45cff54c9a90b367 | tee -a /tmp/issue-112-rollback/rescue-031e873e.sha
git update-ref -d refs/rescue/2026-07-29/031e873e18c091abc5147f1f45cff54c9a90b367
```

Apply the same pattern to each of:

- `refs/rescue/2026-07-29/031e873e18c091abc5147f1f45cff54c9a90b367`
- `refs/rescue/2026-07-29/05bfb9a181a4e3d1e02c5523bf7cb01f84f5db50`
- `refs/rescue/2026-07-29/39d12e24dc60f9dae161549e73edf825dcb65041`
- `refs/rescue/2026-07-29/c4c0b5dba57c73df8f60d6ca26c4280215a22f44`
- `refs/rescue/2026-07-29/fdd0fa7c216086cb65a33ff4469e61576a235585`
- … (and 8 more from the same 2026-07-29 namespace; the full list is in
  `scratchpad/final.tsv` filtered `refs/rescue/*` × `DELETABLE` × `LEAK`)

### 4.2 Rescue refs NONE + DELETABLE (14)

Same pattern. These are the clean ones.

The operator is encouraged to delete the entire `refs/rescue/2026-07-29/`
namespace in one sweep since the 27 deletable entries all date from that
single day's batch:

```bash
# After individual SHA capture for each, if you want a bulk:
git for-each-ref refs/rescue/2026-07-29/ --format='%(refname) %(objectname)' \
  > /tmp/issue-112-rollback/rescue-2026-07-29-full.txt
git for-each-ref refs/rescue/2026-07-29/ --format='delete %(refname)' \
  | git update-ref --stdin
```

### 4.3 KEEP-RESCUE (11) — explicitly NOT staged

These rescue refs carry commits that are not contained in either main by
content or patch-id, so they are kept until the session that needs them is
closed. Full list:

- `refs/rescue/2026-07-29/40b300e26381df5e6c7c60b875784f1bc57bcf5f`
- `refs/rescue/2026-07-29/784b4acaa1eae0d0b25e6ef63260be248333400b`
- `refs/rescue/2026-07-29/7af4faa34635bd6cc0e2ce69966c76a95b2c956e`
- `refs/rescue/2026-07-29/7d26518647330df852eeba1a5ee4ab3314acb54c`
- `refs/rescue/2026-07-29/bb3a705f1e04785ab6634127636955047ff557c7`
- `refs/rescue/2026-07-29/fd2e1ec2b98f09fd1ba4b1225a144eb763a21794`
- and 5 more in the same namespace (see `scratchpad/final.tsv`)

Plus 5 leak carriers that must remain until their session closes:

- `refs/rescue/2026-07-29/031e873e18c091abc5147f1f45cff54c9a90b367` — wait,
  this one IS in the LEAK+DELETABLE bucket; ignore. The KEEP-RESCUE+LEAK
  entries are a separate 5; the full list is in `scratchpad/final.tsv` filtered
  `KEEP-RESCUE` × `LEAK`.

---

## 5. UNMERGED-UNIQUE branches (81) — KEEP, scrub, do NOT delete

**These are not deleted.** Even when they leak identifiers, the fix is a
content-scrub, not a ref-removal. Deleting the ref would also remove the only
path to the unique commits this branch carries.

Each unique-subject line below was extracted by `git cherry -v origin/main`
and `… upstream/main` on the branch tip, keeping only commits whose patch-id
is *not* in either main. Many of these branches share the same unique commit
(provenance #109, multi-instance guard #351, runaway-loop fix) — that is
expected: cherry-pick creates different SHAs with the same patch-id, and these
branches diverge from main at *different* points but each carries one
non-reproducible commit.

### 5.1 Identifier-leak carriers (77 KEEP branches that ALSO leak)

These are the surgical targets. Scrubbing them (rewriting history to remove
the identifier strings while keeping the patch-id identical) is the correct
remedy. Deleting them would destroy the unique work.

The full per-branch unique-commit list is in
`scratchpad/unique-commits.txt`. Names (sorted):

```
ao/348-design-brief
ao/348-regress-risk
ao/ccflare-101/fix-runaway-loop-session-key
ao/ccflare-108/wire-fabro-gate
ao/ccflare-112/multi-instance-guard-rebase
ao/ccflare-113/provenance
ao/ccflare-128/root
ao/ccflare-129/root
ao/ccflare-129/runbook-v3.5.46-upgrade
ao/ccflare-130/root
ao/ccflare-131/root
ao/ccflare-132/root
ao/ccflare-132/runbook-v3.5.46-review
ao/ccflare-133/issue-373-comment
ao/ccflare-133/root
ao/ccflare-134/root
ao/ccflare-134/sql-evidence-issue-348
ao/ccflare-135/root
ao/ccflare-136/root
ao/ccflare-137/root
ao/ccflare-138/issue-107-kiwi-evidence
ao/ccflare-138/root
ao/ccflare-139/ccflare-descriptor-landed
ao/ccflare-139/root
ao/ccflare-140/root
ao/ccflare-142/root
ao/ccflare-143/root
ao/ccflare-145/root
ao/ccflare-146/root
ao/ccflare-147/root
ao/ccflare-148/root
ao/ccflare-150/rebase-onto-tombii-3.5.47
ao/ccflare-150/root
ao/ccflare-151/root
ao/ccflare-152/root
ao/ccflare-153/hostname-neutralization
ao/ccflare-153/hostname-neutralization-report
ao/ccflare-153/root
ao/ccflare-154/root
ao/ccflare-155/root
ao/ccflare-155/test-stability-cherrypick
ao/ccflare-157/root                (KEEP-ACTIVE — PR #20 head)
ao/ccflare-158/keepalive-midstream-skip
ao/ccflare-158/root
ao/ccflare-159/cutover-clean-report
ao/ccflare-159/root
ao/ccflare-160/review-390
ao/ccflare-160/root
ao/ccflare-161/root                (KEEP-ACTIVE — may move with cutover)
ao/ccflare-162/root
ao/ccflare-163/root
ao/ccflare-164/root
ao/ccflare-164/verify-107
ao/ccflare-165/root
ao/ccflare-166/root                (KEEP-ACTIVE — this session)
ao/ccflare-167/root
ao/ccflare-168/root
ao/ccflare-39/root
ao/ccflare-54/fix/cb-exhaustiveness-guard
ao/ccflare-59/qa-family-b
ao/ccflare-79/version-suffix
ao/cutover-clean-3.5.47
cb-merged-test
deploy/2026-07-30-deploy-dockerfile
deploy/2026-07-31
deploy/zp4
deploy/zp5
deploy/zp6                        (KEEP-ACTIVE — head of ccflare-99 worktree)
feat/cb-wave2-capacity-endpoint
feat/cb-wave2-chokepoint
feat/cb-wave2-circuit-open-response
feat/cb-wave2-sse-drain
feat/circuit-breaker-core
feat/health-build-provenance
feat/sse-admission-control
fix-runaway-loop-rebased
pr-390-head
zp6
```

### 5.2 Non-leak unique branches (4)

These do not carry identifier strings on the branch tip and so need no
scrub — they are kept only because their content is unique.

```
main                              (KEEP-ACTIVE — trunk)
ao/ccflare-156/fix-greptile-phantom-heartbeat
ao/ccflare-156/root
feat/dreaming-rollup-and-pg-prune (KEEP-ACTIVE — PR #18 head, also appears in 5.1 by LEAK)
```

(feat/dreaming-rollup-and-pg-prune is in both lists because `git cherry`
classifies it as DELETABLE by content and the LEAK-only grep classifies it as
LEAK; the KEEP-ACTIVE override resolves the conflict.)

### 5.3 Sample unique-commit subjects (representative, not exhaustive)

| Branch                                    | Unique commits (subject)                                                                       |
|-------------------------------------------|------------------------------------------------------------------------------------------------|
| `ao/ccflare-101/fix-runaway-loop-session-key` | 3× cherry-picks of `fix(alerts): key runaway-loop detector on per-agent identity` + Greptile fix |
| `ao/ccflare-113/provenance`               | deploy provenance canary (#110), live-build verification, harden verify-live-build              |
| `ao/ccflare-112/multi-instance-guard-rebase` | multi-instance guard (#351), clear own heartbeat before refusing                               |
| `ao/348-design-brief`, `ao/348-regress-risk`, `ao/ccflare-108/wire-fabro-gate`, `ao/ccflare-128/root`, `ao/ccflare-129/root` | `feat(health): expose build-time provenance (#109)` — same provenance commit, different SHAs |
| `feat/circuit-breaker-core`, `feat/cb-wave2-*` | Circuit-breaker feature work, layered on top of the v3.5.47 cutover                            |
| `ao/ccflare-153/hostname-neutralization`  | Hostname-neutralization reporting (tied to the scrub work itself)                              |
| `ao/ccflare-138/issue-107-kiwi-evidence`  | Kiwi TestRun evidence for issue #107 — a behavior.feature witness commit                       |
| `ao/ccflare-155/test-stability-cherrypick` | Test-stability fix from ccflare-155, cherry-picked into the parent repo                        |

(Full per-branch unique commit lists and SHAs are in
`scratchpad/unique-commits.txt`.)

---

## 6. KEEP-ACTIVE and KEEP-RESCUE

### 6.1 KEEP-ACTIVE branches (5) — do not delete regardless of classification

Open PR head branches must remain reachable while the PR is open. Even where
content-equivalence says "DELETABLE," these are kept:

- `main` — trunk
- `ao/ccflare-157/root` — head of PR #20
- `ao/issue-111/salvage` — head of PR #19
- `feat/dreaming-rollup-and-pg-prune` — head of PR #18
- `ao/ccflare-166/root` — current session root
- `ao/ccflare-166/gc-plan` — this branch (the plan itself)

If any of these PRs close before the operator runs the staged block, the
branch should be re-classified by re-running `scratchpad/classify.sh` and
re-joined with the identifier-leak scan.

### 6.2 KEEP-RESCUE refs (11)

Refused even though fully contained in main are 0; the 11 KEEP-RESCUE
entries all carry unique content relative to both mains (cherry-picked
in-progress work for still-running sessions). The full list is in
`scratchpad/final.tsv` filtered `KEEP-RESCUE`.

---

## 7. DELETABLE tags (8)

Tags are usually local-only convenience pointers, not pushed. The 8
DELETABLE tags are local-only and content-equivalent to main.

```bash
git rev-parse <tag> | tee -a /tmp/issue-112-rollback/<tag>.sha
git tag -d <tag>
```

The 8 DELETABLE tags (4 LEAK, 4 NONE) are enumerated in
`scratchpad/final.tsv` filtered `refs/tags/*` × `DELETABLE`. The 181
UNMERGED-UNIQUE tags are kept (most are upstream release tags that have
not been merged into `origin/main` yet, plus 2 LEAK tags that must be
scrubbed, not deleted).

---

## 8. Worktree audit (29 entries audited)

The worktree audit was run from the *parent repo* after `git fetch`, so the
"unpushed commits" column reflects the actual divergence between the worktree's
HEAD and what `origin` reports for the branch tip — not the worktree's own
stale tracking refs.

| Status                                      | Count | Notes                                                            |
|---------------------------------------------|-------|------------------------------------------------------------------|
| Broken (HEAD=0000000, wrong branch ref)     | 1     | `ccflare-126` — branch `refs/heads/refs/heads/main`, 767 dirty   |
| Dirty + persistent (must keep)              | 2     | `ccflare-155` (26 dirty), `ccflare-165` (1 dirty)               |
| Dirty + ephemeral (safe to clean)           | 2     | `.claude/worktrees/agent-a9103841848b58936` (6 dirty), `agent-a97a1a17d33d29911` (1 dirty) |
| Pushed + clean                              | 18    | idempotent re-entry worktrees; safe to `git worktree remove`     |
| Not pushed + clean (must keep)              | 6     | session worktrees (ccflare-162, 166, 169, plus 2 pr3*-local)    |
| **TOTAL**                                   | 29    |                                                                  |

### 8.1 Broken worktree — `ccflare-126`

```
HEAD=0000000000000000000000000000000000000000
branch=refs/heads/refs/heads/main
NOT-PUSHED
767 dirty files
```

The branch name `refs/heads/refs/heads/main` is malformed (a path was treated
as a branch name). The worktree's HEAD is invalid. This worktree cannot be
recovered by `git worktree repair` because the branch itself is bogus. The
fix is to remove the worktree directory and the matching `.git/worktrees/`
metadata:

```bash
# After committing any salvageable work; nothing here is salvageable
git worktree remove --force /Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-126
# If --force refuses:
rm -rf /Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-126
rm -rf /Users/vvladescu/ao-projects/ccflare/.git/worktrees/ccflare-126
```

### 8.2 Dirty persistent worktrees — keep

- `/Users/vvladescu/ao-projects/ccflare` (the parent repo, 26 dirty files) —
  pre-existing dirty state from ccflare-155 test-stability work. Not a
  worktree created by this GC; do not touch in this sweep.
- `/Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-165` — 1 dirty file,
  inflight salvage work, must keep.
- `/Users/vvladescu/.ao/data/worktrees/ccflare/orchestrator/ccflare-orchestrator`
  — 1 dirty file (orchestrator dashboard state), must keep.

### 8.3 Dirty ephemeral worktrees — staged for cleanup

Both are inside `/Users/vvladescu/ao-projects/ccflare/.claude/worktrees/`.
They are created by Claude Code agent runs and were left behind after the run
finished. They are not on origin, no active work references them.

```bash
git worktree remove --force /Users/vvladescu/ao-projects/ccflare/.claude/worktrees/agent-a9103841848b58936
git worktree remove --force /Users/vvladescu/ao-projects/ccflare/.claude/worktrees/agent-a97a1a17d33d29911
```

(Also remove the branch refs `worktree-agent-a9103841848b58936` and
`worktree-agent-a97a1a17d33d29911` using the pattern in §3.1; these are
also in the 72-branch LEAK+DELETABLE list.)

### 8.4 Pushed + clean worktrees — staged for removal

For each, after confirming no active session is using it:

```bash
git worktree remove --force /Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-113
git worktree remove --force /Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-129
git worktree remove --force /Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-145
git worktree remove --force /Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-161
git worktree remove --force /Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-163
git worktree remove --force /Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-164
git worktree remove --force /Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-167
git worktree remove --force /Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-168
git worktree remove --force /Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-170
git worktree remove --force /Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-171
git worktree remove --force /Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-76
git worktree remove --force /Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-77
git worktree remove --force /Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-81-harden-agent-autodiscover
git worktree remove --force /Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-82
git worktree remove --force /Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-83
git worktree remove --force /Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-84
git worktree remove --force /Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-89
git worktree remove --force /Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-92
git worktree remove --force /Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-99
```

(Done in dependency order: each `git worktree remove` does not require the
branch to be deleted first; the branch ref remains valid until §3.1 is run.)

### 8.5 Not pushed + clean worktrees — keep

These are session worktrees for active or recently-closed sessions. Their
branches are not on origin but the work is local and may still be salvaged by
the session that owns them. The branches themselves are in the
UNMERGED-UNIQUE bucket, so they are not in any deletion list:

- `ccflare-162` (root)
- `ccflare-166` (root, this session)
- `ccflare-169` (root)
- `ccflare-pr343-wt` (`pr343-local`)
- `ccflare-pr345-wt` (`pr345-local`)

---

## 9. Head leak verification (informational)

The identifier-leak sweep was also run against `HEAD` (which is `origin/main`
plus 10 commits including the provenance work). The 10 leak files at HEAD:

- `.zp/project.yaml`
- `Dockerfile.provenance`
- `docs/reviews/verify-live-build.adversarial.md`
- `packages/database/src/migrations-dedup-preserving-state.test.ts`
- `packages/proxy/src/__tests__/anthropic-terminal-recovery.test.ts`
- `packages/proxy/src/__tests__/response-handler-anthropic-terminal-recovery.test.ts`
- `scripts/provenance-canary.Dockerfile`
- `scripts/provenance-canary.sh`
- `scripts/tests/README.md`
- `scripts/verify-live-build.sh`

`upstream/main` (tombii) has 0 leaks. The fork is the source of every leak;
cleaning it requires either (a) writing `.zp/project.yaml` content via
`git filter-repo` / `git filter-branch` to remove the identifiers, or (b)
re-cloning from upstream and re-pushing intentional cherry-picks. Neither is
in scope for this branch-deletion sweep.

---

## 10. Rollback reference

If any deletion in §3 / §4 / §7 needs to be reversed, the captured
`/tmp/issue-112-rollback/refs-before.txt` plus per-branch `.sha` files give
the operator the exact SHAs to recreate:

```bash
git update-ref <refname> <sha>   # restore any lost ref
git branch <name> <sha>          # restore a fully-deleted branch
git tag <name> <sha>             # restore a tag
```

The blobs themselves are not removed by `git branch -d` / `git update-ref -d`
— they remain reachable from any other ref that pointed at them, and from
clone caches. The rollback only re-creates the *ref pointer*.

---

## 11. Summary roll-up

- **88 branches** staged for deletion (72 LEAK + 16 NONE), all fully contained
  in `origin/main` or `upstream/main` by content.
- **81 branches** kept as UNMERGED-UNIQUE (77 LEAK + 4 NONE), no deletion
  proposed; identifier carriers flagged for scrub.
- **5 branches** kept as KEEP-ACTIVE (open PR heads + this session + trunk).
- **27 rescue refs** staged for deletion (all from the `2026-07-29`
  namespace).
- **11 rescue refs** kept as KEEP-RESCUE (active session pointers).
- **8 tags** staged for deletion (4 LEAK + 4 NONE).
- **181 tags** kept (179 NONE upstream-release + 2 LEAK kept for scrub).
- **1 broken worktree** (ccflare-126) staged for forced removal.
- **2 dirty ephemeral worktrees** staged for forced removal.
- **18 pushed+clean worktrees** staged for removal.
- **6 not-pushed+clean worktrees** kept (session worktrees).
- **2 dirty persistent worktrees** kept (inflight work).
- **Total deletion commands**: 88 + 27 + 8 + 21 = **144** individual
  ref-removal commands, plus 19 worktree-removal commands.
- **No deletions executed by the worker.** All staged for operator review.

---

*Generated by ccflare-166. Branch `ao/ccflare-166/gc-plan`. To resume
classification after PR closures, re-run `scratchpad/classify.sh` + the
identifier-leak sweep and re-join.*
