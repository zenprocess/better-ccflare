# Cutover prep — `zenprocess/better-ccflare` main ← `ao/ccflare-150/rebase-onto-tombii-3.5.47`

**Prepared by:** worker ccflare-154
**Target branch:** `origin/ao/ccflare-150/rebase-onto-tombii-3.5.47`
**Operator action:** the destructive `git push --force-with-lease` of origin/main is NOT performed by this worker. It is below as a copy-paste block for the operator (T3).

---

## 1. Rescue tag (additive, safe)

Pre-cutover `origin/main` SHA preserved as a tag and pushed to remote.

| Field | Value |
|-------|-------|
| Tag name | `rescue/pre-tombii-cutover-main` |
| Remote | `origin` (https://github.com/zenprocess/better-ccflare.git) |
| SHA the tag points at | `7f1a5d307d482aaacfdd40cdc124f9f3e6d6ddb6` |
| Equals `origin/main` at prep time | yes |

Verification (already run by worker):

```
$ git ls-remote origin rescue/pre-tombii-cutover-main
7f1a5d307d482aaacfdd40cdc124f9f3e6d6ddb6	refs/tags/rescue/pre-tombii-cutover-main
```

Restore-from-tag command is in §5 below.

---

## 2. Independent verification of target branch

All checks re-derived from `origin/ao/ccflare-150/rebase-onto-tombii-3.5.47`
(SHA at prep time: `299f070edf6b7e069086cca4e484ba95c0bcbfb6`).
Not relied on prior worker reports.

### 2a. Forbidden files ABSENT on the branch

For each of the 5 operator-internal files, `git cat-file -e <ref>:<path>` was run.
All 5 reported `ABSENT (EXPECTED)`:

```
=== .zp/project.yaml ===
ABSENT (EXPECTED): git cat-file -e failed for .zp/project.yaml
=== Dockerfile.provenance ===
ABSENT (EXPECTED): git cat-file -e failed for Dockerfile.provenance
=== scripts/verify-live-build.sh ===
ABSENT (EXPECTED): git cat-file -e failed for scripts/verify-live-build.sh
=== scripts/provenance-canary.sh ===
ABSENT (EXPECTED): git cat-file -e failed for scripts/provenance-canary.sh
=== docs/reviews/verify-live-build.adversarial.md ===
ABSENT (EXPECTED): git cat-file -e failed for docs/reviews/verify-live-build.adversarial.md
```

### 2b. `git grep -inE 'zp\.digital|dellsrv|ccmax|ccproxy2|10\.0\.201'` classification

9 grep hits on the target branch. Each classified by checking the same path on `upstream/main` (SHA `6f2c9d28bda4939e3a3b391b9ca6071200248582`).

| # | File | Line | Pattern | Origin | Verdict |
|---|------|------|---------|--------|---------|
| 1 | `CB-INTEGRATION-REPORT.md` | 186 | `ccmax.zp.digital` | inherited from `upstream/main` (commit `c7b108f3`) | ✅ NOT a blocker — pre-existing upstream content |
| 2 | `packages/dashboard-web/src/components/accounts/RateLimitProgress.test.tsx` | 271 | `ccmax` | inherited from `upstream/main` | ✅ NOT a blocker — pre-existing test comment |
| 3 | `packages/database/src/migrations-dedup-preserving-state.test.ts` | 15 | `ccmax` | inherited from `upstream/main` | ✅ NOT a blocker — pre-existing test comment |
| 4 | `packages/http-api/src/handlers/__tests__/health-usage-exhausted.test.ts` | 286 | `ccproxy2` | inherited from `upstream/main` | ✅ NOT a blocker — pre-existing test comment |
| 5 | `packages/http-api/src/services/__tests__/anomaly-insights.test.ts` | 253 | `ccmax` | inherited from `upstream/main` | ✅ NOT a blocker — pre-existing test comment |
| 6 | `packages/http-api/src/services/__tests__/anomaly-insights.test.ts` | 320 | `ccmax` | inherited from `upstream/main` | ✅ NOT a blocker — pre-existing test comment |
| 7 | `packages/proxy/src/__tests__/anthropic-terminal-recovery.test.ts` | 677 | `ccproxy2` | inherited from `upstream/main` | ✅ NOT a blocker — pre-existing test comment |
| 8 | `packages/proxy/src/__tests__/response-handler-anthropic-terminal-recovery.test.ts` | 230 | `ccmax` | inherited from `upstream/main` | ✅ NOT a blocker — pre-existing test comment |
| 9 | `packages/proxy/src/handlers/proxy-operations.ts` | 1532 | `ccproxy2` | inherited from `upstream/main` | ✅ NOT a blocker — pre-existing production-trace comment |

**Zero Category (ii) hits (originates from our side).** All 9 hits are inherited from upstream/main. The pre-existing report (`docs/reports/rebase-onto-tombii-3.5.47.md` at the prep-time SHA `299f070e`) had 7 additional hits — all in this report file itself, addressed in §3 below.

### 2c. Commits on top of upstream/main

```
$ git rev-list origin/ao/ccflare-150/rebase-onto-tombii-3.5.47 ^upstream/main --count
4
```

**Important deviation from the brief:** the brief specified "exactly 3 commits". The actual count is **4** because the audit report commit was also pushed onto the branch. The 4 commits, oldest first:

| # | SHA | Subject |
|---|-----|---------|
| 1 | `49779c2c` | security: disable 9 inherited upstream workflows and 2 helper scripts |
| 2 | `76e1f5f1` | fix(test): make full bun test suite reliably green (issue #107) |
| 3 | `2184e079` | fix(test): route tests through TMPDIR so suite passes under harness sandbox (issue #107, round 2) |
| 4 | `299f070e` | docs(report): rebase onto tombii 3.5.47 audit + test results |

The first 3 are the cherry-picked surviving commits from origin/main's 13 ahead. The 4th is the audit-report commit. The 10 dropped origin/main commits, the audit-table contents, and the cherry-pick rationale are all in `docs/reports/rebase-onto-tombii-3.5.47.md` (now sanitized — see §3).

**Operator decision needed (optional):** if the operator prefers only the 3 cherry-picks on top of upstream/main (no audit commit), rebase as `git rebase --onto upstream/main 49779c2c^ ao/ccflare-150/rebase-onto-tombii-3.5.47` and the audit file is left on a separate branch. This worker did NOT rewrite history; the choice is the operator's.

---

## 3. Report file (`docs/reports/rebase-onto-tombii-3.5.47.md`) decision

**Chosen action: GENERALISE** (do not remove).

**Why:**
- The audit table preserves useful provenance: which of `origin/main`'s 13 ahead commits survived, which dropped, and why. Future readers can `git log origin/main` to see the original commits but having a curated table is cheaper.
- The machine-name literals in the table body and the cleanliness-check section were operator-internal references that have no value to a public reader; they only describe the dropped commits.
- All 5 forbidden files and 9 of the 9 grep hits are accounted for; the file no longer contains any brief-pattern hits.

**Sanitization applied** (working tree diff, applied as commit on top of `299f070e`):

- Line 28 (drop #1 — `.zp/project.yaml`): `(\`dellsrv\`, \`argus\`, \`forkd\`, \`fabro\`, \`bin/fabro-github-gate.sh\`, \`ao-company #114\`)` → `(hostnames, services, helper scripts, and internal tracker tickets — all names redacted)`
- Line 28 (drop #1 subject): `feat(zp): add .zp/project.yaml for fabro/qa-pipeline gate (issue #108)` → `feat(zp): add .zp/project.yaml for [internal-pipeline]-gate (issue #108)`
- Line 31 (drop #4 — `verify-live-build.sh` hardening): `Comments reference \`ccproxy2.zp.digital\`, \`ccmax.zp.digital\`, sandbox DNS for \`*.zp.digital\`` → `Comments reference operator-internal DNS hostnames (names redacted) and sandbox DNS for internal-name TLDs`
- Line 33 (drop #6 — provenance canary): `posts results to \`http://ccproxy2.zp.digital:8080/health\` and depends on \`dellsrv/registry.zp.digital\`` → `posts results to an operator-internal HTTP endpoint and depends on operator-internal registry hostnames (names redacted)`
- Lines 175–176 (cleanliness-check scan description): `\`*.zp.digital\`, \`dellsrv\`, \`fabro\`, \`argus\`, \`forkd\`, \`ccproxy2.zp\`` → `internal-DNS-hostname patterns, operator-internal-host shortnames, internal orchestrator/service names`
- Line 178 (cleanliness-check hit description): `\`ccmax.zp.digital\`` → `\`<internal-host>.<internal-TLD>\``
- Line 207 (follow-up note): `\`cbmax.zp.digital\`` → `operator-internal-DNS-hostname`

**Post-sanitization grep on the file:**
```
$ grep -nE 'zp\.digital|dellsrv|ccmax|ccproxy2|10\.0\.201' docs/reports/rebase-onto-tombii-3.5.47.md
(empty = clean)
```

---

## 4. This deliverable's commit

| Field | Value |
|-------|-------|
| Commit | `docs(reports): add cutover-prep.md and sanitize rebase-onto-tombii-3.5.47.md` |
| Will land on | `origin/ao/ccflare-150/rebase-onto-tombii-3.5.47` |
| New SHA on target branch after push | reported in §5 verification step |

---

## 5. Operator copy-paste command block

### 5a. PRE-FLIGHT (operator runs from this worktree after this commit is pushed)

```bash
cd /Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-154
git fetch origin
EXPECTED_MAIN_SHA=$(git rev-parse rescue/pre-tombii-cutover-main)
EXPECTED_TARGET_SHA=$(git rev-parse origin/ao/ccflare-150/rebase-onto-tombii-3.5.47)
echo "Rescue tag:    $EXPECTED_MAIN_SHA  (= current origin/main)"
echo "Target branch: $EXPECTED_TARGET_SHA"
git ls-remote origin rescue/pre-tombii-cutover-main
git ls-remote origin refs/heads/ao/ccflare-150/rebase-onto-tombii-3.5.47
```

The two `git ls-remote` outputs must equal the SHAs above. If they don't, STOP — the target or rescue tag moved between prep and now.

### 5b. CUTOVER (T3, operator runs — NOT this worker)

```bash
cd /Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-154
git push origin \
  ao/ccflare-150/rebase-onto-tombii-3.5.47:refs/heads/main \
  --force-with-lease=refs/heads/main:$EXPECTED_MAIN_SHA
```

`--force-with-lease=refs/heads/main:<expected-sha>` refuses to overwrite if main has moved since this prep. If it refuses, STOP — re-investigate before retrying.

### 5c. POST-CUTOVER VERIFICATION (operator runs)

```bash
# main now points at target
NEW_MAIN_SHA=$(git ls-remote origin refs/heads/main | awk '{print $1}')
echo "origin/main SHA after cutover: $NEW_MAIN_SHA"

# should equal target-branch tip (or be a fast-forward of it)
[ "$NEW_MAIN_SHA" = "$(git rev-parse origin/ao/ccflare-150/rebase-onto-tombii-3.5.47)" ] \
  && echo "OK: origin/main == target tip" \
  || echo "WARN: origin/main diverged"

# forbidden files still absent
for f in .zp/project.yaml Dockerfile.provenance scripts/verify-live-build.sh \
         scripts/provenance-canary.sh docs/reviews/verify-live-build.adversarial.md; do
  git cat-file -e origin/main:$f 2>/dev/null \
    && echo "BLOCKER: $f PRESENT on origin/main" \
    || echo "OK: $f absent"
done

# brief grep pattern on new main
git grep -nE 'zp\.digital|dellsrv|ccmax|ccproxy2|10\.0\.201' origin/main || echo "OK: zero hits"

# rescue tag still resolvable
git ls-remote origin rescue/pre-tombii-cutover-main
```

### 5d. ROLLBACK (if cutover went wrong)

```bash
cd /Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-154
git push origin \
  rescue/pre-tombii-cutover-main:refs/heads/main \
  --force
```

The rescue tag points at `7f1a5d307d482aaacfdd40cdc124f9f3e6d6ddb6` (the pre-cutover main). This restores `origin/main` to exactly that SHA. After rollback, run §5c verification again.

---

## 6. Open follow-ups (operator's call)

1. **4-vs-3 commit discrepancy:** see §2c. Decide whether to keep the audit commit on main or rebase it off into a separate branch.
2. **9 inherited upstream hits** (§2b rows 1–9): all in `upstream/main`'s own code, not ours. Worth filing an upstream issue on `tombii/better-ccflare` to scrub them, but out of scope for this cutover.
3. **`origin/main`'s reflog:** the dropped commits and the `rescue/pre-tombii-cutover-main` tag remain recoverable for ~30–90 days (reflog/expiry window). Anything longer than that needs an explicit backup.

Co-Authored-By: Claude <noreply@anthropic.com>
