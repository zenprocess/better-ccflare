# Branch Cleanup Execution — ao-company #112

**Session:** ao/ccflare-118/root (branch-gc-narrow)
**Date:** 2026-08-01
**Scope:** branches ONLY (worktrees, rescue refs, tags out of scope)

## Final counts (corrected after orchestrator protection update)

| Category | Count |
| --- | ---: |
| **Existed (pre-cleanup)** | **202** |
| `DELETED` (originally removed) | **112** |
| `RECOVERED` (orchestrator rule violation — `ao/` branch created today) | **1** |
| `KEPT-DELETED` (net deletions) | **111** |
| `KEEP` (protected by name / active session / deploy/*) | **18** |
| `KEPT-OUT-OF-UNCERTAINTY` (NEEDS-DECISION) | **63** |
| `BLOCKED-BY-WORKTREE` (would-delete per SALVAGE RULE but git refuses — checked out) | **9** |
| **Remaining branches (after recovery)** | **95** |

202 = 111 (net deleted) + 18 (keep) + 63 (kept-out-of-uncertainty) + 9 (blocked) + 1 (recovered, counted in remaining) ✓

### Recovery: `ao/ccflare-107/fix-runaway-loop-session-key`

After the original 112 deletions, the orchestrator (ccflare-74) sent a protection update:

> "Simplest safe rule, apply it: do NOT delete any branch under `ao/` that was created today.
> Restrict deletions to branches that are provably merged into main or are ancestors of a protected ref."

Cross-checked pre-deletion inventory: exactly **one** `ao/` branch I had deleted carried a today-date (2026-08-01):

- `ao/ccflare-107/fix-runaway-loop-session-key` @ tip `1f6eee35` — created 2026-08-01

**Recovered** by `git branch ao/ccflare-107/fix-runaway-loop-session-key 1f6eee35`. The commit was still reachable via the protected `ao/ccflare-112/docs-multi-instance-guard-independent` (which holds the tombii#377 lineage that descended from it). No data loss.

### Live AO session state after recovery

Re-queried `ao.db.sessions` after the orchestrator's update:

| Session | Branch | State |
| --- | --- | --- |
| ccflare-74 | `ao/ccflare-orchestrator` | idle (orchestrator) |
| ccflare-117 | `ao/ccflare-117/root` + pushed `ao/ccflare-117/reply-348-pr360` | idle (exited after pushing) |
| ccflare-118 | `ao/ccflare-118/root` | active (this session) |
| ccflare-119 | `ao/ccflare-119/root` | active (newly spawned) |
| ccflare-120 | `ao/ccflare-120/root` | active (newly spawned) |
| ccflare-121 | `ao/ccflare-121/root` | active (newly spawned) |

None of the new session branches were in the original delete list. None of them will be touched.

## Verification

- All 11 named protected refs **still exist** (verified `git show-ref`):
  `main`, `ao/ccflare-orchestrator`, `ao/ccflare-117/root`, `ao/ccflare-118/root`,
  `fix/multi-instance-guard`, `ao/ccflare-112/pr-376-add-greptile-fix`,
  `ao/ccflare-112/docs-multi-instance-guard-independent`, `ao/ccflare-113/provenance`,
  `ao/ccflare-114/issue-107-test-stability`, `ao/ccflare-115/disable-inherited-workflows`,
  `docs/351-multi-instance-path`
- All 7 `deploy/*` branches **still exist**:
  `deploy/2026-07-30`, `deploy/2026-07-30-deploy-dockerfile`, `deploy/2026-07-30-dockerfile`,
  `deploy/2026-07-31`, `deploy/zp4`, `deploy/zp5`, `deploy/zp6`

## BLOCKED-BY-WORKTREE (9 branches — git refused because checked out)

These branches ARE classified `DELETE` by the SALVAGE RULE (each is ancestor of one or more protected refs, see below) but `git branch -D` refused because they're currently checked out in a worktree. **Worktrees are out of scope for this task**, so per the task's "report it, do not route around it" instruction, they are left in place.

| Branch | Tip | Ancestor of | Checked-out worktree |
| --- | --- | --- | --- |
| `ao/ccflare-76/root` | `9c44de10` | main, ao/ccflare-orchestrator, ao/ccflare-113/provenance | `~/.ao/data/worktrees/ccflare/ccflare-76` |
| `ao/ccflare-81/harden-agent-autodiscover` | `9f628cdc` | fix/multi-instance-guard, ao/ccflare-112/pr-376-add-greptile-fix, ao/ccflare-112/docs-multi-instance-guard-independent, docs/351-multi-instance-path | `~/.ao/data/worktrees/ccflare/ccflare-81-harden-agent-autodiscover` |
| `fix/build-suffix-version` | `4cd1296d` | deploy/zp5, deploy/zp6 | `/private/tmp/.../ccflare-92/.../fix-build-suffix-version` (stale scratchpad) |
| `fix/no-account-stats-binding` | `946b23cb` | fix/multi-instance-guard, ao/ccflare-112/pr-376-add-greptile-fix, ao/ccflare-112/docs-multi-instance-guard-independent, docs/351-multi-instance-path | `/private/tmp/.../ccflare-82/.../ccflare-pgfix-wt` (stale scratchpad) |
| `fix/pool-exhausted-usage-aware` | `f47702bf` | fix/multi-instance-guard, ao/ccflare-112/pr-376-add-greptile-fix, ao/ccflare-112/docs-multi-instance-guard-independent, docs/351-multi-instance-path, deploy/zp4, deploy/zp5, deploy/zp6 | `~/.ao/data/worktrees/ccflare/ccflare-84` |
| `fix/runaway-loop-session-key` | `a3f6b99d` | deploy/zp5, deploy/zp6 | `~/ao-projects/ccflare` (main repo, currently checked out here) |
| `pr343-local` | `71bd8386` | ao/ccflare-117/root, ao/ccflare-118/root, fix/multi-instance-guard, all deploy/* | `~/ao-projects/ccflare-pr343-wt` |
| `pr345-local` | `6abbe3c0` | ao/ccflare-117/root, ao/ccflare-118/root, fix/multi-instance-guard, all deploy/* | `~/ao-projects/ccflare-pr345-wt` |
| `pr364` | `7d753e8f` | fix/multi-instance-guard, ao/ccflare-112/pr-376-add-greptile-fix, ao/ccflare-112/docs-multi-instance-guard-independent, docs/351-multi-instance-path | `/private/tmp/.../orchestrator/.../wt-364` |

**Note on `fix/runaway-loop-session-key`**: this is the branch the main repo `/Users/vvladescu/ao-projects/ccflare` is currently checked out on. The main repo is not my worktree; another worker owns it. Per the task's "do not touch worktrees" rule, I left it untouched even though the branch's tip is fully covered by `deploy/zp5` and `deploy/zp6`.

## KEPT-OUT-OF-UNCERTAINTY (63 branches — NEEDS-DECISION)

Per the SALVAGE RULE, kept verbatim. Many are `ao/ccflare-XXX/root` of old exited sessions at a stale `c94b6110` snapshot; others are circuit-breaker experiments, bench branches, and `rescue/`-prefixed branches. Their tips are NOT reachable from any protected ref, so I cannot prove they hold no unique work.

```
analysis/agent-attribution                       5ea977ae
analysis/bluegreen-design                       44f10f98
analysis/bun-upgrade-path                       3bc0d3a4
analysis/cache-throttle                         43c69952
analysis/ccmax-502                              9a7575c3
analysis/issue-273-ops-mitigations              7ebda11d
analysis/issue-273-retention                    3a9f4677
analysis/native-fallback                        7e892f34
ao/ccflare-101/fix-runaway-loop-session-key     d75c8f35
ao/ccflare-111/stock-v3.5.46-validation         47d377a3
ao/ccflare-112/deployment-multi-instance-doc    e6d70971
ao/ccflare-112/multi-instance-guard-rebase      b478c0bb
ao/ccflare-112/stage-0-ha-finalize-report       b25725cd
ao/ccflare-39/root                              3803084c
ao/ccflare-40/root                              6abe41fb
ao/ccflare-42/root                              c4171115
ao/ccflare-45/root                              8e148a7e
ao/ccflare-51/root                              82c16a80
ao/ccflare-54/fix/cb-exhaustiveness-guard       2f969426
ao/ccflare-57/root                              24550bed
ao/ccflare-58/root                              9875114d
ao/ccflare-59/qa-family-b                       4cd4a8af
ao/ccflare-63/root                              44f10f98
ao/ccflare-64/bun-upgrade-analysis              3bc0d3a4
ao/ccflare-75/root                              fe5d52c4
ao/ccflare-79/root                              c94b6110
ao/ccflare-79/version-suffix                    98d9cc7b
ao/ccflare-80/abandoned-streams-attribution     e47c78ed
ao/ccflare-80/root                              c94b6110
ao/ccflare-81/root                              c94b6110
ao/ccflare-82/root                              c94b6110
ao/ccflare-83/root                              c94b6110
ao/ccflare-84/root                              c94b6110
ao/ccflare-85/root                              c94b6110
ao/ccflare-86/root                              c94b6110
ao/ccflare-87/root                              c94b6110
ao/ccflare-88/root                              c94b6110
ao/ccflare-89/root                              c94b6110
ao/ccflare-90/root                              c94b6110
ao/ccflare-91/root                              c94b6110
ao/ccflare-92/root                              c94b6110
archive/fork-main-20260731                       c94b6110
bench/bun-1223-void                             50eba125
bench/bun-35093-validation                      a4328761
cb-merged-test                                  fc8ccb22
feat/cb-fix-b-shouldallow-gate                  c65e2f42
feat/cb-wave2-capacity-endpoint                 3803084c
feat/cb-wave2-chokepoint                        a3a9bf38
feat/cb-wave2-circuit-open-response             983437cb
feat/cb-wave2-sse-drain                         e4ee9131
feat/circuit-breaker-core                       916c473b
feat/dreaming-rollup-and-pg-prune               cdb61259
feat/sse-admission-control                      61825651
fix-runaway-loop-rebased                        94b97a3a
fix/bun-leak-273-cancel-discarded-bodies        7feb8977
fix/cb-exhaustiveness-guard                     24550bed
fix/dashboard-dead-branches                     a7b6b0c0
rescue/codex-usage-uncommitted                  95adf47e
review/accumulated-work                         6abe41fb
task-c/bun-1223-leak-bench                      50eba125
verify/session-affinity-240                     f08c2085
worktree-agent-a9103841848b58936                7bcd2f2c
worktree-agent-a97a1a17d33d29911                9906331b
```

## KEEP (18 — protected set)

`main`, `ao/ccflare-orchestrator`, `ao/ccflare-117/root` (active session), `ao/ccflare-118/root` (this session), `fix/multi-instance-guard`, `ao/ccflare-112/pr-376-add-greptile-fix`, `ao/ccflare-112/docs-multi-instance-guard-independent`, `ao/ccflare-113/provenance`, `ao/ccflare-114/issue-107-test-stability`, `ao/ccflare-115/disable-inherited-workflows`, `docs/351-multi-instance-path`, plus 7 `deploy/*` branches.

## DELIVERED

- ✅ Inventory + classification **pushed before any deletion** (commit `2230ad9`, branch `ao/ccflare-118/root` on origin).
- ✅ 112 deletions executed via `git branch -D`.
- ✅ All 18 protected refs verified intact.
- ✅ All 9 blocked-by-worktree branches explicitly listed with reason + ancestor-of chain.
- ✅ All 63 NEEDS-DECISION branches explicitly listed.

## NOT touched (out of scope per task)

- Worktrees (`git worktree list` shows 22 worktrees; their cleanup is a separate later pass).
- Rescue refs (the task says "do not touch rescue refs").
- Tags (185 tags, untouched).
