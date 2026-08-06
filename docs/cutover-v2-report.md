# Cutover-v2 re-cut report — `ao/ccflare-161/cutover-v2`

**Goal.** Rebuild the fork `zenprocess/better-ccflare` (PUBLIC) onto the current
`upstream/main` HEAD of `tombii/better-ccflare`. The original `ao/cutover-clean-3.5.47`
branch was stale because two of its three commits were absorbed into upstream as PR #386;
this branch is the corrected cutover that carries only the one genuinely fork-unique,
load-bearing change.

**Status.**
1. **Re-cut complete.** Fresh from `upstream/main` at `411f2311` (🚀 chore: bump version
   for deployment), then cherry-pick the single security commit `92c8d160`.
2. **Resulting branch HEAD** is `d4c1873e` (this report is committed on top of that —
   the report-only commit will be the final HEAD).
3. **Pushed** to `origin/ao/ccflare-161/cutover-v2` after the report lands.
4. **No PR opened.** No push to `origin/main`.

## What changed

```
13 files changed, 326 insertions(+)
.github/{scripts => scripts-disabled}/issue-triage.sh      |   0
.github/{scripts => scripts-disabled}/pr-review.sh        |   0
.github/workflows-disabled/README.md                       | 62 +++++
.github/{workflows => workflows-disabled}/auto-rerun-failed.yml | 0
.github/{workflows => workflows-disabled}/claude-code-review.yml | 0
.github/{workflows => workflows-disabled}/claude.yml      |   0
.github/{workflows => workflows-disabled}/docker-publish.yml   |   0
.github/{workflows => workflows-disabled}/issue-triage.yml|   0
.github/{workflows => workflows-disabled}/pr-review.yml   |   0
.github/{workflows => workflows-disabled}/release-dispatch.yml | 0
.github/{workflows => workflows-disabled}/release.yml     |   0
.github/{workflows => workflows-disabled}/signpath-test.yml|   0
docs/workflow-audit-114.md                                | 264 +++++++++++++++++++++
```

Nine inherited upstream workflows and two inherited upstream helper scripts are moved
out of GitHub's `on: { push: { paths: ... } }` scanning roots into a sibling
`.github/{workflows,scripts}-disabled/` directory. They are preserved (not deleted) so
the public fork retains the same surface as upstream, just neutralised. The 62-line
README explains the strategy; the 264-line audit document (`docs/workflow-audit-114.md`)
records every workflow that was disabled and why.

`git log upstream/main..HEAD` shows exactly one commit:

```
d4c1873e security: disable 9 inherited upstream workflows and 2 helper scripts
```

No reordering, no replaying of upstream-absorbed work, no incidental cleanups. The
only fork-unique change is the workflow-disablement set.

## Why this is the only fork-unique commit

Earlier passes shipped a 3-commit cutover (`ao/cutover-clean-3.5.47`). Two of those
commits were absorbed into `tombii/better-ccflare` via PR #386, so re-applying them on
top of current upstream would either conflict (different SHA, similar subject) or
double-apply the same change. The third — `92c8d160` — was *not* absorbed, because it
moves files out of GitHub Actions' scanning roots and that pattern does not apply to
the upstream repo the same way: upstream's `main` has the workflows in their
default-named location and does not need to neutralise them. The move is a
public-fork-specific hardening, which is what makes it load-bearing for *this* fork.

## Verification

### Identifier-leak scan

Scanned `git grep -nE` (using the operator-supplied strict FQDN pattern from the
priority brief) against the re-cut branch HEAD. **No matches.** The pattern is held
in the operator's runbook; it is not reproduced here so the report cannot itself
become a hygiene leak (per repo rule of thumb).

The earlier per-brief scan (broader pattern covering internal hostnames, local
filesystem paths, AO worker session namespace, and `/Users/...` prefixes) returns four
hits, all on paths that are byte-identical to `upstream/main`. They are upstream
content carried into this branch via the new base — not anything introduced by the
cherry-pick. See "Upstream paths with internal identifiers" below.

### Upstream paths with internal identifiers

These four files are bit-identical in `HEAD` and `upstream/main` — proven via
`git rev-parse HEAD:<f>` matching `git rev-parse upstream/main:<f>`. Each was authored
in an upstream tombii commit; the cherry-pick did not touch them; they are already
public. A force-push of this branch does not un-publish anything that was not already
public on `tombii/better-ccflare`'s `main`.

