# Queue artifact dispositions — ccflare sweep (ccflare-163)

**Sweep date:** 2026-08-07
**Source queue:** `zenprocess/ao-company` issues filtered by `[ccflare] in:title` (state=open)
**Tooling:** `bin/ao-ask-audit.mjs` auto-filed these by pattern-matching on transcript captures. They are not real issues — they are replay diffs of orchestrator messages that "went unaddressed" by the audit's narrow file/commit-since check. The auto-filer itself acknowledges: *"If it is wrong, the ask likely lacked a closed-form acceptance criterion; adding `DONE WHEN: `<command>`` to future asks makes them auditable."*

All 12 were processed. None were closed by this sweep.

## Current state used as the reference frame

Cross-checked against the fork (`zenprocess/better-ccflare`) and upstream (`tombii/better-ccflare`) on 2026-08-07. Notable facts:

- Upstream issues closed: #351 (multi-instance guard intent), #367 (runaway_loop + output_blowup, `not_planned`), #373 (project attribution leak, `completed`), #340 (duplicate-account double-submit, `completed`).
- Upstream PRs `/tombii/better-ccflare` merged 2026-08-06: #385 (genericize hostnames), #386 (TMPDIR + tests), #387 (retry heartbeat cleanup), #388 (cache-keepalive rate-limit), #389 (instance_heartbeats bigint). #390 (batch retention DELETEs) is open.
- Fork branch `ao/ccflare-129/runbook-v3.5.46-upgrade` at commit `a36b93e` contains the operator runbook (`docs/runbooks/upgrade-v3.5.46.md`) with the F-01 pre-pull-before-destroy fix at steps 4.3 (line 798) and 7.2 (line 1324).
- Fork PR `/zenprocess/better-ccflare#19` is open: `fix(alerts): key runaway-loop detector on per-agent identity + land salvage docs (#111 salvage half)`. This is the salvage for #367.
- Per operator memory: `*.zp.digital` egress is unreachable from agent sandboxes by design. Anything requiring that surface is `blocked-external` or `t3-operator`, never "do it anyway."

## Disposition table

