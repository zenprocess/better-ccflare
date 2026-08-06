# Issue #113 — repo-hygiene budget canary (review)

Backed by: zenprocess/ao-company issue #113.
Targets: `better-ccflare` working-tree sprawl (branches, worktrees, rescue refs, tags, unpushed, dirty-file age).
Not targets: code-quality hygiene (jscpd, biome, tsc) — already gated by `bun run verify`.

## Falsification result

**Real gap. Files were MISSING on the tree:**

- `.zp/hygiene-budgets.json` — did not exist.
- `scripts/repo-hygiene-canary.sh` — did not exist.
- `scripts/launchd/com.zenprocess.ccflare-hygiene.plist.*` — did not exist.
- launchd service `com.zenprocess.ccflare-hygiene` — not loaded (`launchctl print` returns "Could not find service").

The pre-existing `scripts/provenance-canary.sh` gates the OTHER class of hygiene
(deployment-provenance drift). No script on the tree measured repo-sprawl.

The issue's text is precise (7 named metrics, explicit `--branches --not --remotes`
over `--all`, exit codes 0/1/2). No spec gap, no `needs-spec` disposition.

## Current state vs aspirational budgets

Measured on the canonical checkout (`~/ao-projects/ccflare`):

| Metric              | Current | Issue-aspirational | Installed (this commit) |
|---------------------|--------:|-------------------:|------------------------:|
| localBranches       |   178   |   30               |     200                 |
| worktrees           |    30   |   10               |      40                 |
| ephemeralWorktrees  |     0   |    0               |       5                 |
| rescueRefs          |    38   |    0               |      50                 |
| localOnlyTags       |   189   |   10               |     200                 |
| unpushedBranchCommits|   10   |   20               |      20                 |
| dirtyFileMaxAgeHours |    0   |   48               |      48                 |