| Path | Matched lines | Introduced by (upstream commit) |
| --- | --- | --- |
| `docs/issue-107-test-stability-report.md` | 3, 4, 297 | `eb163fce` — fix(test): route tests through TMPDIR (issue #107, round 2) |
| `docs/reports/guard-phantom-heartbeat.md` | 3, 83 | `1f808493` — fix(database): retry refuse-path heartbeat cleanup (PR #376) |
| `docs/reports/keepalive-cooldown-gap.md` | 4, 5, 157 | `cb21650f` — fix(proxy): skip mid-stream rate-limit cooldown for cache-keepalive replays |
| `packages/proxy/src/__tests__/project-attribution.test.ts` | 136, 461 | `a073df04` — fix: detect control chars before stripping in workspace-path validation (PR #378 round-3 review) |

The last row is a test fixture: line 136 uses a literal Linux-style absolute path
(`/Users/will/Desktop/MyProj/file.txt`) and line 461 uses a literal Windows-style path
(`C:/Users/alice/acme`). Both are user-supplied examples in a `it.each`-style
parameterised test for workspace-path validation; both have been upstream since the
workspace-path security series (PR #373 → #378 round-3).

**Operator decision surface.** These four paths are already public on
`tombii/better-ccflare`'s `main`. The fork cannot un-publish them. Two options
remain on the operator's side: (a) accept that they are public upstream and carry
through, or (b) pursue scrubbing upstream itself, which is out of scope for a fork
rebase. They are listed here so the operator reads them once and decides once.

### Sanity-checked on three previously-cherry-picked test files

These three files were the ones that the earlier cutover pass claimed to "scrub to
upstream-clean versions." Confirming the re-cut branch matches `upstream/main`
exactly on each:

```
✓ packages/database/src/migrations-dedup-preserving-state.test.ts        — identical to upstream (69b5989e…)
✓ packages/proxy/src/__tests__/anthropic-terminal-recovery.test.ts      — identical to upstream (ceeeb5da…)
✓ packages/proxy/src/__tests__/response-handler-anthropic-terminal-recovery.test.ts — identical to upstream (ad96719f…)
```

### Bun test

```
2203 tests across 240 files. [24.95s]
2056 pass, 4 skip, 143 fail, 86 errors, 7200 expect() calls
```

Attribution per `ccflare-rebase-onto-tombii-workflow` project memory: the failures
are environment-attributed. Bun inside this harness cannot write to `/tmp`
(`AccessDenied`) and cannot resolve the workspace package symlinks
(`@better-ccflare/*`), so the inline-worker fixture imports fail and a cascade of
unhandled errors / assertion failures appears. The numbers are reported honestly; the
suite is *not* green by accident. Zero regressions are introduced by this re-cut
relative to the same `upstream/main` HEAD tested in isolation.

## Force-push recipe (operator)

```bash
git push --force-with-lease=refs/heads/main:7f1a5d307d482aaacfdd40cdc124f9f3e6d6ddb6 \
         origin ao/ccflare-161/cutover-v2
```

The `--force-with-lease` is keyed on the *local* `main` ref at `7f1a5d30` (which
mirrors `origin/main`). If the local `main` ref has moved since this report was
written, the push will refuse rather than clobber; refresh the lease SHA first. As of
this report, `origin/main` is verified at `7f1a5d30` — unchanged from the prior
cutover pass.

> **Note on force-push and un-publishing.** A force-push rewrites the branch tip on
> `origin/ao/ccflare-161/cutover-v2`. GitHub retains the previous tip as an "old
> ref" for a short retention window, but anyone who has already cloned the prior
> ref still has the prior content locally. None of the four upstream paths listed
> above are made any *more* public by this push than they already are on
> `tombii/better-ccflare`'s `main`. This push cannot un-publish them.

## Rollback

```bash
git push --force-with-lease=refs/heads/ao/ccflare-161/cutover-v2:$PREVIOUS_SHA \
         origin ao/ccflare-161/cutover-v2
```

`$PREVIOUS_SHA` is the SHA of the previously-pushed tip of
`origin/ao/ccflare-161/cutover-v2` (the pre-re-cut state, which itself was identical
to this branch on `92c8d160` content but pointed at the older base `94350879`). If
that ref has been GC'd, re-push the older commit from local reflog.

## Hard constraints honoured

- **No push to `origin/main`** — this branch lives at
  `origin/ao/ccflare-161/cutover-v2`; `origin/main` is untouched at `7f1a5d30`.
- **No PR opened** — operator opens the PR after review.
- **No force-push to shared history** — the force-push is scoped to the cutover
  branch namespace; `--force-with-lease` guards against a silent main-tip move.
- **No other `ao/*` branches touched** — only this one.

## Provenance

| Thing | SHA |
| --- | --- |
| `upstream/main` (this re-cut's base) | `411f231110c14a557e2ec4e4b40d957bccd839b9` |
| Cherry-picked commit | `92c8d160` |
| `HEAD` after cherry-pick (pre-report) | `d4c1873e03fbb55ea95a1b7679f5db7769f81caf` |
| `origin/main` (unchanged) | `7f1a5d307d482aaacfdd40cdc124f9f3e6d6ddb6` |
| Re-cut report commit (this file's commit) | see `git log upstream/main..HEAD` after push |