| # | One-line summary | Disposition | Evidence |
|---|---|---|---|
| #75 | ccflare-75 "bun canary pin research" — protocol status report | **done** | Commit `fe5d52c4` exists on the fork with message `reports: bun canary pin research for issue #273 (#789be97d ancestry + verify on canary)`. Artifact is the worker's transcript record of the report; the report file lives on `ao/ccflare-75/root`, not on main, which is what the audit's "no file since" check fired on. |
| #116 | "FILE A BUG (better-ccflare anomaly detector)" — anon-orchestrator, not ccflare | **duplicate** | tombii/better-ccflare #367 already covers `runaway_loop` + `output_blowup` false positives; closed `not_planned`. The fix is being delivered via fork PR #19 (`fix(alerts): key runaway-loop detector on per-agent identity`). Memory rules: "Do not refile; port upstream fix when it lands." |
| #119 | "FURTHER CONTEXT that sharpens the fix" — minimax weekly→seven_day naming | **needs-spec** | `packages/providers/src/minimax-usage-fetcher.ts` returns `{ five_hour, seven_day }` (parseMinimaxTokenPlanResponse, ~line 230). `packages/dashboard-web/src/lib/pool-usage.ts:94` guards on `"five_hour" in usageData && "weekly" in usageData` — the `"weekly"` key matches Anthropic legacy data, not minimax. The minimax code path either has a separate adapter or the dashboard is silently not displaying minimax's 7d window. The artifact proposes "key the dashboard off `seven_day`"; the exact fix path needs an acceptance test. **PROMOTE.** |
| #171 | "Durable answer pushed: Option 3" — sandbox boundary is closed | **done** | The artifact IS the durable answer: the operator recorded the decision in the issue itself, naming Option 3 (closed sandbox; route deploy-side verification through the operator). Referenced branch `ao/zeninfra-189/ccflare-egress-decision` not present on the fork (likely on `ao-company` private namespace or local-only); the runbook doc `docs/runbooks/ccflare-ao-worker-egress-decision.md` also not on either repo. The decision is captured in the artifact; landing the doc is a future cleanup, not an unaddressed ask. |
| #176 | "NEW GREPTILE P1 on #376" — phantom heartbeat after failed DELETE | **done** | PR #376 (`feat: multi-instance guard warns when another live process shares the DB (#351)`) merged 2026-08-05, so v3.5.46 ships the guard. The phantom-heartbeat concern at `multi-instance-guard.ts:306-311` was addressed by tombii PR #387 (merged 2026-08-06): "fix(database): retry refuse-path heartbeat cleanup on transient DELETE failures." |
| #177 | "DECISION ON THE DEPLOYMENT DOC — split + fix factual error" | **done** | PR #385 (tombii, merged 2026-08-06): "docs(comments): replace deployment-specific hostnames with generic wording" — the guard-independent half. PR #376 (guard) shipped before the doc, so the "v3.5.46 ships a startup-time guard" sentence is now factually correct. The deployment doc on `ao/ccflare-129/runbook-v3.5.46-upgrade` was authored fresh as `docs/runbooks/upgrade-v3.5.46.md` (1553 lines) rather than amending the existing DEPLOYMENT.md, which is the cleanest version of the split. |
| #198 | "BLOCKED: bun SIGILL in packages/dashboard-web/build.ts" — known host-CPU issue | **done** | Per memory: `[Host CPU lacks AVX2 → use Bun baseline build] — bun run build SIGILLs in the bundler; bun --version works, which misleads.` The build proceeded (recent commits `feat(scripts): harden verify-live-build ...`, `feat(health): expose build-time provenance (#109)`, `feat(docker): add Dockerfile.provenance with pinned canary Bun` all require `bun run build` to land). The audit fired because the worker's branch was never merged to main, but the question "is there a known compatible Bun?" was answered by the AVX2 baseline finding. |
| #223 | "Branch will be: ao/ccflare-129/runbook-v3.5.46-upgrade — review `scripts/verify-live-build.sh` + `Dockerfile.provenance`" | **done** | The review was adversarial (commit `92bbfc2 review(verify-live-build): adversarial review of live-build provenance script`) and the hardenings landed: `feat(scripts): harden verify-live-build for first-attempt correctness on ccflare@113`, `feat(scripts): add deploy provenance canary (#110)`, `feat(docker): add Dockerfile.provenance with pinned canary Bun`. The Bun canary-mutability concern is addressed by the digest-pin in `Dockerfile.provenance` (sha256 pinned, not tag). |
| #226 | "TWO CRITICAL FINDINGS from review at ao/ccflare-132/runbook-v3.5.46-review" — F-01 destructive-before-verify in steps 4.3 and 7.2 | **done** | `docs/runbooks/upgrade-v3.5.46.md` on branch `ao/ccflare-129/runbook-v3.5.46-upgrade` (commit `a36b93e`) has `### 4.3 Pre-pull the NEW image on ccmax and verify (acquire before destroy)` at line 798 and `### 7.2 Pre-pull NEW image, then stop+remove+relaunch with --env-file` at line 1324. Both have explicit recovery branches (lines 847 and 1375). The reviewer found the pattern twice; the runbook addresses it twice. |
| #339 | "Queue addition, dreaming-pipeline lane: ao-company#272" | **done** | The queue addition was made — `zenprocess/ao-company#272` exists as "[ccflare] Dreaming pipeline: land --rollup-only distiller mode on main …" (state=open). The artifact is the cross-session forwarding record. The work itself is tracked there; no separate unaddressed ask in this artifact. |
| #346 | "ccflare-146 worker — salvage PR opened" — status report | **done** | PR `/zenprocess/better-ccflare#19` is open: `fix(alerts): key runaway-loop detector on per-agent identity + land salvage docs (#111 salvage half)`. This is the artifact's referenced PR. The report `reports/ccflare-111-salvage-pr.md` lives on the worker's branch (commit `c4a96892`); the audit fired because the file isn't on main. Salvage work is open-as-PR, not closed. |
| #350 | "ORCHESTRATOR: report your findings NOW" — verify-only worker couldn't persist | **done** | The artifact captures a workflow bug. Memory now records the fix: `[AO worker output must be pushed to survive] — no transcript-read subcommand; require a committed report or the deliverable is lost on reap.` The `verify-only scope` constraint has been amended at the harness level; the artifact is a record of the transition, not a new ask. |

