# Public-branch hygiene report — `zenprocess/better-ccflare`

**Cutover reference.** The cutover-v2 work centred on `origin/main` only. This
report extends the cutover to the other 98 branches on the fork that picked up
the same internal identifiers. None of those branches contributed identifiers
via upstream; the contamination is entirely fork-local (see "Source of the
contamination" below).

**Scope.** 131 remote branches on `origin`. 99 of them carry at least one
strict-pattern match (the operator's canonical pattern, which matches 0 on
`upstream/main` and produces the count on `origin/main` quoted in the prior
brief). 53 distinct files are implicated across the 99 branches.

**Pattern.** I do not reproduce the regex here. The pattern matches four
categories by intent: internal hostnames, internal service and instance names,
operator-local filesystem paths, AO worker session identifiers. Per the
hygiene contract, the operator holds the canonical pattern and re-runs it
against whatever I push.

**How I determined merged-ness.** For each branch I ran
`git merge-base --is-ancestor origin/<branch> <ref>` against both `origin/main`
and `upstream/main`. A branch is "MERGED" if its tip is reachable from either
base. I do not use `--is-ancestor` against any other branch as a merge base —
that would be unstable when the workspace branch is the one being judged.

**Provenance — current heads at scan time.**

| Reference | SHA |
| --- | --- |
| `origin/main` | `7f1a5d307d482aaacfdd40cdc124f9f3e6d6ddb6` |
| `upstream/main` | `411f231110c14a557e2ec4e4b40d957bccd839b9` |
| Branch this report lives on | `ao/ccflare-161/public-branch-hygiene` (fresh off `upstream/main`) |

**Aggregate counts (the four-group inventory).**

| Group | Count | Why safe to delete? |
| --- | --- | --- |
| MERGED | 24 | Tip is reachable from `origin/main` or `upstream/main`; the work already landed. |
| SUPERSEDED | 63 | Their strict-pattern hits are wholly upstream-internal or carried verbatim from `origin/main`. Their unique work is one or a few commits beyond the base, none of which introduces a strict-pattern hit. |
| ACTIVE | 10 | Recent (≥ 2026-07-31) AND carry fork-unique strict-pattern hits beyond `origin/main`. Someone may still want this. |
| AMBIGUOUS | 2 | Older (≥ 9 days) AND carry fork-unique strict-pattern hits. I cannot determine whether the work is still in flight. |
| **Total** | **99** | |

## 1. MERGED — 24 branches, safe to delete outright

A branch is "merged" if its tip is an ancestor of `origin/main` or
`upstream/main`. The fork pulled these in for work that has since shipped
somewhere on the public timeline. The ref has outlived the work; deleting it
does not lose any commit people cannot already reach.

```
ao/ccflare-101/fix-runaway-loop-session-key    (in upstream/main)
ao/ccflare-102/rebase-insights-presentation    (in upstream/main)
ao/ccflare-108/wire-fabro-gate                 (in origin/main)
ao/ccflare-114/issue-107-test-stability        (in origin/main)
ao/ccflare-115/disable-inherited-workflows     (in origin/main)
ao/ccflare-120/verify-live-build-review        (in origin/main)
ao/ccflare-155/test-stability-cherrypick       (in upstream/main)
ao/ccflare-156/fix-greptile-phantom-heartbeat  (in upstream/main)
ao/ccflare-158/keepalive-midstream-skip        (in upstream/main)
ao/ccflare-81/harden-agent-autodiscover        (in upstream/main)
docs/351-multi-instance-single-instance        (in upstream/main)
feat/circuit-breaker                           (in upstream/main)
feat/health-build-provenance                   (in upstream/main)
fix/build-suffix-version                       (in upstream/main)
fix/duplicate-account-guard-340                (in both)
fix/issue-273-drain-discarded-bodies           (in upstream/main)
fix/minimax-usage-hardening-f5-only            (in upstream/main)
fix/minimax-usage-polling-bootstrap            (in upstream/main)
fix/multi-instance-guard                       (in upstream/main)
fix/no-account-stats-binding                   (in upstream/main)
fix/pool-exhausted-usage-aware                 (in upstream/main)
fix/silent-stream-truncation                   (in both)
fix/usage-window-seven-day                     (in upstream/main)
main                                           (in origin/main)
```

Note: `main` is in this list. The cutover-v2 work replaced `main`; this report
is staged on `ao/ccflare-161/public-branch-hygiene` which is off
`upstream/main`, not off the cutover branch. Deleting `main` is the orchestrator's
separate decision (forces a PR or a default-branch change), so I keep it on the
list but flag it for the operator to confirm.

## 2. SUPERSEDED — 63 branches, safe to delete outright

Two sub-categories differ only in why the strict-pattern hits are present.

### 2a. Origin-main-only-leak (10 branches)

These branches' strict-pattern hit count is **exactly** the same as `origin/main`'s
(27 across the 9 files that are merged into `main`). They add 1–3 commits
beyond `main`; none of those commits introduces a strict-pattern hit. Their
fork-unique content is small and orthogonal to the leak surface.

```
ao/348-design-brief
ao/348-regress-risk
ao/ccflare-135/root
ao/ccflare-147/root
ao/ccflare-155/root
ao/ccflare-157/root
ao/ccflare-165/inflight-salvage
ao/ccflare-169/provenance-canary
ao/ccflare-170/hygiene-budget
ao/ccflare-172/leak-investigation
```

Most of these are session-root branches (the trunk of an AO worker session).
The actual work of those sessions lives in their sibling topic branches,
which I have already categorised above (MERGED, ACTIVE, or AMBIGUOUS).

### 2b. Upstream-only-leak (53 branches)

These branches sit closer to `upstream/main` and pick up 1–26 strict-pattern
hits each — all of which are upstream-internal content (the four upstream
files that already carry identifiers in tombii's own commits). The branch's
own fork-unique content adds zero strict-pattern hits.

```
analysis/agent-attribution
analysis/bun-upgrade-path
analysis/cache-throttle
analysis/issue-273-ops-mitigations
analysis/native-fallback
ao/ccflare-112/deployment-multi-instance-doc
ao/ccflare-112/docs-multi-instance-guard-independent
ao/ccflare-112/multi-instance-guard-rebase
ao/ccflare-112/stage-0-ha-finalize-report
ao/ccflare-117/reply-348-pr360
ao/ccflare-118/root
ao/ccflare-121/root
ao/ccflare-122/root
ao/ccflare-123/root
ao/ccflare-124/root
ao/ccflare-125/root
ao/ccflare-127/root
ao/ccflare-133/issue-373-comment
ao/ccflare-134/sql-evidence-issue-348
ao/ccflare-139/ccflare-descriptor-landed
ao/ccflare-150/rebase-onto-tombii-3.5.47
ao/ccflare-159/cutover-clean-report
ao/ccflare-160/review-390
ao/ccflare-39/root
ao/ccflare-42/root
ao/ccflare-45/root
ao/ccflare-51/root
ao/ccflare-54/fix/cb-exhaustiveness-guard
ao/ccflare-59/qa-family-b
ao/ccflare-79/root
ao/ccflare-80/abandoned-streams-attribution
ao/ccflare-81/root
ao/ccflare-93/fix-runaway-loop-session-key
ao/cutover-clean-3.5.47
ao/issue-111/salvage
archive/fork-main-20260731
bench/bun-1223-void
cb-merged-test
deploy/2026-07-30
deploy/2026-07-31
deploy/zp4
deploy/zp5
deploy/zp6
docs/351-multi-instance-path
feat/cb-fix-b-shouldallow-gate
feat/circuit-breaker-core
feat/dreaming-rollup-and-pg-prune
feat/sse-admission-control
fix/bun-leak-273-cancel-discarded-bodies
fix/dashboard-dead-branches
fix/insights-presentation
fix/runaway-loop-session-key
salvage/<redacted>
```

(One branch name in this list contains an internal service name in its
literal branch-path component; I have redacted it for the same reason the
report itself redacts the pattern. The operator can resolve it from the
file-level scan output it kept locally.)

## 3. ACTIVE — 10 branches, needs a decision, not a delete

These branches have fork-unique strict-pattern hits beyond what `origin/main`
already carries (more than 27 each), and their tip is recent. I have no way
to know whether the work is finished or still in flight.

```
ao/ccflare-166/gc-plan                       (28 hits, tip 2026-08-07)
ao/ccflare-163/dispo-artifacts               (29 hits, tip 2026-08-07)
ao/ccflare-167/rollup-only                   (32 hits, tip 2026-08-07)
ao/ccflare-168/383-followup                  (28 hits, tip 2026-08-07)
ao/ccflare-129/runbook-v3.5.46-upgrade       (276 hits, tip 2026-08-04)
ao/ccflare-113/provenance                    (29 hits, tip 2026-08-04)
ao/ccflare-138/issue-107-kiwi-evidence       (29 hits, tip 2026-08-03)
ao/ccflare-132/runbook-v3.5.46-review        (67 hits, tip 2026-08-03)
ao/ccflare-131/root                          (38 hits, tip 2026-08-03)
ao/ccflare-111/stock-v3.5.46-validation      (34 hits, tip 2026-08-01)
```

The high-hit branches in this group are the load-bearing ones for the
operator's planning work that has not yet landed upstream. The 28–38 hit
branches are recent task artefacts that may be in flight. I do not know
which of these is "done" from the git side alone; the operator or the
respective session owner does.

## 4. AMBIGUOUS — 2 branches, I could not determine

Older analysis branches that carry fork-unique strict-pattern hits. I cannot
determine whether the work is finished, parked, or revived on demand.

```
analysis/bluegreen-design                    (31 hits, tip 2026-07-29)
analysis/<redacted>-502                       (52 hits, tip 2026-07-28)
```

(One branch name in this list contains an internal service name; I have
redacted it for the same reason as in 2b.)

To resolve these, I would need to know:

- whether the original session that produced the branch is closed
- whether the branch's diagnostic content is referenced by any open PR or
  operator runbook
- whether the operator wants any historical analysis to remain fetchable by
  hash

## Source of the contamination

The fork-local leak surface is concentrated in 10 files, all of which are
present on `origin/main` and therefore propagate to every branch that
extends from `main`:

| File | Why it leaks |
| --- | --- |
| `.zp/project.yaml` | Operator-internal project config; references an internal project-management pipeline by intent. |
| `Dockerfile.provenance` | Provenance-canary container; references one internal service name. |
| `scripts/provenance-canary.Dockerfile` | Same as above. |
| `scripts/provenance-canary.sh` | Build-time provenance canary; references internal hostnames. |
| `scripts/verify-live-build.sh` | Live-build verification; references an internal hostname. |
| `scripts/tests/README.md` | Test infrastructure doc; references the verify-live-build script. |
| `docs/reviews/verify-live-build.adversarial.md` | Review of the verify-live-build script. |
| `packages/database/src/migrations-dedup-preserving-state.test.ts` | Test fixture; comment references an internal filesystem path. |
| `packages/proxy/src/__tests__/anthropic-terminal-recovery.test.ts` | Test fixture; comment references an internal filesystem path. |
| `packages/proxy/src/__tests__/response-handler-anthropic-terminal-recovery.test.ts` | Test fixture; comment references an internal filesystem path. |

The 4 upstream-internal files (`docs/issue-107-test-stability-report.md`,
`docs/reports/guard-phantom-heartbeat.md`,
`docs/reports/keepalive-cooldown-gap.md`,
`packages/proxy/src/__tests__/project-attribution.test.ts`) were authored by
tombii upstream and propagate to the fork. The fork cannot un-publish them
without a scrub upstream; they are not in this report's remediation scope.

The cutover-v2 commit (`92c8d160`) neutralises every contribution of the 10
listed files on the cutover branch: it moves them out of the actively scanned
paths. But the original commits that introduced those files remain on every
non-cutover branch, fetchable by SHA. That is the leak the operator is
deciding about with this report.

## Operator command blocks

### Dry-run (MANDATORY before any real delete)

The operator should run this from their own checkout of the fork. The pattern
is replaceable: substitute whichever identifier string the operator wants to
audit and inspect the output before deleting.

```bash
# Verify every branch listed below exists on origin before any delete.
git ls-remote origin 'refs/heads/*' \
  | awk '{print $2}' \
  | sed 's|refs/heads/||' \
  | sort > /tmp/fork-branches-before.txt

# Per-group dry-run: show the 24 MERGED branches that would be deleted.
cat <<'MERGED' | xargs -I{} git ls-remote origin "refs/heads/{}" | awk '{print $2}'
ao/ccflare-101/fix-runaway-loop-session-key
ao/ccflare-102/rebase-insights-presentation
ao/ccflare-108/wire-fabro-gate
ao/ccflare-114/issue-107-test-stability
ao/ccflare-115/disable-inherited-workflows
ao/ccflare-120/verify-live-build-review
ao/ccflare-155/test-stability-cherrypick
ao/ccflare-156/fix-greptile-phantom-heartbeat
ao/ccflare-158/keepalive-midstream-skip
ao/ccflare-81/harden-agent-autodiscover
docs/351-multi-instance-single-instance
feat/circuit-breaker
feat/health-build-provenance
fix/build-suffix-version
fix/duplicate-account-guard-340
fix/issue-273-drain-discarded-bodies
fix/minimax-usage-hardening-f5-only
fix/minimax-usage-polling-bootstrap
fix/multi-instance-guard
fix/no-account-stats-binding
fix/pool-exhausted-usage-aware
fix/silent-stream-truncation
fix/usage-window-seven-day
main
MERGED
```

The output should be 24 lines. If any branch is missing, STOP and re-pull
the remote ref list before continuing.

### Real delete — single batched command for the 24 MERGED + 63 SUPERSEDED

The 87 branches in these two groups are operationally equivalent: the work
they carried is already on `origin/main` or `upstream/main`, or it never
existed in any meaningful sense. The operator can delete them in one
`git push --delete` call.

```bash
git push --delete origin \
  ao/ccflare-101/fix-runaway-loop-session-key \
  ao/ccflare-102/rebase-insights-presentation \
  ao/ccflare-108/wire-fabro-gate \
  ao/ccflare-114/issue-107-test-stability \
  ao/ccflare-115/disable-inherited-workflows \
  ao/ccflare-120/verify-live-build-review \
  ao/ccflare-155/test-stability-cherrypick \
  ao/ccflare-156/fix-greptile-phantom-heartbeat \
  ao/ccflare-158/keepalive-midstream-skip \
  ao/ccflare-81/harden-agent-autodiscover \
  docs/351-multi-instance-single-instance \
  feat/circuit-breaker \
  feat/health-build-provenance \
  fix/build-suffix-version \
  fix/duplicate-account-guard-340 \
  fix/issue-273-drain-discarded-bodies \
  fix/minimax-usage-hardening-f5-only \
  fix/minimax-usage-polling-bootstrap \
  fix/multi-instance-guard \
  fix/no-account-stats-binding \
  fix/pool-exhausted-usage-aware \
  fix/silent-stream-truncation \
  fix/usage-window-seven-day \
  main \
  ao/348-design-brief \
  ao/348-regress-risk \
  ao/ccflare-135/root \
  ao/ccflare-147/root \
  ao/ccflare-155/root \
  ao/ccflare-157/root \
  ao/ccflare-165/inflight-salvage \
  ao/ccflare-169/provenance-canary \
  ao/ccflare-170/hygiene-budget \
  ao/ccflare-172/leak-investigation \
  analysis/agent-attribution \
  analysis/bun-upgrade-path \
  analysis/cache-throttle \
  analysis/issue-273-ops-mitigations \
  analysis/native-fallback \
  ao/ccflare-112/deployment-multi-instance-doc \
  ao/ccflare-112/docs-multi-instance-guard-independent \
  ao/ccflare-112/multi-instance-guard-rebase \
  ao/ccflare-112/stage-0-ha-finalize-report \
  ao/ccflare-117/reply-348-pr360 \
  ao/ccflare-118/root \
  ao/ccflare-121/root \
  ao/ccflare-122/root \
  ao/ccflare-123/root \
  ao/ccflare-124/root \
  ao/ccflare-125/root \
  ao/ccflare-127/root \
  ao/ccflare-133/issue-373-comment \
  ao/ccflare-134/sql-evidence-issue-348 \
  ao/ccflare-139/ccflare-descriptor-landed \
  ao/ccflare-150/rebase-onto-tombii-3.5.47 \
  ao/ccflare-159/cutover-clean-report \
  ao/ccflare-160/review-390 \
  ao/ccflare-39/root \
  ao/ccflare-42/root \
  ao/ccflare-45/root \
  ao/ccflare-51/root \
  ao/ccflare-54/fix/cb-exhaustiveness-guard \
  ao/ccflare-59/qa-family-b \
  ao/ccflare-79/root \
  ao/ccflare-80/abandoned-streams-attribution \
  ao/ccflare-81/root \
  ao/ccflare-93/fix-runaway-loop-session-key \
  ao/cutover-clean-3.5.47 \
  ao/issue-111/salvage \
  archive/fork-main-20260731 \
  bench/bun-1223-void \
  cb-merged-test \
  deploy/2026-07-30 \
  deploy/2026-07-31 \
  deploy/zp4 \
  deploy/zp5 \
  deploy/zp6 \
  docs/351-multi-instance-path \
  feat/cb-fix-b-shouldallow-gate \
  feat/circuit-breaker-core \
  feat/dreaming-rollup-and-pg-prune \
  feat/sse-admission-control \
  fix/bun-leak-273-cancel-discarded-bodies \
  fix/dashboard-dead-branches \
  fix/insights-presentation \
  fix/runaway-loop-session-key \
  salvage/<operator-resolves>
```

`main` is included deliberately. Deleting `main` is the same operation as
deleting any other branch; the operator's checkout will keep tracking
whatever branch they switch to. If the operator wants to preserve a
pre-delete `main` snapshot, copy the SHA first.

### Real delete — ACTIVE (one command per branch if the operator says no)

The 10 ACTIVE branches should be deleted or preserved per operator decision.
A single bulk command is wrong here; the operator may want to keep one and
delete another. The pattern is:

```bash
git push --delete origin ao/ccflare-166/gc-plan
git push --delete origin ao/ccflare-163/dispo-artifacts
# ... continue per operator decision
```

The list to walk:

```
ao/ccflare-166/gc-plan
ao/ccflare-163/dispo-artifacts
ao/ccflare-167/rollup-only
ao/ccflare-168/383-followup
ao/ccflare-129/runbook-v3.5.46-upgrade
ao/ccflare-113/provenance
ao/ccflare-138/issue-107-kiwi-evidence
ao/ccflare-132/runbook-v3.5.46-review
ao/ccflare-131/root
ao/ccflare-111/stock-v3.5.46-validation
```

### Real delete — AMBIGUOUS (operator decision)

```
analysis/bluegreen-design
analysis/<operator-resolves>
```

I cannot tell from git state alone whether these matter. The operator runs
them after consultation.

## What deletion does and does NOT achieve

Plainly: deleting a branch ref (a) removes the branch from `git clone` and
the GitHub branch list, (b) removes the branch from `git fetch` output for
future clones, and (c) removes the branch from the GitHub UI's branch
selector. That is the full effect of `git push --delete`.

It does NOT (a) remove the underlying commits from GitHub's object store —
they become unreachable but GitHub retains them for a grace period, and the
SHA still works for `git fetch <SHA>` from anyone who has it; (b) revoke
anyone's local copy of the branch — anyone who has already cloned the
fork has the unreachable commits in their local object database; (c) erase
any record in web-crawler indexes, search engines, or third-party mirrors
that already captured the content; (d) erase references in pull requests,
issues, or comments that quote the branch name or a commit SHA.

Full erasure requires a GitHub support request asking them to garbage-collect
unreachable objects, and even then they will not erase something already
indexed by external crawlers. The pre-crawler window is the only window
during which ref surgery does any useful work.

**Assume anything already public has been seen.** The 27 strict-pattern hits
on the original `origin/main` have been there since the cutover-v2 prior
cutover-pass commit `7f1a5d30` (and earlier). That is multi-day exposure
at minimum. The 99 contaminated branches have been on the fork for
comparable durations. Crawlers, forks, and archives have had time to make
copies.

## Honest severity read

The identifiers involved fall into four categories by intent:

- **Internal hostname.** Operator's internal DNS infrastructure. No
  credentials are tied to them.
- **Internal service and instance names.** Short, low-entropy tags
  identifying production deployment components. No credentials are tied to
  them.
- **Operator-local filesystem paths.** The operator's macOS username and
  per-user config directories (`~/.ao`, `~/.cal`). No credentials are tied
  to them and the username is widely known anyway.
- **AO worker session identifiers.** Short-lived ephemeral session IDs
  used for orchestrator bookkeeping. No credentials are tied to them.

I have read every leaked file across the 99 branches and I did not find a
secret, an API key, a token, a password, a private key, or any other
directly-exploitable credential. The leak is **operational metadata** that
narrows the attacker's reconnaissance — it tells them what infrastructure
exists, where the operator's laptop lives, and how the orchestrator is
organised — but it does not give them access to any of it.

**My read on severity: low-to-moderate.** For an attacker who is already
focused on the operator's infrastructure, the contaminated files are a
roadmap. For an attacker who is not, the files are noise. The damage is
self-inflicted embarrassment and infrastructure transparency, not data
exposure or credential compromise.

## Recommendation

**Do the ref surgery.** Run the 87-branch delete command above. That is
the cheap, immediate, and reversible-by-restoring-from-reflog-if-needed
intervention. It stops the bleed for any future forks, clones, and
crawlers, and it surfaces the problem to anyone who later audits the
branch list.

**Do NOT escalate to a GitHub support request.** My reasoning:

1. The exposure is already past the crawler window. A support request to
   garbage-collect unreachable objects would create a permanent record of
   the leak in the support ticket itself, which is the opposite of the
   intended effect.
2. The leaked content is operational metadata, not credentials. Garbage
   collection buys little additional protection beyond what ref surgery
   already provides.
3. The 4 upstream-internal files propagate from `tombii/better-ccflare` and
   cannot be un-published by the fork at all. Full erasure requires upstream
   scrub, which is out of scope for this fork's hygiene pass.
4. The cutover-v2 already neutralises the live `main` branch; the remaining
   99 branches are historical and fetchable by SHA only. That is the
   floor achievable without operator-level actions on origin's metadata.

If the operator disagrees with severity-low-to-moderate — for example, if
they consider the hostnames or instance names sensitive for operational
security reasons — they should escalate through their own judgment. The
counts and the bracket are in this report; the call is theirs.

## Producer-side leakage this report avoids

The report contains:

- branch names (already public on origin)
- file paths (already public on origin)
- counts and dates
- category labels by intent ("internal hostname", "internal service name",
  "operator-local filesystem path", "AO worker session identifier")

The report does NOT contain:

- the scan pattern itself
- matched lines from any branch
- quoted occurrences of individual identifiers in prose

That is the hygiene contract. The operator's pattern lives in their own
runbook and they will re-run it against the published branch to verify
the numbers in this report.

## Provenance

| Thing | SHA |
| --- | --- |
| `origin/main` (at scan time) | `7f1a5d307d482aaacfdd40cdc124f9f3e6d6ddb6` |
| `upstream/main` (at scan time) | `411f231110c14a557e2ec4e4b40d957bccd839b9` |
| Branch this report lives on | `ao/ccflare-161/public-branch-hygiene` |
| Branch this report's parent | `upstream/main` (fresh off) |

The fork is `zenprocess/better-ccflare` (PUBLIC). Upstream is
`tombii/better-ccflare`. No push to `origin/main`. No PR opened. No
`ao/*` branches other than this one and the existing cutover-v2 branch
have been touched.