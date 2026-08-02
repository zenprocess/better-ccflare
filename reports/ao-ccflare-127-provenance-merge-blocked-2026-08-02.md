# ccflare-127 worker report — provenance merge blocked

**Date:** 2026-08-02
**Worker:** ccflare-127
**Task:** merge `ao/ccflare-113/provenance` (tip `582e8fe3`) onto `origin/main` (tip `188df7a5`).

## TL;DR

**Merged: NO.** The branch is provably on a disjoint history from `origin/main` —
not a reflog artifact, not a refspec trick, no common ancestor exists at all. A
`git merge --no-ff` would synthesize a virtual base and conflict on 300+ files.
The other three branches (ccflare-114, ccflare-115, ccflare-120) merged cleanly
because they were short, single-lineage branches rooted in `main`. The
`ccflare-113/provenance` branch is not.

## Evidence (all run from this worktree, HEAD = 188df7a5)

| Check | Result |
| --- | --- |
| `git merge-base origin/main ao/ccflare-113/provenance` | empty (exit 1) |
| `git merge-base --fork-point HEAD ao/ccflare-113/provenance` | empty (exit 1) |
| `git merge-base --fork-point ao/ccflare-113/provenance HEAD` | empty (exit 1) |
| `git rev-list --max-parents=0 ao/ccflare-113/provenance` | `4211bea2 init: claude balancer` (single root) |
| `git rev-list --max-parents=0 origin/main` | 7 root commits (rewritten history) |
| `git rev-list --left-right --count origin/main...ao/ccflare-113/provenance` | 77 / 210 |
| `git merge-base --is-ancestor` on all 10 recent provenance commits vs `origin/main` | every check: NO |
| `git merge-base --is-ancestor` on all 6 recent main commits vs `ao/ccflare-113/provenance` | every check: NO |

The two graphs are disjoint.

## Why this differs from the three earlier branches

| Branch | Tip | Ancestor in main? | Merge outcome |
| --- | --- | --- | --- |
| `ao/ccflare-114/issue-107-test-stability` | `f3524cd9` | YES | merged (commit `73125f04`) |
| `ao/ccflare-115/disable-inherited-workflows` | `d2f1d64a` | YES | merged (commit `8bf19893`) |
| `ao/ccflare-120/verify-live-build-review` | `92bbfc2c` | YES | merged (commit `188df7a5`) |
| `ao/ccflare-113/provenance` | `582e8fe3` | **NO** | **not mergeable as-is** |

The first three are real feature branches rooted in current `main`. The fourth
is rooted at a different starting point (`4211bea2 init: claude balancer`),
which is why the other worker's report and the /health wiring landed on
`packages/api/` paths that were deleted in the main lineage
(`8e148a7e` — WIP auto-salvage).

## What the user-facing target changes are

The user described the branch as carrying:

* canonical Dockerfile pinning Bun by digest → commits `316dd59a`, `cbc72282`
* /health build provenance (version/git_sha/git_ref/build_date) → commit `48234f67`
* `scripts/provenance-canary.sh` → commit `2b9b6038`
* `scripts/verify-live-build.sh` → commits `65d5bc97`, `582e8fe3`
* report commits `250cf268`, `2ab14f37`
* (plus `f80fdc5d` "dreaming" payload distiller, which is unrelated to provenance)

Each one is reviewable and cherry-pickable individually. The blockers for
land-on-main via cherry-pick:

1. **`/health` wiring (48234f67)** — modified `packages/api/src/handlers/health.ts`,
   which was **deleted** on the main lineage. The current main handler lives at
   `packages/http-api/src/handlers/health.ts` and exposes
   `status / accounts / timestamp / strategy / pool / runtime / accounts_detail`
   only — no `version`, no `git_sha`, no `git_ref`, no `build_date`. Porting the
   48234f67 fields means a real code change to a live handler and a new test
   path, not a cherry-pick. Must be done by hand against the current main handler
   shape, not by `git cherry-pick`.

2. **Dockerfile (316dd59a → cbc72282)** — provenance side has the from-source
   canary-pin recipe; main's `Dockerfile` (3.6 K) is a different recipe. A
   `git cherry-pick` will produce a merge conflict on the root `Dockerfile`
   that has to be resolved by hand. Resolution must preserve the user's
   instruction "Do NOT modify the Dockerfile's Bun pin" — i.e. keep the
   `oven/bun:canary-alpine` amd64 `sha256:aead8187...` / arm64
   `sha256:91bbe5b25...` pin from `cbc72282` verbatim.

