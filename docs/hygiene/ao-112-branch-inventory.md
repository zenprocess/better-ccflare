# Branch Inventory & Classification — ao-company #112

**Session:** ao/ccflare-118/root (branch-gc-narrow)
**Date:** 2026-08-01
**Scope:** branches ONLY (worktrees, rescue refs, tags out of scope per narrowed task)
**Repo:** better-ccflare @ `/Users/vvladescu/ao-projects/ccflare`
**Main tip:** `f271e67c` (Merge dreaming distiller + fail-closed prune gate)

## Counts (pre-deletion)

| Category | Count |
| --- | ---: |
| **Total local branches inventoried** | **202** |
| `DELETE` (tip merged into main OR ancestor of a protected ref) | **121** |
| `KEEP` (named protected / active AO session) | **18** |
| `NEEDS-DECISION` (kept out of uncertainty) | **63** |
| **Sum** | **202** |

## SALVAGE RULE applied

> "Safe to delete = tip merged into main OR tip is ancestor of a protected ref.
> When unsure, KEEP and list as needs-decision."

For every branch, classification checked:

1. **Name-based protection (always KEEP):**
   - `main`
   - `ao/ccflare-orchestrator` (live orchestrator session)
   - `ao/ccflare-117/root` (active worker session, may still push)
   - `ao/ccflare-118/root` (this session)
   - `fix/multi-instance-guard` (tombii#376 lineage)
   - `ao/ccflare-112/pr-376-add-greptile-fix` (tombii#376 commit `700155c3`)
   - `ao/ccflare-112/docs-multi-instance-guard-independent` (tombii#377 commit `f090a171`)
   - `ao/ccflare-113/provenance` (Dockerfile + provenance scripts, unmerged)
   - `ao/ccflare-114/issue-107-test-stability` (test/TMPDIR fixes, unmerged)
   - `ao/ccflare-115/disable-inherited-workflows` (workflow ruling, unmerged)
   - `docs/351-multi-instance-path` (381-line HA analysis)
   - All `deploy/*` branches (deploy lineage)

2. **Active AO session root patterns (always KEEP):**
   - `^ao/ccflare-117/` — ccflare-117 is `active` per `ao.db.sessions`
   - `^ao/ccflare-118/` — this session is `active`

3. **Safety check (qualifies for DELETE):**
   - Tip reachable from `refs/heads/main` (`git branch --merged main`), OR
   - Tip reachable from any of the 18 protected refs (verified via `git merge-base --is-ancestor <tip> <protected_ref>`)

4. **Otherwise (NEEDS-DECISION):** keep verbatim.

## Active AO session state (per `/Users/vvladescu/.ao/data/ao.db`)

| Session | Branch | State |
| --- | --- | --- |
| ccflare-74 | `ao/ccflare-orchestrator` | idle |
| ccflare-117 | `ao/ccflare-117/root` | **active** |
| ccflare-118 | `ao/ccflare-118/root` | **active** (this session) |

All other ccflare sessions are `exited`. The `ao.db` confirms 110 exited sessions whose root branches (`ao/ccflare-XXX/root`) are still present in the local repo; these are exactly the labels classified as `DELETE` because their shared tip (`053746c1`) is reachable from the active session root.

## Files produced

| File | Purpose |
| --- | --- |
| `docs/hygiene/ao-112-branch-inventory.md` | This report |
| `.ao-inventory.tsv` | Raw inventory: `name\tsha\tdate` for all 202 branches |
| `.ao-merged-clean.txt` | 66 branches whose tip is reachable from `main` |
| `.ao-not-merged-clean.txt` | 134 branches NOT merged into main |
| `.ao-protected-refs.txt` | 18 protected refs (name + short SHA) |
| `.ao-classification.tsv` | `name\tsha\tdate\tverdict\treason` for all 202 |
| `.ao-to-delete.txt` | 121 branches slated for deletion |
| `.ao-keep.txt` | 18 branches always kept |
| `.ao-needs-decision.txt` | 63 branches kept out of uncertainty |
| `.ao-classify.log` | Per-branch ancestor trace |

## Verdict counts (preview)

- **DELETE (121):** includes all `ao/ccflare-XXX/root` session roots at shared tip `053746c1` (the tip itself is preserved by `ao/ccflare-117/root` and `ao/ccflare-118/root`, so no data loss) plus 55 feature/release branches whose tips are inside `fix/multi-instance-guard`, `ao/ccflare-112/*`, `ao/ccflare-113/provenance`, `ao/ccflare-114/*`, `ao/ccflare-115/*`, `docs/351-multi-instance-path`, and the `deploy/*` lineage.
- **KEEP (18):** the protected set above plus all `deploy/*`.
- **NEEDS-DECISION (63):** branches whose tips live on a stale snapshot commit (`c94b6110`, `24550bed`, `9875114d`, etc.) that is NOT reachable from any protected ref. Many are `ao/ccflare-XXX/root` of old exited sessions; others are circuit-breaker experiments, bench branches, and rescue-prefix branches. The SALVAGE RULE says keep them — they may hold unpushed work.

## Explicit NEEDS-DECISION list (kept out of uncertainty)

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

## Notes

- `worktree-agent-*` branches are auto-generated by some agent harness and not user work, but their tips are not reachable from any protected ref so they are KEPT per the SALVAGE RULE.
- `rescue/codex-usage-uncommitted` is a branch in the `rescue/` namespace; rescue *refs* are out of scope per the task, but this is a branch and was classified by the same rule.
- Several `ao/ccflare-XXX/root` branches (ccflare-79 through ccflare-92) share a stale `c94b6110` tip. This snapshot is not in any protected ref so they were KEPT; a follow-up pass could investigate whether `c94b6110` is reachable from the new `dreaming` lineage on `main` and re-classify.
- `ao/ccflare-101/fix-runaway-loop-session-key` and `ao/ccflare-111/stock-v3.5.46-validation` are recent worker branches whose tips are recent (`2026-08-01`); KEPT pending review.

## Execution plan

1. ✅ Inventory all branches (this report, file count 202).
2. ✅ Classify (DELETE / KEEP / NEEDS-DECISION) with reasons.
3. ⏳ **PUSH this report before deletion.**
4. Delete the 121 `DELETE` branches via `git branch -D` from the worktree (force, since some are not merged to main).
5. Re-classify and produce a final post-deletion report confirming counts.
6. Commit and push the final report.
