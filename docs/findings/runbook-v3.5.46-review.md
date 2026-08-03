# Adversarial review: upgrade-v3.5.46 runbook

**Reviewed branch**: `ao/ccflare-129/runbook-v3.5.46-upgrade`
**Reviewed file**: `docs/runbooks/upgrade-v3.5.46.md` (866 lines)
**Reviewer session**: `ao/ccflare-132` (ccflare-130 produced nothing; this is the first real review)
**Reviewer date**: 2026-08-03
**Status**: findings only — ccflare-129 owns the file, do not edit

---

## Calibration: known findings (already being fixed; do not re-report)

These were reported before this session and are being addressed. They set the
severity bar:

1. **Rollback (Step 0)**: `docker stop ccflare && docker rm ccflare` runs BEFORE
   `docker pull`. If the pull fails, the container is destroyed and nothing is
   running. Destructive-before-verify.
2. **Rollback (Step 0)**: the `sha256:08c93b57` literal is truncated to 8 chars
   where docker requires 64. The rollback command cannot execute.
3. **Rollback (Step 0)**: no check that the old image is still pullable from
   the registry at rollback time. Garbage-collected → upgrade is one-way.

---

## New findings, ranked by severity

### CRITICAL

#### F-01. Upgrade has the same destructive-before-verify pattern as the rollback

- **Where**: Step 4.3 (line 491-510), Step 7.2 (line 750-763)
- **Pattern**: `docker stop ccflare && docker rm ccflare` runs BEFORE
  `docker pull registry.zp.digital/ccflare:v3.5.46`. If the pull fails —
  registry unreachable from ccmax, transient network blip, image not yet
  replicated to that region's registry — the container is destroyed and
  nothing is running.
- **Concrete scenario in / outcome out**:
  - **In**: ccmax is running v3.5.44+zp6; operator begins step 4.3. The
    Docker daemon on ccmax has `registry-mirrors` set to a mirror that
    is down (a real production failure mode).
  - **Out**: `docker rm ccflare` succeeds. `docker pull` fails (DNS NXDOMAIN
    to `registry.zp.digital`). The SSH heredoc exits on `set -euo pipefail`.
    The operator's own dashboard (ccmax:8080) is now down. The rollback
    script was generated in step 0 but its `--env-file` path may differ
    from what step 4.3 launched with, and restoring the OLD image requires
    the operator to manually re-issue `docker run` with the captured digest.
    No recovery path is in the runbook.
- **Severity**: CRITICAL. The exact same pattern that was already filed for
  the rollback recurs in the upgrade. The step 4.3 branch "If `docker pull`
  fails ... STOP" only says to STOP — it does not say how to restore the
  old container that was just destroyed.
- **Suggested fix**: pre-pull the new image in a separate step that runs
  BEFORE any destructive operation. Add an explicit recovery branch: if
  pull fails after rm, restore from local image cache (`docker images
  --format '{{.Repository}}@{{.Digest}}'`) or from the rollback script
  with the captured digest.

#### F-02. Env preservation is silently lossy

- **Where**: Step 4.1 (capture, line 451-457) vs. Step 4.3 (hardcoded launch,
  line 500-510). Step 7.2 (line 753-763) repeats the same pattern.