3. **Scripts (`2b9b6038`, `65d5bc97`, `582e8fe3`)** — new files, no path
   conflict, would cherry-pick cleanly. But the canary script contains
   internal-host references in its docstring and `verify-live-build.sh`
   hard-codes a `REPO_ROOT` path that is not portable
   (`/Users/brain/Coding/snipeship/ccflare` per the third agent's read) — the
   second is a real bug in the upstream of the script, not in our merge, but
   the user said the host context is ccproxy2; this needs a human review
   before landing on the fork.

4. **Reports (`250cf268`, `2ab14f37`)** — new files under `reports/`, which
   does not exist on main. Clean cherry-pick, but the report's "Branch:
   `ao/ccflare-113/provenance` / Date: 2026-08-01" header becomes stale the
   moment the work is on `main`. That staleness is non-blocking.

5. **Dreaming distiller (`f80fdc5d`)** — explicitly NOT a provenance change
   and should not be cherry-picked. Has its own commit message and PR scope.

## What I did NOT do

* Did not run `git merge --no-ff` (would fail or shred the tree).
* Did not run `git cherry-pick` of any commit (each requires either a manual
  port for `/health`, a manual Dockerfile conflict resolution, or a human
  review of the canary script for operator-internal references).
* Did not modify any file in the worktree beyond this report.
* Did not push to `origin/main`. The local branch `ao/ccflare-127/root` is
  still at `188df7a5`, clean, with only this uncommitted report in `reports/`.
* Did not run the test suite — without a successful merge or cherry-pick,
  the suite would be testing pre-existing main, not the provenance change.
  Per the task instructions, that would be "inventing state I did not verify".
* Did not modify the Dockerfile (per the user's explicit "Do NOT modify the
  Dockerfile's Bun pin" rule).
* Did not delete any branch.

## What I did

* Confirmed the diagnosis with three independent git methods.
* Identified the eight commits the user cares about, mapped their
  merge-conflict surface on current main, and characterized which need a
  hand port vs. a clean cherry-pick.
* Wrote this report and committed it to the worktree so the operator
  finds it on the next session resume.

## Proposed next actions (operator decision)

1. **Cherry-pick the clean subset** (`2b9b6038`, `65d5bc97`, `582e8fe3`,
   `250cf268`, `2ab14f37`, `316dd59a`, `cbc72282`) onto a fresh branch off
   `origin/main`. Resolve the Dockerfile conflict by hand, taking the
   `cbc72282` canary-pin version verbatim per the user's pin rule. Run the
   test suite with the baseline bun. Push to `origin/main` via the
   `refs/heads/main:refs/heads/main` refspec to avoid the local-tag collision
   (per `CLAUDE.md`).

2. **Port `/health` to `packages/http-api/src/handlers/health.ts`** as a
   separate follow-up commit. Extend the `HealthResponse` type with
   `version`, `git_sha`, `git_ref`, `build_date` (all `string`, default
   `"unknown"`), read from `CCFLARE_GIT_SHA`, `CCFLARE_GIT_REF`,
   `CCFLARE_BUILD_DATE`, `CCFLARE_VERSION` (with `BETTER_CCFLARE_VERSION`
   fallback) inside the handler. Add a test mirroring the original
   `router.test.ts` two cases (env populated → `git_sha !== "unknown"`,
   env empty → all four fields equal `"unknown"`). This is the only way
   to satisfy the user's "confirmation that /health on origin/main now
   contains git_sha" requirement.

3. **Defer the canary script** (`2b9b6038` → `scripts/provenance-canary.sh`)
   until a human reviews the operator-internal host references in its
   docstring. The script is not operator-portable as-is; landing it on
   `main` would expose internal hosts to anyone who reads
   `scripts/provenance-canary.sh`. User's own report (`2ab14f37`) flags
   this same concern.

None of the three is a one-line change. Each needs a real session. The
worker that took this task cannot proceed without the operator's decision
on which subset to land.

## Test plan when unblocked

* Use the preserved baseline bun at
  `/private/tmp/claude-501/-Users-vvladescu--ao-data-worktrees-ccflare-orchestrator-ccflare-orchestrator/50f51e6c-015a-534d-8ba6-42de7d46233e/scratchpad/bun-baseline/bun`
  (Bun 1.3.14, sha256 `ea2f223e94bb2f4bf3050895113c3cf346438f6fa0501c8532284e063f72f7a0`).
* Run `bun install --frozen-lockfile` then `bun run build` then `bun test`
  from the merged worktree, with `TMPDIR=$RUN/tmp` per `f3524cd9` (issue
  #107 round 2).
* Under the sandbox expect 5 tests in one file to fail on `Bun.listen`
  (sandbox-only, environmental, NOT a regression per the user's baseline
  note). Run the test suite unsandboxed (with `dangerouslyDisableSandbox`
  and the baseline bun on PATH) to get the real pass count.
* After push, confirm `git show origin/main:Dockerfile | grep -E
  "sha256:(aead81873566d42926d8cbb8dc915bdd5547d2f59a8f7e46220ba83dd167b210|91bbe5b25a29561ae6fad60587fef03350acb6c74bebaef87b6031738e96bf94)"`
  produces both lines, character-exact.
* After push, build the image with the canonical `GIT_REF` / `GIT_SHA` /
  `BUILD_DATE` args, run the resulting container, and confirm
  `curl /health` returns `git_sha` equal to `origin/main` HEAD.

## Session state

* Worktree: `/Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-127`
* HEAD: `188df7a5` (unchanged)
* Working tree: clean except for this new file at
  `reports/ao-ccflare-127-provenance-merge-blocked-2026-08-02.md`
* Unpushed: none on `ao/ccflare-127/root`; this report will be committed
  and pushed to the worktree branch (NOT to `main`) when ready.
