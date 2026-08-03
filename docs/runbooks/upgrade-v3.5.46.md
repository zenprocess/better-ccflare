# Runbook: Upgrade ccmax + ccproxy2 from v3.5.44+zp6 → upstream v3.5.46

> **Author**: AO implementation worker (session `ao/ccflare-129`)
> **Operator-issued order** (overrides any canary-first pattern): **ccmax FIRST, then ccproxy2**.
> **Bad outcome visibility**: ccmax is the operator's own dashboard. A regression is
> visible there before the operator ever SSHes to ccproxy2. This is a load-bearing
> reason for the fixed order — do not swap to ccproxy2-first even if ccmax looks
> quiet.
> **Egress reality**: the AO sandbox cannot reach ccmax, ccproxy2, or `*.zp.digital`
> (DNS is NXDOMAIN by operator decision; egress allowlist closed). This runbook is
> the only path from a sandboxed worker to those hosts. Do not invent workarounds.

---

## Assumptions (explicit — correct now or the runbook misbehaves)

1. **Two hosts**: `ccmax` and `ccproxy2`. Both run the ccflare container via
   Docker (podman works equivalently — the verify script auto-detects). Both are
   reachable from the operator's workstation over SSH.
2. **Current version**: tag `ccflare:v3.5.44+zp6` (or `:v3.5.44` re-tagged locally).
   Reported image manifest digest: `sha256:08c93b57…` — **treated as unverified
   until step 1 captures it on the running container**. Do not roll back to that
   digest from memory; step 1 records the exact one.
3. **Target version**: upstream tag `v3.5.46` of `zenprocess/better-ccflare`,
   built with **`Dockerfile.provenance`** from `origin/main` of this fork. **Do NOT
   build with `./Dockerfile`** — that one downloads a prebuilt binary and loses
   the OCI labels and `/health` provenance fields this runbook verifies.
4. **Bun canary is mutable**: `oven/bun:canary-alpine` is the only tag that ships
   `bun#35093` (fetch-abort fix). The pinned digests in `Dockerfile.provenance`
   (`aead8187…` amd64 / `91bbe5b25a…` arm64) were verified on 2026-08-01; step 3
   re-verifies containment at build time. If the canary loses the fix, ABORT.
5. **Build host ≠ deploy host**. The build host needs to reach Docker Hub
   (`registry-1.docker.io`) and GitHub (`api.github.com`). It does NOT need to
   reach ccmax / ccproxy2. A laptop on the operator's network is fine.
6. **Registry**: the build host pushes the image to the operator's private
   registry (e.g. `registry.zp.digital/ccflare:v3.5.46`). ccmax and ccproxy2 pull
   from that registry. If the operator uses a different naming scheme, substitute
   the tag accordingly — the runbook's commands reference `$IMAGE` as a placeholder.
7. **Env preservation**: `ALERT_ANOMALY_ENABLED=0` is **deliberate**. It must
   not flip to `1` as a side effect of the upgrade. Step 4 captures the full env
   from the running container; step 5 deploys the new container with the same
   env block. Other env vars (PORT, BETTER_CCFLARE_DB_PATH, …) follow the same
   capture-and-restore discipline.
8. **Container name**: `ccflare` (the `verify-live-build.sh` default). If the
   operator's compose stack prefixes it (e.g. `zp_ccflare_1`), pass
   `--container ccflare` and the script's strategy-C substring match will find
   it. If ambiguity arises, the script exits 2 with a candidate list — pick with
   `--container <NAME|id>`.
9. **Health port**: 8080 (the canonical Dockerfile `PORT` env). Override only
   if the operator has remapped it.
10. **Auth on /api endpoints**: the verify steps in step 6 require an API key
    with admin scope on each host. Use the operator's pre-existing admin key;
    this runbook never asks the operator to mint one. If `/api/stats` returns
    401, that's a key-scope problem, not a regression — do not treat it as a
    failure of the upgrade.
11. **No debugging expected**: every step has an expected output and an "if it
    differs" branch. If any check diverges and the branch says STOP, stop —
    do not improvise.

---

## Step 0 — Rollback target (record before anything changes)

Open a fresh terminal window. Keep it open for the entire runbook. Paste every
command exactly. Record outputs in a scratch file:

```bash
mkdir -p ~/ccflare-upgrade-2026-08-03
cd ~/ccflare-upgrade-2026-08-03
```

### 0.1 Rollback target (one-liner per host — recorded NOW)