- **Concrete scenario in / outcome out**:
  - **In**: Step 4.1 captures 6 env vars from the running container:
    `ALERT_ANOMALY_ENABLED=0`, `PORT=8080`, `BETTER_CCFLARE_DB_PATH=/data/ccflare.db`,
    `CCFLARE_DB_PATH=/data/ccflare.db`, `XDG_CONFIG_HOME=/data`,
    `NODE_ENV=production`. Step 4.3 hardcodes only 5:
    `PORT`, `NODE_ENV`, `CCFLARE_DB_PATH`, `XDG_CONFIG_HOME`, `ALERT_ANOMALY_ENABLED`.
    `BETTER_CCFLARE_DB_PATH` is captured in 4.1 but missing from 4.3.
  - **Out**: any new container code path that reads `BETTER_CCFLARE_DB_PATH`
    (the env var the project's `.env` example documents) reads
    `undefined`. Worse, the operator may have additional env vars the
    runbook does not enumerate:
    - `TZ=Europe/Bucharest` (the host OS is UTC+2 per `CLAUDE.md`;
      logs are UTC; a TZ override would matter for log timestamps)
    - `LOG_LEVEL` / `RUST_LOG` / `DEBUG` toggles
    - `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` (corporate egress)
    - `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` for custom
      Anthropic-compatible endpoints (the CLI supports `--mode
      anthropic-compatible`)
    - `ANTHROPIC_BASE_URL` overrides
    - `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`
    - additional `BETTER_CCFLARE_*` knobs beyond the six captured
    These are silently dropped. The rollback (step 0) uses
    `--env-file /etc/ccflare/ccflare.env` which preserves the FULL
    env — so the rollback preserves MORE env than the upgrade. A
    regression rolled back via the script would behave differently
    from the pre-upgrade container.
  - **Worse asymmetry**: if the operator rolls back after the upgrade,
    the rollback restores the full env. The operator may then notice
    that "rollback fixed the missing log timestamps" — confusing,
    because the runbook's framing implies rollback = "go back to what
    we had before", not "go to a better state than the upgrade gave".
- **Severity**: CRITICAL. The env block is the most-operator-customizable
  part of the deploy, and the runbook asks the operator to trust it
  (assumption 7) while providing a launch command that drops vars.
- **Suggested fix**: change step 4.3's `docker run` invocation to use
  `--env-file` (operator's existing file) instead of repeated `-e`. Or
  generate the launch command from the captured env: after step 4.1,
  `scp ccmax-env-before.txt deploy@ccmax:/etc/ccflare/ccflare.env` then
  `docker run -d --name ccflare --restart=unless-stopped -p 8080:8080
  -v /var/lib/ccflare:/data --env-file /etc/ccflare/ccflare.env
  registry.zp.digital/ccflare:v3.5.46`. Step 5.5 currently only
  re-verifies `ALERT_ANOMALY_ENABLED`; broaden it to a full env diff:
  `diff ccmax-env-before.txt <(ssh deploy@ccmax 'docker exec ccflare
  sh -c "tr '\\0' '\\n' < /proc/1/environ" | sort')` — expected empty.
  This collapses the rollback/upgrade asymmetry: both paths now use
  the same env-preservation mechanism.

---

### HIGH

#### F-03. Bun canary containment test has a false-positive class

- **Where**: Step 2.3 (line 296-326), the
  `gh api repos/oven-sh/bun/compare/<fix>...${EMBEDDED_REV}` check.
- **Concrete scenario in / outcome out**:
  - **In**: the fix commit `789be97db9b746533cf692e8367146e2d3c0d7cb`
    exists in Bun's history. At some later point, Bun reverts the fix
    (hypothetical: a bad refactor undoes the change). HEAD is now ahead
    of `789be97…` with `behind_by: 0` and `merge_base_commit.sha ==
    789be97…`, but the fix is no longer in HEAD.
  - **Out**: the containment test passes. The runbook does NOT abort.
    The build proceeds, the new image is deployed, and ccmax / ccproxy2
    silently regress the fetch-abort fix that the canary pin was
    specifically chosen for. The whole reason for the canary (vs. a
    stable Bun) is the fix.
- **Severity**: HIGH. This is the load-bearing supply-chain argument
  for using the canary. A silent regression here defeats the purpose
  of the runbook.
- **Suggested fix**: instead of (or in addition to) the merge-base
  check, verify the fix's marker in HEAD's source. For example, fetch
  `bun-fetch.ts` from HEAD and grep for the line that the fix added
  (or use `gh api repos/oven-sh/bun/contents/<path>?ref=<rev>` to read
  the file). The verify-live-build script already does structural
  verification of build artifacts; the canary check should do the
  same.

#### F-04. Canary TAG and pinned DIGEST are verified separately from the artifact built

- **Where**: Step 2.3 (verification, line 272-326) vs Step 2.4 (build,
  line 336-344).
- **Concrete scenario in / outcome out**:
  - **In**: Step 2.3 verifies `oven/bun:canary-alpine` (the LATEST
    canary, by tag). Step 2.4 builds with the digest pinned in
    `Dockerfile.provenance`, which was verified on 2026-08-01 (per
    assumption 4). These are different artifacts.
  - **Out**: three plausible scenarios:
    1. The canary tag has lost the fix (caught by F-03 → abort). ✓
    2. The canary tag still has the fix, but the PINNED digest (older)
       has lost it (the fix was reverted and re-applied at a later
       point, so older digests may not contain the fix). The canary
       check passes; the build uses a bad older digest. ✗
    3. The pinned digest still has the fix, but the canary tag was
       ahead with a regression. Build is fine; check would falsely
       abort.
  - In scenario 2, the build proceeds and the new image silently
    regresses the fix. There is no check that pulls the PINNED digest
    and verifies IT.
- **Severity**: HIGH. Same root cause as F-03 (silently regressing
  the fix) but a different mechanism.
- **Suggested fix**: in step 2.3, also pull the pinned digest (e.g.
  `docker pull registry-1.docker.io/oven/bun@sha256:<digest>` for
  each arch), extract its revision, and run the containment test on
  THAT revision. Do not rely on the canary tag alone.

#### F-05. `2>/dev/null` in step 2.3 silently swallows docker errors

- **Where**: Step 2.3 (line 289-290):
  ```
  EMBEDDED_REV=$(docker run --rm oven/bun:canary-alpine bun --revision 2>/dev/null \
      | tr -d '[:space:]')
  ```
- **Concrete scenario in / outcome out**:
  - **In**: docker daemon is down (or `docker` CLI is missing on the
    build host's PATH, or `docker pull oven/bun:canary-alpine` fails
    silently). `docker run` exits non-zero, prints to stderr, exits 0
    in the pipeline (because `tr` succeeded with empty input).
  - **Out**: `EMBEDDED_REV=""`. `echo "embedded Bun revision: $EMBEDDED_REV"`
    prints `embedded Bun revision: ` — the operator might miss the
    empty value. `gh api repos/oven-sh/bun/compare/789be97...` becomes
    `gh api repos/oven-sh/bun/compare/789be97...` with empty
    `${EMBEDDED_REV}`, which produces a URL `…/compare/789be97...`
    — GitHub may return 404 or 422. The operator is now in a state
    where the containment check appears to have run, but the answer
    is meaningless.
- **Severity**: HIGH. The whole canary argument collapses if the
  verification silently returns nothing.
- **Suggested fix**: drop `2>/dev/null`. Capture stderr. Validate
  that `EMBEDDED_REV` is exactly 40 hex chars before using it. If
  not, abort with a clear "could not extract Bun revision from canary".

#### F-06. No timeouts on /health, /api/stats, /api/insights/anomalies

- **Where**: Step 4.4 (line 530), Step 5.1 (line 590), Step 5.2
  (line 637), Step 5.3 (line 660).
- **Concrete scenario in / outcome out**:
  - **In**: the new container is up but its /health endpoint hangs
    (e.g., a DB query that never returns because the new SQLite
    migration path is incompatible with the captured CCFLARE_DB_PATH).
  - **Out**: `curl -fsS http://ccmax:8080/health` hangs indefinitely.
    `curl -fsS ... /api/stats` hangs indefinitely. The operator
    sits at the terminal waiting. There is no documented "if curl
    hangs >30s, this is a failure" branch. The runbook says "every
    step has an expected output and an 'if it differs' branch" —
    this case has neither.
- **Severity**: HIGH. At 2am, a hung curl is the kind of failure that
  causes the operator to give up and improvise. "Improvise" is the
  thing the runbook explicitly forbids in assumption 11.
- **Suggested fix**: add `--max-time 10` (or `--connect-timeout 5
  --max-time 15`) to every curl invocation. Add an explicit branch:
  "If the curl exits with code 28 (operation timeout), the container
  is hung — `docker restart ccflare` and re-verify from step 4.4."

---

### MEDIUM

#### F-07. ccproxy2 dashboard eye-check is not enforced

- **Where**: Step 5.4 (line 672-696, "BLOCKING" eye-check on ccmax
  accounts view) vs Step 7.4 (line 785-789, "Repeat every check from
  step 5 against ccproxy2:8080").
- **Concrete scenario in / outcome out**:
  - **In**: ccproxy2 is a different host with its own dashboard. A
    regression that breaks the 5h/7d rendering path would surface on
    ccproxy2's dashboard. Step 7.4 says "repeat every check from
    step 5" but step 5.4 is described as "the only one the operator
    does by eye" — there's no machine-verifiable equivalent for the
    ccproxy2 dashboard.
  - **Out**: a dashboard regression on ccproxy2 goes undetected by
    the API checks (which only hit /health, /api/stats, /api/insights/anomalies).
    The operator's "look at the page" check is missing for ccproxy2.
- **Severity**: MEDIUM. Step 6's gate (ccmax healthy) protects the
  operator's primary visibility. But step 7's gate does not provide
  equivalent protection for ccproxy2's users.
- **Suggested fix**: add an explicit step 7.4.5 "Open
  `https://ccproxy2/accounts` in a browser; confirm 5h/Weekly
  progress bars render". Or replace the manual check with a
  programmatic probe of the dashboard's data endpoint.

#### F-08. ccmax not re-checked between step 5 and step 7

- **Where**: gap between Step 6 (line 716-728) and Step 7 (line 731+).
- **Concrete scenario in / outcome out**:
  - **In**: the operator finishes step 5 successfully on ccmax, sees
    "ccmax is healthy at v3.5.46", then begins step 7. Between
    step 6's `echo` and step 7.2's `docker pull`, ccmax may
    independently degrade (e.g., the new container crashes due to
    an external dependency, the host runs out of disk, the network
    blips, the SQLite migration corrupts on second write). The
    operator is now setting up the ccproxy2 deploy without verifying
    ccmax is still up.
  - **Out**: if ccmax is down, the operator's own dashboard is also
    down — they may not realize it. When they hit step 7's failures,
    they investigate ccproxy2 first and only later discover ccmax
    also went down. The combined outage window grows.
- **Severity**: MEDIUM. Less load-bearing than F-01 / F-02 but
  meaningfully extends the outage window in a degraded scenario.
- **Suggested fix**: add an immediate pre-step-7 verification
  (`curl -fsS --max-time 5 http://ccmax:8080/health | jq .status`)
  before any ccproxy2 mutation.

#### F-09. verify-live-build.sh from origin/main against v3.5.46 source: unvalidated combination

- **Where**: Step 2.2 (line 260-263) brings in
  `scripts/verify-live-build.sh` from `origin/main`. The build source
  is the v3.5.46 tag (step 2.1). The script is run against the
  running v3.5.44+zp6 container in step 1.
- **Concrete scenario in / outcome out**:
  - **In**: the script reads `/health` fields (git_sha, git_ref,
    build_date, etc.) added in PR #109. If #109 was merged AFTER
    v3.5.46 was tagged, the v3.5.44+zp6 container does not have
    those fields. The script returns `COULD_NOT_DETERMINE` with
    `MISSING_FIELDS` populated.
  - **Out**: step 1 fails for the OLD container. The operator has
    no baseline capture. The runbook does not provide a recovery
    branch for "step 1 failed because the old image doesn't have
    /health provenance".
- **Severity**: MEDIUM. Speculative — depends on whether v3.5.44+zp6
  had #109. (Marked speculative.)
- **Suggested fix**: add a fallback in step 1: if the script
  returns COULD_NOT_DETERMINE due to missing /health fields, capture
  what is available (`docker inspect` for OCI labels, manual `/health`
  if reachable) and continue. Or, document which fields are
  load-bearing vs. nice-to-have.

#### F-10. Dockerfile.provenance from origin/main against v3.5.46 source: unvalidated combination

- **Where**: Step 2.2 (line 260-263) brings in `Dockerfile.provenance`
  from `origin/main`. The build source is the v3.5.46 tag.
- **Concrete scenario in / outcome out**:
  - **In**: `Dockerfile.provenance` is from `origin/main`. The source
    tree is from the v3.5.46 tag. If `origin/main` has added build
    args, COPY lines, or runtime expectations that the v3.5.46 source
    tree does not satisfy (e.g., expects `bun.lock` to exist in a
    specific location, expects a `bin/ccflare-server` to be present),
    the build fails with a `failed to solve` error from docker.
  - **Out**: step 2.4 fails. The runbook says to update digests in
    `Dockerfile.provenance` — but does not address source-tree
    incompatibility. The operator is left with no clear next step.
- **Severity**: MEDIUM. Speculative — depends on the actual
  Dockerfile.provenance / v3.5.46 source delta.
- **Suggested fix**: either pin `Dockerfile.provenance` and
  `verify-live-build.sh` to the same tag as the source (i.e., use
  whatever's at the v3.5.46 tag, even if it lacks provenance
  features), or document that the build is deliberately using a
  newer build infra against an older source, and list the specific
  compatibility checks the operator should run if the build fails.

#### F-11. Step 5.1 expected git_sha is shown but not enforced as a failure mode

- **Where**: Step 5.1 (line 588-627). The expected JSON shows
  `git_sha: "c3376345a7c811874dd58346af2c09b55dadf0a3"`. The failure
  modes list only checks for `unknown`.
- **Concrete scenario in / outcome out**:
  - **In**: the new container is up, but the build host was reused
    across days and `GIT_SHA` was set to a wrong value (e.g., the
    operator typo'd, or the build arg resolved to HEAD of a stale
    clone). The image's labels show a different SHA than
    `c3376345…`.
  - **Out**: /health returns 200 with `git_sha: <wrong-SHA>`, not
    "unknown". The runbook's failure modes do not catch this. The
    operator has to compare the SHA to the expected value manually.
- **Severity**: MEDIUM. The visual comparison is in the expected
  JSON, but a tired operator at 2am may not catch a mismatch.
- **Suggested fix**: add to the failure modes list: "`git_sha`
  does NOT match `c3376345a7c811874dd58346af2c09b55dadf0a3`: STOP.
  The image is not the one this runbook was designed to deploy."

#### F-12. Step 1.1 digest fallback to `config_digest` breaks rollback verification

- **Where**: Step 1.1 (line 172-173):
  ```
  DIGEST=$(jq -r '.image.manifest_digest // .image.config_digest' \
      ./verify-live-build.summary.json)
  ```
- **Concrete scenario in / outcome out**:
  - **In**: the captured summary has only `config_digest` (e.g., the
    script's manifest extraction failed but config extraction
    succeeded). The fallback returns the config digest.
  - **Out**: the rollback script is edited to use the config digest
    instead of the manifest digest. Step 0.2's verification
    (`docker manifest inspect registry.zp.digital/ccflare@sha256:<digest>`)
    may fail because `docker manifest inspect` requires a manifest
    digest, not a config digest. The rollback script also may fail
    at pull time because the @sha256 reference is a config digest
    rather than a manifest digest (docker may resolve it but with a
    warning, or may not).
- **Severity**: MEDIUM. Depends on the script's behavior — if the
  script always populates `manifest_digest`, the fallback never
  fires, but the runbook should not assume that.
- **Suggested fix**: explicitly fail if `manifest_digest` is empty,
  rather than falling back to `config_digest`. The summary should
  always have `manifest_digest`; if it doesn't, the script's manifest
  extraction broke and the operator needs to know.

#### F-16. Docker-compose fallback flips `ALERT_ANOMALY_ENABLED` by default

- **Where**: Step 4.3 (line 480-483, the parenthetical compose note above
  the SSH heredoc).
- **Concrete scenario in / outcome out**:
  - **In**: the operator runs the compose fallback
    (`docker compose pull && docker compose up -d`) instead of the
    explicit `docker run` heredoc. The existing `docker-compose.yml`
    on ccmax does not include `ALERT_ANOMALY_ENABLED` in the ccflare
    service's `environment:` block — OR includes it with
    `${ALERT_ANOMALY_ENABLED:-1}` interpolation (a common compose
    pattern that defaults to 1 if the host shell doesn't export it).
  - **Out**: the new container starts with `ALERT_ANOMALY_ENABLED=1`
    (or unset, defaulting to 1). The anomalies endpoint fires alerts
    on the deliberately-suppressed noise floor. The operator gets
    paged on false positives at 3am. The 2am upgrade window is now
    spent rolling back instead of upgrading.
- **Severity**: HIGH. This is the load-bearing case the runbook's
  assumption 7 was written for ("ALERT_ANOMALY_ENABLED=0 is
  deliberate"). The compose path has no concrete procedure, only a
  hopeful "must include" that the operator may interpret loosely.
- **Suggested fix**: replace the parenthetical with a concrete
  pre-check: before any `docker compose up`, run
  `grep -E '^\s*ALERT_ANOMALY_ENABLED' docker-compose.yml` (or
  `compose.yaml`) on the host and confirm the literal `=0` is
  present in the file (no `${...:-1}` interpolation). If absent,
  edit the compose file to add `ALERT_ANOMALY_ENABLED: "0"` under
  the `environment:` block BEFORE the `up -d`. After the up, run
  the step 5.5 verification
  (`docker exec ccflare sh -c "tr '\\0' '\\n' < /proc/1/environ | grep ^ALERT_ANOMALY_ENABLED"`)
  to confirm `=0`. Make this pre-check mandatory (not a parenthetical)
  so an operator running compose cannot skip it.

- **Where**: Step 4.2 (line 466-468). The complex `docker inspect`
  template is suggested as one option, with the parenthetical "have
  the operator eyeball the actual `docker run` line".
- **Concrete scenario in / outcome out**:
  - **In**: the existing container was launched with flags that the
    template does not capture (e.g., `--network host`, `--cap-add
    NET_ADMIN`, `--add-host=internal.api:10.0.0.5`,
    `--log-driver=json-file`, `--log-opt=...`). The template only
    captures restart policy, mounts, and ports.
  - **Out**: step 4.3's `docker run` re-launches the container
    WITHOUT those flags. Network reachability, capabilities, custom
    DNS, log shipping — all silently lost. The new container is
    running but functionally degraded in ways the runbook cannot
    detect from /health or /api/stats.
- **Severity**: MEDIUM. The operator's parenthetical "eyeballing is
  fine" suggests this is acknowledged, but the runbook then presents
  a template as a real check, which is misleading.
- **Suggested fix**: drop the template. Document the eyeballing step
  as load-bearing. Add an explicit "reconcile the captured flags
  against the new launch" check before step 4.3.

---

### LOW

#### F-14. Step 4.4 indefinite wait on "starting" health

- **Where**: Step 4.4 (line 528-541). The "starting" branch says
  "wait 30s more and re-check" with no max-iterations.
- **Concrete scenario in / outcome out**:
  - **In**: the new container's healthcheck never reports healthy
    (e.g., the healthcheck command itself is broken in the new
    image, or it depends on a file that doesn't exist).
  - **Out**: the operator re-checks "starting" indefinitely. At some
    point they give up and either proceed to step 5 (falsely believing
    the container is healthy) or abandon the runbook.
- **Severity**: LOW. The docker daemon will eventually mark the
  container unhealthy (after the failure threshold, typically 3
  retries), which the runbook's `unhealthy` branch handles. But the
  transition from starting → unhealthy can take 5+ minutes depending
  on healthcheck config.
- **Suggested fix**: add a max-iteration count or a total-time cap
  (e.g., "if still starting after 4 minutes, force a healthcheck
  inspection: `docker inspect --format '{{json .State.Health}}'
  ccflare`").

#### F-15. Build cache could yield stale labels on re-run

- **Where**: Step 2.4 (line 336-344). The build uses
  `--build-arg GIT_SHA=...` and `--build-arg BUILD_DATE=...`. The
  output is double-tagged locally and remotely.
- **Concrete scenario in / outcome out**:
  - **In**: the operator runs the build twice (e.g., once, hits a
    network failure during push, retries). The local image
    `ccflare:v3.5.46` exists from the first run with one set of
    labels. The second run uses the same GIT_SHA (deterministic
    from the tag) and the same BUILD_DATE if the operator
    reconstructs the build command within the same minute.
  - **Out**: docker build cache hits. The labels are stale. The
    expected labels in step 2.5 still match (because the labels
    were correct the first time). The push happens, but the pushed
    image is from the cached layer.
- **Severity**: LOW. The labels are likely still semantically
  correct (same GIT_SHA, same BUILD_DATE). The real risk is if
  the operator changes the Dockerfile between runs without
  invalidating the cache (a more general Docker concern).
- **Suggested fix**: add `--no-cache` to the build to force a fresh
  build, OR add `--pull` to ensure base images are re-fetched.
  Document this as required if the operator has any prior build
  state on the host.

---

## Summary table

| ID    | Severity  | Section                 | One-liner |
|-------|-----------|-------------------------|-----------|
| F-01  | CRITICAL  | Step 4.3 / 7.2          | Destructive-before-verify in upgrade (same as rollback) |
| F-02  | CRITICAL  | Step 4.1 vs 4.3         | Env drop: 6 captured vars → 5 hardcoded; rollback uses env-file, upgrade uses -e |
| F-03  | HIGH      | Step 2.3                | Containment test false positive on revert-and-not-reapply |
| F-04  | HIGH      | Step 2.3 vs 2.4         | Canary TAG verified, pinned DIGEST used in build (different artifacts) |
| F-05  | HIGH      | Step 2.3                | `2>/dev/null` silently swallows docker errors; EMBEDDED_REV can be empty |
| F-06  | HIGH      | Steps 4.4, 5.1, 5.2, 5.3 | No curl timeout; hung container freezes the runbook |
| F-07  | MEDIUM    | Step 7.4                | ccproxy2 dashboard eye-check not enforced |
| F-08  | MEDIUM    | Gap step 6 → 7          | ccmax not re-checked before ccproxy2 deploy |
| F-09  | MEDIUM    | Step 2.2 / 1            | verify-live-build.sh from main may expect fields v3.5.44+zp6 doesn't have (speculative) |
| F-10  | MEDIUM    | Step 2.2 / 2.4          | Dockerfile.provenance from main against v3.5.46 source: unvalidated combination (speculative) |
| F-11  | MEDIUM    | Step 5.1                | Expected git_sha shown but not in failure modes; wrong-SHA passes silently |
| F-12  | MEDIUM    | Step 1.1                | digest fallback to config_digest breaks manifest inspect verification |
| F-13  | MEDIUM    | Step 4.2                | docker inspect template misses --network, --cap-add, --add-host, log opts |
| F-14  | LOW       | Step 4.4                | No max iterations on "starting" health re-check |
| F-15  | LOW       | Step 2.4                | Build cache stale if re-run with same GIT_SHA within the same minute |
| F-16  | HIGH      | Step 4.3 (compose note) | Compose fallback flips ALERT_ANOMALY_ENABLED to 1 if compose file lacks the literal =0 |

---

## Notes on the review process

- **Egress**: did NOT attempt to reach ccmax, ccproxy2, or `*.zp.digital`.
  Per operator decision, DNS is NXDOMAIN and the egress allowlist is
  closed. All findings are based on reading the runbook text, not on
  probing the hosts.
- **Verification**: of the 4 adversarial verification agents dispatched
  (one per lens: destructive-before-verify, env preservation,
  silent-success, canary/build integrity), lens-2 (env preservation)
  returned a structured finding set. Its findings are folded into F-02
  (with concrete examples like `TZ`, `LOG_LEVEL`, `HTTP_PROXY`,
  `OAUTH_CLIENT_ID`/`OAUTH_CLIENT_SECRET`, `ANTHROPIC_BASE_URL`,
  `SENTRY_DSN`) and surfaced as a separate F-16 (compose fallback).
  The other 3 were either blocked by the agent-spawning gate or did
  not produce results in time. Findings above reflect my own careful
  re-read of the runbook across all four lenses plus the structured
  output from lens-2. The findings have been deduplicated and ranked.
- **Speculation labels**: F-09, F-10 are marked speculative because
  they depend on the v3.5.44+zp6 / origin/main delta, which the runbook
  does not document. All other findings are concrete scenarios with
  specific state in / wrong outcome out.
- **What was NOT re-reported**: the three known findings (rollback
  destructive-before-verify, truncated digest, no pullability check)
  are not in the table above; they are noted in the calibration
  section for severity bar calibration only.

---

## Suggested action by orchestrator

ccflare-129 owns the runbook. The two CRITICAL findings (F-01, F-02)
are the highest priority because:

1. F-01 is structurally the same as the already-flagged rollback bug;
   it appears the author was specifically asked to fix the rollback
   pattern but did not generalize the fix to the upgrade itself.
2. F-02 directly violates the runbook's own assumption 7 ("Other env
   vars … follow the same capture-and-restore discipline") — the
   capture happens, the restore does not.

The HIGH findings cluster around step 2.3 (the canary verification);
they should be addressed together because they share root cause
(the canary check is too thin to actually prove the fix is in the
artifact that ships).

The MEDIUM / LOW findings are individually less load-bearing but
together suggest the runbook would benefit from one more pass focused
on "what does each curl / docker command actually do if it returns
nothing / wrong value / stale value."