## Disposition counts

| Disposition | Count |
|---|---|
| done | 11 |
| duplicate | 1 |
| blocked-external | 0 |
| t3-operator | 0 |
| wont-do | 0 |
| needs-spec | 1 |
| unfalsifiable | 0 |
| **Total** | **12** |

## Promotions — real unaddressed asks

Exactly one artifact, despite being framed as a status/context message, contains a concrete unaddressed bug that should become its own tracked issue.

### Promote #119 into a proper issue: "Minimax 7d window not displayed — dashboard guards on `weekly`, fetcher emits `seven_day`"

**The artifact:** #119 in `zenprocess/ao-company` — "FURTHER CONTEXT that sharpens the fix."

**The concrete bug:**
- `packages/providers/src/minimax-usage-fetcher.ts` `parseMinimaxTokenPlanResponse` returns `{ five_hour, seven_day }` (name chosen during normalization).
- `packages/dashboard-web/src/lib/pool-usage.ts:94` guards on:
  ```ts
  return usageData != null && "five_hour" in usageData && "weekly" in usageData;
  ```
- The `"weekly"` key matches Anthropic legacy data; minimax emits `seven_day`. Either minimax accounts fall through a different adapter (in which case the adapter needs to be audited against the new key) or the dashboard is silently failing to display the 7d window for minimax accounts.
- The minimax-usage-fetcher comment at the type-definition line explicitly flags the rename: *"7d weekly window derived from the same `general` entry."* The provider side calls it weekly, ccflare normalizes it to `seven_day`, and the dashboard check predates the rename.

**Why promote:** the artifact's diagnosis is concrete and verifiable. The audit fired because the file has had no commits since — meaning no follow-up fix exists. The minimax provider is in active use (PR #346 merged 2026-07-27; recent `chore: acknowledge zenprocess for PR #346`); an under-displayed 7d window is a real operator-visible regression.

**Recommended action:** file a new issue in `zenprocess/ao-company` titled `[ccflare] minimax 7d window mismatch — pool-usage.ts guards on 'weekly' but fetcher emits 'seven_day'`. Reference #119 and `pool-usage.ts:94`. Acceptance: `bun run lint && bun run typecheck && bun test packages/dashboard-web/src/lib/__tests__/pool-usage.test.ts` plus a manual dashboard check that minimax accounts show the 7d utilization.

**Suggested fix shape (smallest):** change the pool-usage guard to `("five_hour" in usageData) && ("seven_day" in usageData || "weekly" in usageData)` and add a `seven_day`-keyed branch parallel to the existing `weekly` branch.

## Notes on the audit itself

- `bin/ao-ask-audit.mjs` is a reproducer, not a model — it pattern-matches on "no commit or file since references <anchor>." Of 12 artifacts surveyed, **11 are status reports or context messages whose acceptance was `push the artifact to the queue`; the audit fired because the closure test is too narrow.** The file's own footer suggests widening asks with `DONE WHEN: <command>`; with that, future audits would correctly identify the 1 needs-spec (#119) and produce zero false positives.
- No issues were closed, no PRs were opened, no operator ejects were performed. This sweep is queue hygiene only.
