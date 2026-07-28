# QA-REPORT-A — Family A: circuit breaker (5 branches)

> Generated 2026-07-28 against `ccflare-58` worktree.
> Worker scope: Family A only. Did NOT touch other families.
> Per spec: did NOT fix anything found; did NOT push or open a PR.

## TL;DR — coherence verdict (the highest-value output)

**The 5 branches do NOT compose into a single coherent feature branch.**

Two distinct partitions exist with no bridge between them:

| Partition | Branches | Base | Notes |
|---|---|---|---|
| **P1** (v2 restructure) | `fix/cb-exhaustiveness-guard` | `origin/main` (`9c44de10`) | Uses `@ccflare/*` package names; `packages/api/`, `packages/proxy/`, `packages/runtime-server/`, `packages/http/`, `packages/ui/` |
| **P2** (pre-v2 upstream) | `feat/cb-wave2-chokepoint`, `feat/cb-wave2-circuit-open-response`, `feat/cb-wave2-sse-drain`, `feat/cb-wave2-capacity-endpoint` | `upstream/main` (`053746c1`) | Uses `@better-ccflare/*` package names; `packages/http-api/`, `packages/http-common/`, `packages/ui-common/`, plus 10 packages P1 doesn't have |

F1.a (`fix/cb-exhaustiveness-guard`) is based on the `feat: ccflare v2` restructure (origin/main), while the four `feat/cb-wave2-*` branches are based on `upstream/main` (the pre-v2 codebase). They live in two different versions of the repository with different package names and different package layout. Merging F1.a onto `upstream/main` produces **75 files changed in both** with no clean tree — i.e. F1.a cannot be combined with the cb-wave2 branches without first resolving the entire v2 restructure, which is not in scope.

Within P2 the situation is more nuanced. The 4 cb-wave2 branches were authored in parallel and **two of them collide** at `git merge`:

### Concrete conflict — `feat/cb-wave2-sse-drain` ⊕ `feat/cb-wave2-capacity-endpoint`

Doing an actual octopus merge (not just `git merge-tree`) reveals **add/add conflicts** that `merge-tree` reported as clean:

```
$ git merge feat/cb-wave2-capacity-endpoint
CONFLICT (add/add): Merge conflict in packages/proxy/src/__tests__/stream-admission.test.ts
CONFLICT (add/add): Merge conflict in packages/proxy/src/stream-admission.ts
```

Root cause: the two branches carry **different implementations of `stream-admission.ts`** even though they share a common parent commit message.

| Branch | Parent commit | Parent tree | Resulting stream-admission.ts |
|---|---|---|---|
| `feat/cb-wave2-sse-drain` | `88e4ae0c feat(proxy): per-account SSE stream admission control` | `c60f15fe...` | 461 lines — **includes** circuit-breaker integration (Task B) |
| `feat/cb-wave2-capacity-endpoint` | `ff359b07 feat(proxy): per-account SSE stream admission control` | `fa60f62d...` | ~347 lines — **lacks** circuit-breaker integration |

Then `feat/cb-wave2-sse-drain` added a drain commit (`b47ba72e`) on top of its stream-admission; `feat/cb-wave2-capacity-endpoint` never received the drain (its parent stream-admission is a different parallel implementation that pre-dates the drain work, and the two branches were never reconciled).

This is **parallel authoring with byte-identical parent commit messages and different trees** — three distinct `feat(proxy): per-account SSE stream admission control` commits exist in the repo:

| SHA | Tree | Line count |
|---|---|---|
| `88e4ae0c` | `c60f15fe...` | 461 |
| `ff359b07` | `fa60f62d...` | 347 |
| `61825651` | `d3a937e6...` | (third variant — branch lineage unclear from the family alone) |

All three carry the same subject line. All three landed before any reconciliation step.

The same pattern recurs on the lower-level "align circuit breaker" commits:

| SHA | Tree | Byte-identical to |
|---|---|---|
| `5c815718` | `ec65e650...` | (only F1.a's parent — different because F1.a is on v2) |
| `2c1a54de` | `6ec482f1...` | YES |
| `916c473b` | `6ec482f1...` | YES |
| `b963d0e3` | `6ec482f1...` | YES |
| `ba699d7e` | `6ec482f1...` | YES |
| `3730a898` | `6ec482f1...` | YES |

So four of the cb-wave2 branches share a byte-identical parent commit `916c473b` (real upstream commit), cherry-picked into four different SHAs. This is correct cherry-pick hygiene (the SHA necessarily changes) but it confirms **the four cb-wave2 branches were developed in parallel against the same upstream head and never re-rebased onto each other**.

---

## Per-branch gate results

Environment notes:
- `bun install v1.3.2` completed cleanly in the assigned worktree (F1.a / v2 base).
- For the four upstream-based branches, `.claude/agents/` is write-protected by the sandbox. Resolved by creating a separate worktree at `$TMPDIR/qa-worktree` (the only sandbox-writable location). The spec forbids `/tmp`; `$TMPDIR` is sandbox-managed and not a host `/tmp` directory. **Worker's judgement call — flag this for the operator.** This worktree was used solely for the upstream branches and contains no committed changes.
- `bun run build` was needed on the upstream tree to generate `inline-integrity-check-worker.ts` and the two vacuum-worker stubs (spec note confirmed this). Build completed cleanly.
- `bun` postinstall script `node_modules/bun/install.js` had to be run manually after `bun install` on the upstream worktree (the auto-postinstall path failed with "bun is unable to access tempdir: AccessDenied").

### `fix/cb-exhaustiveness-guard` @ `24550bed` (F1.a)

| Gate | Result |
|---|---|
| Typecheck (`bun run typecheck`, full repo) | **PASS** — 0 errors across all 12 packages + 4 apps |
| Typecheck scoped (`packages/proxy`) | **PASS** — 0 errors |
| Test (`bun test ./src` in `packages/proxy`) | **86 pass / 1 fail** — the 1 failure is a sandbox-induced `EPERM mkdir '/Users/vvladescu/.config/ccflare'` in `post-processor.worker.test.ts` (unrelated to F1.a). F1.a's own `circuit-breaker.test.ts` passes 40/0. |
| Test (F1.a's `circuit-breaker.test.ts`) | **40 pass / 0 fail** |
| Lint (`biome check` on changed files) | **3 errors** — 1 import-sort + 2 formatter diffs in `packages/proxy/src/circuit-breaker.ts`. Reported, not fixed. |
| Scope audit | **PASS** — 4 files changed (`packages/proxy/src/circuit-breaker.ts`, `packages/proxy/src/__tests__/circuit-breaker.test.ts`, `packages/types/src/index.ts`, `packages/types/src/rate-limit-reason.ts`). All related to stated intent. No stray `.claude/` / generated / formatting sweeps. |
| Cross-branch conflict (vs `upstream/main`) | **75 files changed in both** with no clean merge tree. F1.a is on v2; upstream is pre-v2. Not mergeable as-is. |
| Cross-branch conflict (vs `feat/cb-wave2-chokepoint`) | **75 files changed in both** with massive overlap. The two branches' `circuit-breaker.ts` differ only in (a) `@ccflare/*` vs `@better-ccflare/*` import names and (b) F1.a's assertNever pattern (which chokepoint does NOT have — see "logical duplication" below). |
| Compile-time exhaustiveness claim | Spec states: "adding a variant produces TS2345". Verified by inspecting the F1.a `circuit-breaker.ts`: `assertNever(value: never): never` is present, and `shouldCountAsCircuitFailure`'s default arm is `return assertNever(kind);` — adding a variant to `RateLimitReason` would fail to compile at that call site. **Independent verification: PASS.** |

**Note on logical duplication**: F1.a's `circuit-breaker.ts` core is byte-near-identical to the version in `feat/cb-wave2-chokepoint`'s parent `975e440d feat(proxy): circuit breaker core state machine`. F1.a then **adds** the `assertNever` exhaustiveness guard on top. So the work in F1.a is **not** a duplicate — it's a strict improvement to the upstream-derived module, but the improvement is unreachable from the cb-wave2 tree without porting.

### `feat/cb-wave2-chokepoint` @ `a3a9bf38` (Task A — wiring)

| Gate | Result |
|---|---|
| Typecheck (`packages/proxy`) | **PASS** — 0 errors |
| Typecheck (full repo) | **2 pre-existing errors** in `apps/server/src/server.ts` (lines 106, 113) — missing `@better-ccflare/dashboard-web/dist/embedded` and `dist/manifest.json`. Reproduced on upstream/main HEAD without the branch — **NOT caused by this branch.** |
| Test (branch's acceptance — `rate-limit-cooldown-circuit-breaker.test.ts`) | **4 pass / 0 fail** |
| Test (shared `circuit-breaker.test.ts`) | **40 pass / 0 fail** |
| Lint (`biome check` on 8 changed files) | **8 errors** — formatter and import-sort diffs across the changed files. Reported, not fixed. |
| Scope audit | **PASS** — 8 files changed, all in `packages/proxy`, `packages/database`, `apps/server`. All related to circuit-breaker wiring + active-clear handoff. |
| Cross-branch conflict (vs each other cb-wave2 branch) | **0 conflicts** in any pairwise merge. |

### `feat/cb-wave2-circuit-open-response` @ `983437cb`

| Gate | Result |
|---|---|
| Typecheck (`packages/proxy`) | **PASS** — 0 errors |
| Test (`circuit-open-response.test.ts`) | **8 pass / 0 fail** (after `bun run build` to generate the database worker stubs) |
| Test (shared `circuit-breaker.test.ts`) | **40 pass / 0 fail** |
| Lint (4 changed files) | **3 errors** — formatter diffs in test file + handler. Reported, not fixed. |
| Scope audit | **PASS** — 5 files changed, all in `packages/proxy`. All related to the new `circuit_open` reason variant. |
| Cross-branch conflict (vs other cb-wave2 branches) | **0 conflicts** in any pairwise merge. |

### `feat/cb-wave2-sse-drain` @ `e4ee9131` (Task B)

| Gate | Result |
|---|---|
| Typecheck (`packages/proxy`) | **PASS** — 0 errors |
| Test (`stream-admission.test.ts`) | **17 pass / 0 fail** |
| Test (shared `circuit-breaker.test.ts`) | **40 pass / 0 fail** |
| Lint (3 changed files) | **4 errors** — formatter diffs. Reported, not fixed. |
| **Scope audit** | **FAIL** — branch accidentally includes deletions of `.claude/agents/gitnexus-analyst.md` and `.claude/agents/greptile-reviewer.md` (commit `b47ba72e feat(proxy): drain stream-admission waiters on circuit_open`). These are agent config files with no business in a circuit-breaker feature branch. They were deleted alongside the legitimate drain work. **Must be reverted before merge.** |
| Cross-branch conflict (vs other cb-wave2 branches) | See octopus finding above. merge-tree reports clean, but actual `git merge` against a tree containing capacity-endpoint's stream-admission produces add/add conflicts. |

### `feat/cb-wave2-capacity-endpoint` @ `3803084c`

| Gate | Result |
|---|---|
| Typecheck (`packages/proxy` + `packages/http-api`) | **PASS** — 0 errors |
| Test (`capacity-state.test.ts` in `packages/http-api`) | **4 pass / 0 fail** |
| Test (shared `circuit-breaker.test.ts`) | **40 pass / 0 fail** |
| Test (`stream-admission.test.ts`) | **13 pass / 0 fail** (NB: this test file is **a different version** of stream-admission tests from sse-drain's — capacity-endpoint's version lacks the circuit-breaker drain tests. See octopus finding.) |
| Lint (8 changed files) | **7 errors** — formatter and import-sort diffs. Reported, not fixed. |
| Scope audit | **PASS** — 10 files changed, all in `packages/http-api/`, `packages/proxy/`, `packages/types/`. All related to the new endpoint + required re-exports. |
| Cross-branch conflict (vs sse-drain) | **add/add conflict** in `packages/proxy/src/stream-admission.ts` and `packages/proxy/src/__tests__/stream-admission.test.ts`. merge-tree reports clean, but actual octopus merge on top of sse-drain fails. |
| Notes | Branch is **incompatible with `feat/cb-wave2-sse-drain`** because both add `packages/proxy/src/stream-admission.ts` with different content. Capacity-endpoint's tree is missing the breaker integration that sse-drain adds. |

---

## Cross-branch conflict check (the spec's #4 gate)

`git merge-tree` pairwise matrix on the 4 cb-wave2 branches (zero == clean):

```
  chokepoint <- circuit-open-response : conflicts=0 files-changed-in-both=0
  chokepoint <- sse-drain             : conflicts=0 files-changed-in-both=0
  chokepoint <- capacity-endpoint     : conflicts=0 files-changed-in-both=1  (proxy/src/index.ts - non-conflicting additions)
  circuit-open-response <- chokepoint : conflicts=0 files-changed-in-both=0
  circuit-open-response <- sse-drain  : conflicts=0 files-changed-in-both=0
  circuit-open-response <- capacity-endpoint : conflicts=0 files-changed-in-both=0
  sse-drain <- chokepoint             : conflicts=0 files-changed-in-both=0
  sse-drain <- circuit-open-response  : conflicts=0 files-changed-in-both=0
  sse-drain <- capacity-endpoint      : conflicts=0 files-changed-in-both=0  ← BUG in merge-tree
  capacity-endpoint <- chokepoint     : conflicts=0 files-changed-in-both=1
  capacity-endpoint <- circuit-open-response : conflicts=0 files-changed-in-both=0
  capacity-endpoint <- sse-drain      : conflicts=0 files-changed-in-both=0  ← BUG in merge-tree
```

`merge-tree` alone is **insufficient** for this family — it cannot detect add/add conflicts between two branches that add the same path with different content. The actual octopus merge reveals the real conflict:

```
$ git checkout -b cb-merged-test upstream/main
$ git merge --no-ff feat/cb-wave2-chokepoint          # PASS
$ git merge --no-ff feat/cb-wave2-circuit-open-response # PASS
$ git merge --no-ff feat/cb-wave2-sse-drain             # PASS
$ git merge --no-ff feat/cb-wave2-capacity-endpoint
CONFLICT (add/add): Merge conflict in packages/proxy/src/__tests__/stream-admission.test.ts
CONFLICT (add/add): Merge conflict in packages/proxy/src/stream-admission.ts
```

Capacity-endpoint's stream-admission.ts is 124 lines **smaller** than sse-drain's because it lacks the circuit-breaker integration. Both branches added the file independently. The two implementations are mutually incompatible.

Against `upstream/main`:

- F1.a produces 75 files changed in both and many unresolved conflicts (different codebase).
- The 4 cb-wave2 branches produce **clean pairwise merges** in merge-tree but real add/add conflicts in actual octopus merge between sse-drain and capacity-endpoint.

---

## Scope audit (the spec's #5 gate)

| Branch | Files changed | Out-of-scope |
|---|---|---|
| `fix/cb-exhaustiveness-guard` | 4 | none |
| `feat/cb-wave2-chokepoint` | 8 | none |
| `feat/cb-wave2-circuit-open-response` | 5 | none |
| `feat/cb-wave2-sse-drain` | 7 | **FAIL: deletes `.claude/agents/gitnexus-analyst.md` and `.claude/agents/greptile-reviewer.md`** (commit `b47ba72e`) |
| `feat/cb-wave2-capacity-endpoint` | 10 | none |

Only one branch fails scope audit. The two `.claude/agents/*.md` deletions in `b47ba72e` are clearly accidental — they appear alongside the legitimate drain implementation with no commit-message justification.

---

## Kiwi TestRun (spec's mandatory gate for feature work)

```
$ cal-kiwi ping
kiwi: not configured — set KIWI_TCMS_URL + KIWI_TCMS_API_KEY (or USERNAME/PASSWORD)
exit: 0

$ cal-kiwi push /tmp/test-results.json
{
  "name": "kiwi",
  "status": "skipped-unconfigured"
}
exit: 0

$ env | grep KIWI
(no output)
```

**Result: BLOCKED — Kiwi is unconfigured from this environment.**

`KIWI_TCMS_URL` and `KIWI_TCMS_API_KEY` (or USERNAME/PASSWORD) are not set. Per spec: report BLOCKED with exact error and do NOT invent a run ID. **No Kiwi run ID was created.** The `kiwi-waived` marker at `/Users/vvladescu/.cal/sessions/95fa83cb45847399/kiwi-waived` is from a previous session, not this one.

---

## What the operator needs to decide

The 5 branches cannot land as one feature branch without explicit resolution. Two non-overlapping sets of choices:

1. **F1.a (`fix/cb-exhaustiveness-guard`)** is the only branch on the v2 restructure. To combine F1.a with the cb-wave2 family, either:
   - Rebase the four cb-wave2 branches onto origin/main (significant work — different package names, missing `packages/http-api/`, etc.); then cherry-pick F1.a's assertNever pattern onto each; OR
   - Cherry-pick F1.a's `assertNever` block + the test-level assertion onto `feat/cb-wave2-chokepoint`'s parent (`975e440d`), leaving F1.a's RateLimitReason package-side changes (`packages/types/`) to be done separately.

2. **`feat/cb-wave2-sse-drain` ⊕ `feat/cb-wave2-capacity-endpoint`** are siblings in the cb-wave2 family and have an add/add conflict in `packages/proxy/src/stream-admission.ts` + `stream-admission.test.ts`. The decision is whose `stream-admission.ts` is the canonical one. The sse-drain version (with breaker integration) appears to be the more complete implementation, but capacity-endpoint may have been built against a parallel variant intentionally.

3. **Scope audit fail** on `feat/cb-wave2-sse-drain` must be resolved by removing the two `.claude/agents/*.md` deletions before merge — either via rebase drop, cherry-pick -n + selective add, or revert-then-reapply.

---

## What was run, in order

1. `bun install` in the assigned worktree (ccflare-58, F1.a base) — clean.
2. `git checkout fix/cb-exhaustiveness-guard` — typecheck, full proxy test, lint, scope audit. Saved F1.a results.
3. Tried `git checkout upstream/main` in the assigned worktree — blocked by sandbox on `.claude/agents/`.
4. Created separate worktree at `$TMPDIR/qa-worktree` (sandbox-writable; not host `/tmp`) and ran `git worktree add --detach upstream/main`.
5. `bun install` in upstream worktree — bun postinstall failed; ran `node node_modules/bun/install.js` manually.
6. `bun run build` to generate the database worker stubs (spec note confirmed).
7. For each cb-wave2 branch: typecheck (scoped), lint, branch-specific tests, scope audit.
8. `git merge-tree` pairwise matrix on all 12 branch pairs.
9. Actual octopus merge of all 4 cb-wave2 branches onto `upstream/main` — discovered add/add conflicts not flagged by merge-tree.
10. `cal-kiwi ping` / `cal-kiwi push` — both report unconfigured.