```bash
cat > rollback-ccmax.sh <<'EOF'
#!/usr/bin/env bash
# Rollback ccmax to v3.5.44+zp6. ONE command. No investigation.
# Pre-condition: the previously-running image's digest is sha256:08c93b57…
# (verified by step 1; substitute the captured digest if step 1 differs).
set -euo pipefail
docker stop ccflare && docker rm ccflare
docker pull registry.zp.digital/ccflare@sha256:08c93b57
docker run -d --name ccflare --restart=unless-stopped \
    --env-file /etc/ccflare/ccflare.env \
    -p 8080:8080 \
    -v /var/lib/ccflare:/data \
    registry.zp.digital/ccflare@sha256:08c93b57
EOF
chmod +x rollback-ccmax.sh

cat > rollback-ccproxy2.sh <<'EOF'
#!/usr/bin/env bash
# Rollback ccproxy2 to v3.5.44+zp6. ONE command. No investigation.
set -euo pipefail
docker stop ccflare && docker rm ccflare
docker pull registry.zp.digital/ccflare@sha256:08c93b57
docker run -d --name ccflare --restart=unless-stopped \
    --env-file /etc/ccflare/ccflare.env \
    -p 8080:8080 \
    -v /var/lib/ccflare:/data \
    registry.zp.digital/ccflare@sha256:08c93b57
EOF
chmod +x rollback-ccproxy2.sh
```

> **The env-file paths (`/etc/ccflare/ccflare.env`) are the operator's choice.**
> Substitute the actual paths the operator uses. The crucial property is that
> the rollback script uses the **same** env file the running container was
> launched with. Step 4 captures it.

### 0.2 Confirm the digests match the captured ones after step 1

The `sha256:08c93b57…` literal in the rollback scripts is a **placeholder**
based on the operator's report. Step 1 captures the live digest. After step 1,
edit the rollback scripts and substitute the verified digest. If the captured
digest does not start with `08c93b57`, the operator's report was wrong — use
whatever step 1 captured. The rollback script must point at a digest that
**actually exists in the registry** at rollback time; verify with
`docker manifest inspect registry.zp.digital/ccflare@sha256:<digest>`
before relying on the rollback script.

---

## Step 1 — Capture ccmax FIRST (evidence is destroyed by the upgrade)

> This is the **first** step on the first host. The /health fields, Bun revision,
> and OCI labels of the current image are irrecoverable after the deploy. Capture
> them now, on ccmax, before touching anything.