Five of seven metrics are currently over the issue's aspirational budget. The issue
explicitly warns that budgets already violated at install time produce a canary
"born red and gets ignored", AND names the GC sweep as a separate dependency
issue. Per the parent task instruction ("thresholds must be set from the CURRENT
measured value, not aspirational — a budget that is already violated on main is a
broken build, not a budget"), the committed budgets are calibrated to current
plus modest headroom so the canary passes at install and only fires when the
existing sprawl grows further. The post-GC aspirational numbers are preserved
in the issue text as the target for a follow-up commit.

Headroom rationale per metric:

- **localBranches: 200** (current 178) — 22-branch headroom covers normal session
  branch creation. Operator will tighten to ~50 immediately after the GC sweep.
- **worktrees: 40** (current 30) — covers active AO sessions and `.claude/worktrees/`
  agent scratch without alarm.
- **ephemeralWorktrees: 5** (current 0) — these are `/private/(tmp|var)/` paths.
  Zero is the steady state; 5 is a soft ceiling that tolerates in-flight
  agent tasks without alarming. Anything persistent must be GC'd.
- **rescueRefs: 50** (current 38) — rescue refs grow during active development
  and are pruned by `worktree-rescue`. The 12-ref headroom avoids false alarms.
- **localOnlyTags: 200** (current 189) — local tags are mostly mirrored upstream;
  the headroom is generous because most are noise, not sprawl.
- **unpushedBranchCommits: 20** — same value as issue spec. Current 10 is well under.
- **dirtyFileMaxAgeHours: 48** — same value as issue spec. A dirty file older
  than two days is a real signal (forgotten work, abandoned experiment).

## Proof runs

Both directions run against the committed script. Operator paths are
abbreviated in the output.

### GREEN at committed budgets (install-time contract)

```
$ ./scripts/repo-hygiene-canary.sh --repo "$PWD" --offline
localBranches=178 budget=200 OK
worktrees=30 budget=40 OK
ephemeralWorktrees=0 budget=5 OK
rescueRefs=38 budget=50 OK
localOnlyTags=189 budget=200 OK
unpushedBranchCommits=10 budget=20 OK
dirtyFileMaxAgeHours=0 budget=48 OK
EXIT=0
```

### BREACH by tightening one budget (issue #113 spec)

```
$ cat > .zp/hygiene-budgets.json <<EOF
{ "localBranches": 1, "worktrees": 40, "ephemeralWorktrees": 5,
  "rescueRefs": 50, "localOnlyTags": 200, "unpushedBranchCommits": 20,
  "dirtyFileMaxAgeHours": 48 }
EOF
$ ./scripts/repo-hygiene-canary.sh --repo "$PWD" --offline
localBranches=178 budget=1 BREACH
worktrees=30 budget=40 OK
ephemeralWorktrees=0 budget=5 OK
rescueRefs=38 budget=50 OK
localOnlyTags=189 budget=200 OK
unpushedBranchCommits=10 budget=20 OK
dirtyFileMaxAgeHours=0 budget=48 OK
EXIT=1
```

### Required-pattern gates (issue #113 acceptance)

```
$ bash -n scripts/repo-hygiene-canary.sh                && echo PARSE-OK
PARSE-OK
$ bash -n scripts/repo-hygiene-canary-launchd-wrapper.sh && echo WRAPPER-PARSE-OK
WRAPPER-PARSE-OK
$ plutil -lint scripts/launchd/com.zenprocess.ccflare-hygiene.plist.template
scripts/launchd/com.zenprocess.ccflare-hygiene.plist.template: OK
$ python3 -m json.tool .zp/hygiene-budgets.json > /dev/null && echo JSON-OK
JSON-OK
$ grep -c -- '--branches --not --remotes' scripts/repo-hygiene-canary.sh
3
$ grep -c -- '--all --not --remotes' scripts/repo-hygiene-canary.sh
0
```

### COULD_NOT_CHECK (exit 2, not green)

```
$ rm .zp/hygiene-budgets.json
$ ./scripts/repo-hygiene-canary.sh --repo "$PWD" --offline
metric=budgets-file measured=COULD_NOT_CHECK budget=- COULD_NOT_CHECK reason=missing-file path=…/.zp/hygiene-budgets.json
EXIT=2
```

## Scheduling

**Decision: NOT on GitHub Actions for this PUBLIC fork.** The fork deliberately
disables inherited upstream workflows (`.zp/project.yaml` calls this out for
issue #108/#115). Adding an always-on scheduled workflow to a public fork is a
separate operator decision and is out of scope for this commit.

**Decision: launchd on the operator Mac, every 12h.** Matches the issue's
"launchd plist OR cald check" specification and the existing fleet pattern
(`scripts/provenance-canary.sh` + its plist). The plist template is committed
at `scripts/launchd/com.zenprocess.ccflare-hygiene.plist.template` with
placeholders (`__WRAPPER_PATH__`, `__LOG_PATH__`, `__REPO_PATH__`) so the
public-fork repo contains NO absolute filesystem paths.

**Committing the template is the only repo-side action.** The operator's
remaining steps (render template → `plutil -lint` → `launchctl load -w`) are
documented as a comment block at the top of the template file and are NOT
executed by this session. Per standing-instruction "Do NOT enable or add any
workflow that runs automatically without flagging it as an operator decision",
`launchctl load` is a T3 operator action that requires explicit operator
consent.

**Alerts** route via the existing ntfy/zenctl path used by
`com.zenprocess.fabro-gate-poll` and the provenance canary. BREACH (exit 1) and
COULD_NOT_CHECK (exit 2) alert; OK (exit 0) is silent. State-change-only
alerting (alert once on entry to BREACH, once on exit) is the recommended
posture and is the orchestrator-side concern (matches the issue's
"alert once per breach state-change" requirement).

## Files in this commit

- `.zp/hygiene-budgets.json` — 7 budgets, calibrated current+headroom.
- `scripts/repo-hygiene-canary.sh` — bash, exit 0/1/2, `--repo` reusable,
  `--branches --not --remotes` (NEVER `--all`), reads `HYGIENE_REPO_PATH`
  env var as `--repo` fallback so launchd can invoke it directly.
- `.gitignore` — added `!scripts/repo-hygiene-canary.sh` exception (one
  line, with rationale comment) so the new canary is not blocked by the
  pre-existing `**/*.sh` rule. Existing tracked .sh scripts in `scripts/`
  remain grandfathered.
- `scripts/launchd/com.zenprocess.ccflare-hygiene.plist.template` — placeholder
  plist for the operator to render locally.
- `docs/reviews/issue-113-hygiene-budget.md` — this file.

## Known follow-ups

1. **GC sweep** (issue #113 dependency, separate operator action). Once the
   salvage-first sweep lands, tighten budgets to the issue-aspirational values
   (`localBranches: 30`, `worktrees: 10`, `ephemeralWorktrees: 0`, `rescueRefs: 0`,
   `localOnlyTags: 10`) in a follow-up commit. The canary will then alert on
   any subsequent sprawl — which is the actual goal of the issue.
2. **launchd registration** is operator-action (see Scheduling above).
3. **State-change-only alerting** is a wrapper concern; the canary is stateless
   by design. If the operator wires it into a stateful alerter (cald), it
   should debounce per the issue's spec.
4. **localOnlyTags metric** uses `git ls-remote` against every configured
   remote. On an air-gapped host, `--offline` overestimates (counts every local
   tag as local-only). The plist always invokes with `--offline` for hermetic
   scheduling; an online invocation can be done manually for the
   under-count-corrected view.

## Hygiene check (self-check on this branch's diff)

Public-fork leak-scan was run by the worker against `upstream/main...HEAD`
contents (the scan pattern itself is intentionally not pasted here — see
operator runbook for the literal regex). Result: **PASS, zero matched lines,
zero matched paths**. The same scan was re-run after commit; no regressions.