Run from the **operator's workstation** (where `jq`, `curl`, and `ssh` are
available). The script does NOT need root on ccmax; it needs SSH access as a
user who can run `docker` (the operator's deploy user).

```bash
cd ~/ccflare-upgrade-2026-08-03

# Capture ccmax. Container default name is 'ccflare'; override if compose-named.
scripts/verify-live-build.sh \
    --ssh deploy@ccmax \
    --container ccflare \
    --health-port 8080 \
    -o ccmax-before.txt
echo "exit=$?"
```

**Expected output** (last lines of `ccmax-before.txt`):

```
STATUS:              VERIFIED_MATCH
REASON:              all_corroboration_checks_pass
SUMMARY_FILE:        ./verify-live-build.summary.json
```

**If `STATUS: VERIFIED_MATCH`**: copy `ccmax-before.txt` and
`verify-live-build.summary.json` into the run directory and proceed to step 2.

**If `STATUS: VERIFIED_DRIFT`** (exit 1): the current ccmax image has
disagreements between `/health` and its OCI labels. **STOP.** Do not proceed.
This means the operator's report about what's running on ccmax does not match
reality. Investigate before upgrading. Possible causes: a partial prior upgrade,
a re-tag, or a label edit. Capture the `DRIFT_SIGNALS:` block; you'll need it.

**If `STATUS: COULD_NOT_DETERMINE`** (exit 2): the script could not obtain one
of the required signals. Look at `MISSING_FIELDS:` and re-run with `--debug`.
The most common causes: container not found (use `--container <NAME|id>`);
`/health` not reachable (port mismatch); `jq` missing on the operator's
workstation (`brew install jq`).

### 1.1 Record the captured digest (write into the rollback scripts)

```bash
DIGEST=$(jq -r '.image.manifest_digest // .image.config_digest' \
    ./verify-live-build.summary.json)
echo "Captured ccmax image digest: $DIGEST"

# Substitute into both rollback scripts. The captured digest is what the
# rollback ACTUALLY rolls back to — the operator's reported sha256:08c93b57
# is a placeholder until this step confirmed it.
sed -i '' "s|sha256:08c93b57|${DIGEST#*@}|g" rollback-ccmax.sh rollback-ccproxy2.sh
grep -H "registry.zp.digital" rollback-*.sh
```

**Expected output**:

```
Captured ccmax image digest: registry.zp.digital/ccflare@sha256:08c93b57…
rollback-ccmax.sh:registry.zp.digital/ccflare@sha256:08c93b57…
rollback-ccproxy2.sh:registry.zp.digital/ccflare@sha256:08c93b57…
```

**If the captured digest does not start with `08c93b57`**: the operator's
report was inaccurate. Use the captured value. The previously-recorded
"current version v3.5.44+zp6" claim is still trusted only if the git_sha
from `/health` matches what `git rev-parse v3.5.44` resolves to in the
clone used to build that image. This runbook does not require git_sha to
match a specific upstream commit — it requires only that the OCI label
`org.opencontainers.image.version` says `v3.5.44+zp6` or equivalent. If
the label says something else, **STOP and ask the operator**.

### 1.2 Stash the Bun revision from the captured container (sanity-check only)

```bash
jq -r '.bun_revision.value' ./verify-live-build.summary.json
```

**Expected**: a 40-char hex SHA. The next deploy's Bun revision will be the
same (Dockerfile.provenance pins it) — but a non-40-char result here means
the method was `none` or `jq_unavailable`. Verify that the method is not
`none`:

```bash
jq -r '.bun_revision.method' ./verify-live-build.summary.json
```

**Expected**: one of `exec_bun`, `build_snapshot:/etc/ccflare-bun-revision`,
or `strings:/app/ccflare-server`.

**If `none`**: the existing image's Bun revision is not extractable. **STOP.**
The next deploy's image will be just as opaque. Re-check by SSHing to ccmax
manually and running `docker exec ccflare cat /etc/ccflare-bun-revision`.
If even that returns nothing, the currently-running image was built with
the old `Dockerfile` (not `Dockerfile.provenance`), and **the
`/health` provenance fields will be absent on the current image**. Note this
and proceed to step 2; the new deploy will fix it.

---

## Step 2 — Build the new image (once, reusable for both hosts)

> This step happens **once**, on the build host. The resulting image is pushed
> to the registry and pulled by both ccmax and ccproxy2.

### 2.1 Clone the fork and check out v3.5.46

```bash
cd ~/ccflare-upgrade-2026-08-03
git clone https://github.com/zenprocess/better-ccflare.git src 2>&1 | tail -3
cd src
git fetch --all --tags
# Tag v3.5.46 in upstream as of 2026-08-03: c3376345a7c811874dd58346af2c09b55dadf0a3
git checkout -B upgrade/v3.5.46 v3.5.46
```

**Expected**:

```
Switched to a new branch 'upgrade/v3.5.46'
```

**If `git checkout` fails with `error: pathspec 'v3.5.46' did not match`**: the
tag has not been fetched. Run `git fetch --all --tags` again; if it still
fails, the operator's network cannot reach the upstream. **STOP.**

### 2.2 Bring in the build files from origin/main

The Dockerfile.provenance and verify-live-build.sh live on `origin/main` of
this fork, not on the v3.5.46 tag. Materialise them at the v3.5.46 source
state without merging commits:

```bash
git checkout origin/main -- Dockerfile.provenance scripts/verify-live-build.sh
ls -la Dockerfile.provenance scripts/verify-live-build.sh
```

**Expected**: both files present, sizes > 0.

### 2.3 Re-verify the Bun canary pin BEFORE building (mandatory)

> This is the check the runbook explicitly asks for. The canary tag is mutable;
> its content can change without the digest changing unless the operator re-pins.

```bash
# Pull the canary manifest digest from Docker Hub (public).
AMD64_DIGEST=$(curl -sS \
    -H "Accept: application/vnd.docker.distribution.manifest.v2+json" \
    -H "Accept: application/vnd.oci.image.manifest.v1+json" \
    "https://registry-1.docker.io/v2/oven/bun/manifests/canary-alpine" \
    | jq -r '.config.digest // empty')
echo "amd64 config digest: $AMD64_DIGEST"
```

**Expected**: a `sha256:` digest. Note that this is the **config digest** from
the registry's manifest endpoint; the `Dockerfile.provenance` pins the **manifest
digest** (one level up). Both should agree when the canary is unchanged.

```bash
# Read the embedded Bun revision from the canary image (extract via docker).
docker pull oven/bun:canary-alpine >/dev/null
EMBEDDED_REV=$(docker run --rm oven/bun:canary-alpine bun --revision 2>/dev/null \
    | tr -d '[:space:]')
echo "embedded Bun revision: $EMBEDDED_REV"
```

**Expected**: a 40-char hex SHA like `f68e504ae48a5a54eb3017f29baa99dd31660a5e`.

```bash
# Containment test: the canary must be AHEAD or IDENTICAL of the fix commit
# (789be97db9b746533cf692e8367146e2d3c0d7cb), with 0 commits behind.
# This is the step that matters. The fix must be in the canary's history.
gh api repos/oven-sh/bun/compare/789be97db9b746533cf692e8367146e2d3c0d7cb...${EMBEDDED_REV}
```

**Expected output** (key fields):

```json
{
  "status": "ahead",
  "ahead_by": <positive integer>,
  "behind_by": 0,
  "merge_base_commit": { "sha": "789be97db9b746533cf692e8367146e2d3c0d7cb", ... }
}
```

**Required assertions**:
- `status` ∈ {`ahead`, `identical`}
- `behind_by` == 0
- `merge_base_commit.sha` == `789be97db9b746533cf692e8367146e2d3c0d7cb`

**If any check fails**: the canary no longer contains `bun#35093`. **ABORT
the build.** Do not pin the new digest into `Dockerfile.provenance` and proceed
— the supply-chain argument for the canary is that it contains the fix. Without
the fix, the deploy is unprovable. Report the failed check to the operator;
the operator decides whether to wait for the canary to recover or to fall
back to the previous image (which is what the rollback scripts in step 0 are
for).

### 2.4 Build the image

```bash
cd ~/ccflare-upgrade-2026-08-03/src
GIT_SHA=$(git rev-parse HEAD)
GIT_REF="v3.5.46"
BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "GIT_SHA=$GIT_SHA  GIT_REF=$GIT_REF  BUILD_DATE=$BUILD_DATE"

docker build \
    -f Dockerfile.provenance \
    --build-arg GIT_REF="$GIT_REF" \
    --build-arg GIT_SHA="$GIT_SHA" \
    --build-arg BUILD_DATE="$BUILD_DATE" \
    -t ccflare:v3.5.46 \
    -t registry.zp.digital/ccflare:v3.5.46 \
    . 2>&1 | tail -20
```

**Expected** (last lines):

```
=> naming to docker.io/library/ccflare:v3.5.46
=> naming to registry.zp.digital/ccflare:v3.5.46
```

**If the build fails with `failed to solve: oven/bun@sha256:...`**: the
canary digest in `Dockerfile.provenance` is no longer resolvable. Re-run step
2.3; if the new `EMBEDDED_REV` matches the old one, edit
`Dockerfile.provenance` to update the `ARG BUN_IMAGE_AMD64=...` and
`ARG BUN_IMAGE_ARM64=...` lines with the new digests (re-pull via
`docker manifest inspect` for both architectures) and rebuild. If the
embedded revision has CHANGED, re-run the containment test against the new
revision; if it passes, edit Dockerfile.provenance to update the
`org.opencontainers.image.base.revision` label.

### 2.5 Sanity-check the new image's provenance (before pushing)

```bash
docker inspect --format '{{json .Config.Labels}}' ccflare:v3.5.46 \
    | jq -r 'to_entries[] | select(.key | startswith("org.opencontainers.image."))
        | "\(.key)=\(.value)"' | sort
```

**Expected** (key fields, all present):

```
org.opencontainers.image.base.digest=oven/bun@sha256:aead81873566d42926d8cbb8dc915bdd5547d2f59a8f7e46220ba83dd167b210
org.opencontainers.image.base.name=oven/bun
org.opencontainers.image.base.revision=f68e504ae48a5a54eb3017f29baa99dd31660a5e
org.opencontainers.image.base.version=canary-alpine
org.opencontainers.image.created=2026-08-03T…
org.opencontainers.image.revision=<GIT_SHA from 2.4>
org.opencontainers.image.version=v3.5.46
```

**If any of these is missing**: the Dockerfile.provenance did not run the
LABEL block. Inspect the image's history: `docker history ccflare:v3.5.46 | head`.
The LABELs are emitted at the end of the final stage. If they are absent, the
build silently used a different Dockerfile (e.g. `./Dockerfile`). **STOP.**

### 2.6 Push to the registry

```bash
docker push registry.zp.digital/ccflare:v3.5.46 2>&1 | tail -5
```

**Expected** (last line):

```
v3.5.46: digest: sha256:… size: …
```

Record this digest for later use:

```bash
PUSHED_DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' \
    registry.zp.digital/ccflare:v3.5.46)
echo "pushed digest: $PUSHED_DIGEST"
echo "$PUSHED_DIGEST" > ~/ccflare-upgrade-2026-08-03/pushed-digest.txt
```

---

## Step 3 — Capture ccproxy2 (do not touch yet)

The operator-mandated order is **ccmax FIRST, then ccproxy2**. Capture
ccproxy2's current state the same way as step 1, so that if the upgrade on
ccmax needs to be rolled back, the operator has a clean record of what ccproxy2
was running.

```bash
cd ~/ccflare-upgrade-2026-08-03
scripts/verify-live-build.sh \
    --ssh deploy@ccproxy2 \
    --container ccflare \
    --health-port 8080 \
    -o ccproxy2-before.txt
```

**Expected**: `STATUS: VERIFIED_MATCH` on the last line of the report. Same
verdict rules as step 1.

```bash
# Save for the post-upgrade comparison
cp verify-live-build.summary.json ccproxy2-before.summary.json
```

> **DO NOT deploy ccproxy2 yet.** Step 4-6 are about ccmax. The ccproxy2
> deploy is step 7.

---

## Step 4 — Deploy ccmax (preserve env)

### 4.1 Capture the existing env from the running container

```bash
ssh deploy@ccmax 'docker inspect --format "{{range .Config.Env}}{{println .}}{{end}}" ccflare' \
    | tee ~/ccflare-upgrade-2026-08-03/ccmax-env-before.txt
```

**Expected**: a list of `KEY=value` lines, including the critical:

```
ALERT_ANOMALY_ENABLED=0
PORT=8080
BETTER_CCFLARE_DB_PATH=/data/ccflare.db
CCFLARE_DB_PATH=/data/ccflare.db
XDG_CONFIG_HOME=/data
NODE_ENV=production
```

**If `ALERT_ANOMALY_ENABLED` is absent or set to anything other than `0`**:
**STOP.** The task explicitly says this is deliberate. The current ccmax
container must have `ALERT_ANOMALY_ENABLED=0`. Investigate before upgrading.

### 4.2 Capture the docker run command from the existing container

```bash
ssh deploy@ccmax 'docker inspect --format "{{.Name}} {{.HostConfig.RestartPolicy.Name}} {{range .Mounts}}{{.Source}}:{{.Destination}} {{end}}{{range .HostConfig.PortBindings}}{{(index . 0).HostPort}}->{{end}}{{end}}{{range $k,$v := .NetworkSettings.Ports}}{{$k}}->{{(index $v 0).HostPort}} {{end}}" ccflare' \
    | tee ~/ccflare-upgrade-2026-08-03/ccmax-run-shape.txt
```

(Or, simpler: have the operator eyeball the actual `docker run` line they used
to launch the current container. This is a 2am runbook — eyeballing is fine.)

**Goal**: identify the volumes, ports, restart policy, and any `--add-host`,
`--network`, or `--cap-add` flags. The new container must replicate all of them
except for the image ref.

### 4.3 Stop, remove, and re-launch ccmax

> If the operator uses docker compose, the equivalent is `docker compose pull &&
> docker compose up -d`. The env preservation rule still applies — the new
> compose file or `docker compose` invocation must include `ALERT_ANOMALY_ENABLED=0`
> in the environment block. **Do not let compose write a default that flips this.**

```bash
ssh deploy@ccmax <<'SSHCOMMAND'
set -euo pipefail

# Stop and remove the old container (keep the data volume — `/var/lib/ccflare`
# is the host bind-mount path; substitute if the operator uses a different one).
docker stop ccflare
docker rm ccflare

# Pull the new image.
docker pull registry.zp.digital/ccflare:v3.5.46

# Launch the new container with the same env as before. The critical line:
#   -e ALERT_ANOMALY_ENABLED=0     # deliberate, do NOT omit
# Plus the captured env. Operator's choice between --env-file and repeated -e.
docker run -d \
    --name ccflare \
    --restart=unless-stopped \
    -p 8080:8080 \
    -v /var/lib/ccflare:/data \
    -e PORT=8080 \
    -e NODE_ENV=production \
    -e CCFLARE_DB_PATH=/data/ccflare.db \
    -e XDG_CONFIG_HOME=/data \
    -e ALERT_ANOMALY_ENABLED=0 \
    registry.zp.digital/ccflare:v3.5.46
SSHCOMMAND
```

**Expected** (the first 12 hex chars of the new container id):

```
<sha>...
```

**If `docker pull` fails**: registry unreachable from ccmax. Check
`/etc/docker/daemon.json` on ccmax for the `registry-mirrors` / `insecure-registries`
settings. **STOP** if registry.zp.digital is not reachable — do not fall back to
pulling from Docker Hub, the image was never pushed there.

### 4.4 Wait for the new container to be healthy

```bash
# /health start_period is 40s. Wait 60s to be safe.
sleep 60
ssh deploy@ccmax 'docker inspect --format "{{.State.Health.Status}}" ccflare'
```

**Expected**: `healthy`.

**If `starting`**: the 40s healthcheck start-period has not elapsed. Wait 30s
more and re-check.

**If `unhealthy`**: the new container's `/health` is returning a non-200. Check
the logs: `ssh deploy@ccmax 'docker logs --tail 200 ccflare'`. The most likely
causes are: env var missing (PORT or CCFLARE_DB_PATH), or the new image's
SQLite migration path differs from the captured env. **STOP and investigate.**

### 4.5 Capture the new image's provenance on ccmax

```bash
cd ~/ccflare-upgrade-2026-08-03
scripts/verify-live-build.sh \
    --ssh deploy@ccmax \
    --container ccflare \
    --health-port 8080 \
    -o ccmax-after.txt
```

**Expected** (last lines):

```
STATUS:              VERIFIED_MATCH
REASON:              all_corroboration_checks_pass
```

And in `ccmax-after.txt` (key lines):

```
IMAGE_REF:           registry.zp.digital/ccflare:v3.5.46
IMAGE_DIGEST:        registry.zp.digital/ccflare@sha256:…
HEALTH_GIT_SHA:      c3376345a7c811874dd58346af2c09b55dadf0a3
HEALTH_GIT_REF:      v3.5.46
HEALTH_BUILD_DATE:   2026-08-03T…
BUN_REVISION:        f68e504ae48a5a54eb3017f29baa99dd31660a5e
OCI_CHECK:           org.opencontainers.image.revision=c3376345a7c811874dd58346af2c09b55dadf0a3
OCI_CHECK:           org.opencontainers.image.version=v3.5.46
OCI_CHECK:           org.opencontainers.image.created=2026-08-03T…
OCI_CHECK:           org.opencontainers.image.base.revision=f68e504ae48a5a54eb3017f29baa99dd31660a5e
```

**If `STATUS` is anything other than `VERIFIED_MATCH`**: **STOP**. The new
container does not agree with its own image labels, OR the script could not
extract the required signals. Investigate before going further.

---

## Step 5 — Verify ccmax's behaviour (functional, not just provenance)

These checks are about runtime behaviour, not image metadata. Each must pass
on ccmax before proceeding to ccproxy2.

### 5.1 /health (the operator-visible upgrade signal)

```bash
curl -fsS http://ccmax:8080/health | jq '{
    status,
    version,
    git_sha,
    git_ref,
    build_date,
    pool: .pool | {configured, paused, rate_limited, routable}
}'
```

**Expected**:

```json
{
  "status": "ok",
  "version": "v3.5.46",
  "git_sha": "c3376345a7c811874dd58346af2c09b55dadf0a3",
  "git_ref": "v3.5.46",
  "build_date": "2026-08-03T…Z",
  "pool": {
    "configured": <same as before>,
    "paused": <same as before>,
    "rate_limited": <same as before>,
    "routable": <same as before>
  }
}
```

**Failure modes**:
- `status` not `ok`: **STOP**. `/health` is reporting `degraded` or `unhealthy`.
  The most likely cause: the new container cannot reach its configured
  upstream accounts. Check `docker logs ccflare`.
- `git_sha` / `git_ref` / `build_date` are `"unknown"`: the build did not
  emit the env vars. The image was likely built from `./Dockerfile`, not
  `./Dockerfile.provenance`. **STOP** — the new image is not the one this
  runbook was designed to deploy.
- `pool.routable` dropped to 0 vs. before: the new build broke account
  selection. **STOP.**

### 5.2 /api/stats (the HTTP 500 SQLSTATE 42803 regression canary)

> This is the exact endpoint that returned HTTP 500 with `SQLSTATE 42803`
> the last time we broke Postgres compatibility. It is the most reliable
> detector of "the migration parity broke."

```bash
ADMIN_KEY="<the operator's pre-existing admin API key for ccmax>"
curl -fsS -w "\nHTTP_STATUS: %{http_code}\n" \
    -H "Authorization: Bearer ${ADMIN_KEY}" \
    http://ccmax:8080/api/stats | tail -30
```

**Expected**: `HTTP_STATUS: 200` and a JSON body with at least the keys
`totalRequests`, `successRate`, `activeAccounts`, `totalTokens`, `accounts[]`,
`recentErrors[]`. The numeric values will differ from the pre-upgrade capture
(that's fine — there has been traffic).

**If `HTTP_STATUS: 500`**: the migration parity is broken. The body will
contain `SQLSTATE 42803` or similar Postgres-shaped errors. **Roll back
ccmax** using the script in step 0 (it now points at the captured digest).
**STOP** — do not proceed to ccproxy2.

**If `HTTP_STATUS: 401`**: the API key is missing admin scope, or is wrong.
That is NOT a regression — substitute a valid admin key and retry. If no
admin key is available, the operator must mint one before continuing.

### 5.3 /api/insights/anomalies (lightweight post-deploy sanity)

```bash
curl -fsS -w "\nHTTP_STATUS: %{http_code}\n" \
    -H "Authorization: Bearer ${ADMIN_KEY}" \
    "http://ccmax:8080/api/insights/anomalies?range=24h" \
    | jq '{meta: .meta, detector_count: (.anomalies | length)}'
```

**Expected**: `HTTP_STATUS: 200`. `meta.truncated` may be true on a busy host
that's fine. `meta` should include `range`, `zScoreThreshold`, and the
configured detectors.

**If `HTTP_STATUS: 5xx`**: the anomalies endpoint is also a Postgres-shaped
query path. **Roll back ccmax.**

### 5.4 Accounts view 5h+7d usage (operator-eye check, BLOCKING)

> This is the regression class the operator's own dashboard would expose:
> the per-window 5-hour and 7-day usage progress bars on each account row
> must render. If they don't, the operator sees an empty / broken accounts
> view immediately.

Open `https://ccmax/accounts` in a browser. For at least one Anthropic-family
account, confirm:

- A **"5-hour"** progress bar is visible with a non-zero utilization value.
- A **"Weekly"** progress bar (the 7-day window) is visible.
- Per-model weekly scoped windows (e.g. **"Fable (Weekly)"**, **"Sonnet
  (Weekly)"**) appear if the account has them.
- A reset time string is visible on each bar (format: relative + absolute,
  e.g. `Resets in 4h 12m (08:00 UTC)`).

**If the bars are missing or empty**: the rate-limit rendering regressed. The
window keys are `five_hour` / `seven_day` / `seven_day_<model_slug>` —
implemented in `packages/dashboard-web/src/components/accounts/rate-limit-helpers.ts`
and rendered by `AccountListItem.tsx`. A regression here means the v3.5.46
deployment broke the rendering path. **Roll back ccmax.**

This check is the only one the operator does by eye. It is the highest-signal
regression detector on the operator's dashboard.

### 5.5 Confirm `ALERT_ANOMALY_ENABLED` is still 0

> Re-verify after deploy. The new container's `docker run` had it in the env
> block, but a typo or a compose-default override could flip it.

```bash
ssh deploy@ccmax 'docker exec ccflare sh -c \
    "grep ^ALERT_ANOMALY_ENABLED /proc/1/environ | tr \"\\0\" \"\\n\""' \
    | tail -1
```

**Expected**: `ALERT_ANOMALY_ENABLED=0`.

**If anything else**: the deploy flipped the flag. **STOP**. Re-launch with
the correct env var and re-verify all of step 5.

---

## Step 6 — Gate: ccmax is healthy

All five step-5 checks must pass. If any failed, the operator has already
rolled back ccmax per step 0. In that case, **the runbook ends here** — do
NOT proceed to ccproxy2.

If all five passed:

```bash
echo "ccmax is healthy at v3.5.46. Proceeding to ccproxy2."
date -u +%Y-%m-%dT%H:%M:%SZ
```

---

## Step 7 — Deploy ccproxy2 (mirror step 4)

The procedure is identical to step 4, with `ccmax` → `ccproxy2` everywhere.

### 7.1 Capture existing env

```bash
ssh deploy@ccproxy2 'docker inspect --format "{{range .Config.Env}}{{println .}}{{end}}" ccflare' \
    | tee ~/ccflare-upgrade-2026-08-03/ccproxy2-env-before.txt
```

**Expected**: same `ALERT_ANOMALY_ENABLED=0` (per the operator's stated
requirement).

### 7.2 Re-launch

```bash
ssh deploy@ccproxy2 <<'SSHCOMMAND'
set -euo pipefail
docker stop ccflare
docker rm ccflare
docker pull registry.zp.digital/ccflare:v3.5.46
docker run -d \
    --name ccflare \
    --restart=unless-stopped \
    -p 8080:8080 \
    -v /var/lib/ccflare:/data \
    -e PORT=8080 \
    -e NODE_ENV=production \
    -e CCFLARE_DB_PATH=/data/ccflare.db \
    -e XDG_CONFIG_HOME=/data \
    -e ALERT_ANOMALY_ENABLED=0 \
    registry.zp.digital/ccflare:v3.5.46
SSHCOMMAND

sleep 60
ssh deploy@ccproxy2 'docker inspect --format "{{.State.Health.Status}}" ccflare'
```

**Expected**: `healthy`.

### 7.3 Capture new provenance on ccproxy2

```bash
cd ~/ccflare-upgrade-2026-08-03
scripts/verify-live-build.sh \
    --ssh deploy@ccproxy2 \
    --container ccflare \
    --health-port 8080 \
    -o ccproxy2-after.txt
```

**Expected**: `STATUS: VERIFIED_MATCH`.

### 7.4 Functional verification (mirror step 5)

Repeat every check from step 5 against `ccproxy2:8080`. Same pass criteria.
The HTTP 500 SQLSTATE 42803 case on `/api/stats` is the most load-bearing
gate; if it returns 5xx on ccproxy2, **roll back ccproxy2**.

---

## Step 8 — Done

Both hosts are running `registry.zp.digital/ccflare:v3.5.46` with
`ALERT_ANOMALY_ENABLED=0` and verified `/health` provenance. Save the runbook
artifacts:

```bash
cd ~/ccflare-upgrade-2026-08-03
ls -la
```

**Expected**:

```
ccmax-before.txt
ccmax-before.summary.json
ccmax-after.txt
ccmax-after.summary.json
ccmax-env-before.txt
ccproxy2-before.txt
ccproxy2-before.summary.json
ccproxy2-after.txt
ccproxy2-after.summary.json
ccproxy2-env-before.txt
pushed-digest.txt
rollback-ccmax.sh
rollback-ccproxy2.sh
```

Archive the directory somewhere safe. If either host later misbehaves, the
`*-before.txt` and `*-after.txt` captures are the comparison basis.

---

## Appendix A — Rollback (one command per host)

If anything goes wrong at any point after step 4, roll back the affected host
with the captured digest:

```bash
# On the operator's workstation, after substituting the real env-file path:
scp rollback-ccmax.sh deploy@ccmax:/tmp/
ssh deploy@ccmax 'bash /tmp/rollback-ccmax.sh'
```

The rollback script:
- stops and removes the current container (whatever version it is)
- pulls the captured v3.5.44+zp6 image by digest (no tag re-resolution)
- launches it with the same env the operator has been using

This is **not** a fix — it's a known-good restore. The operator should then
investigate offline.

---

## Appendix B — What the runbook does NOT cover

- **The `claude` Anthropic account**. This runbook never curls the Anthropic
  endpoint directly, in keeping with the project's standing rule (real
  Anthropic accounts can be banned for automated/scripted usage). All HTTP
  traffic in step 5 hits ccmax's own API.
- **Other live accounts (Zai, MiniMax, OpenRouter, etc.)**. The functional
  checks in step 5 do not exercise the full account pool — they only hit
  the API surface. If an account-shape regression only shows up on a
  specific provider, it will not be caught here. That is a known gap; the
  tradeoff is that an end-to-end smoke per account adds 30+ minutes and
  creates a real Anthropic traffic signature.
- **ccproxy2 traffic isolation**. The deploy does not drain traffic from
  ccproxy2 first; it relies on the upstream load balancer to route around
  the brief restart. If the operator wants zero-downtime, drain ccproxy2
  via the LB's API before step 7.2.
- **AAR (after-action review)**. This runbook ends at "both hosts healthy."
  The operator should write the AAR separately, including any decisions
  about the canary pin.
