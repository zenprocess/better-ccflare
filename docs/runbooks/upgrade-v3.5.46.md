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
   The image manifest digest the operator mentioned in the briefing —
   `sha256:08c93b57…` — is **unverified hearsay carried over from an earlier
   session, NOT established fact**. It is a shorthand the operator typed; the
   runbook does not act on it until step 1 captures the real digest on the
   running container. Step 1.2 generates the rollback script from that
   captured value; if the captured digest differs from `08c93b57…`, the
   captured value wins.
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

## Step 0 — Rollback posture (no scripts yet)

> ⚠️ **The digest `sha256:08c93b57…` carried over from the operator's earlier
> session is UNVERIFIED HEARSAY, not established fact.** It is a shorthand the
> operator typed, NOT something verified against a running container. The real
> digest is unknown until step 1 captures it. The runbook does NOT pre-write
> a rollback script here for two reasons:
>
> 1. Any hardcoded digest in a pre-written script is either hearsay or wrong.
>    Docker rejects truncated digests (`sha256:08c93b57` is 8 hex chars; a valid
>    reference is the full 64). A pre-written script with a placeholder
>    "looks executable" but is not — the operator would discover this at the
>    worst possible moment.
> 2. The rollback's correctness depends on the actual captured value. The
>    script is **generated** from the captured digest, not interpolated into
>    a template. Generation happens in step 1.2 (ccmax) and step 3.1
>    (ccproxy2) — i.e., AFTER the live state is recorded.

Open a fresh terminal window. Keep it open for the entire runbook. Paste every
command exactly. Record outputs in a scratch file:

```bash
mkdir -p ~/ccflare-upgrade-2026-08-03
cd ~/ccflare-upgrade-2026-08-03
```

**If the operator's hearsay digest turns out to be unverifiable later** (the
real running image is something different, or the registry has GC'd the old
image), the runbook states plainly: **this upgrade is one-way, the rollback
script will refuse to run**. The pre-flight in step 1.2 makes that refusal
loud rather than silent.

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
VERIFY_EXIT=$?
echo "verify-live-build exit=$VERIFY_EXIT"
case $VERIFY_EXIT in
    0) echo "VERIFIED_MATCH — captured cleanly" ;;
    1) echo "FATAL: VERIFIED_DRIFT. STOP. The current ccmax image has" >&2
       echo "  disagreements between /health and its OCI labels. Investigate" >&2
       echo "  before upgrading." >&2; exit 1 ;;
    2) echo "FATAL: COULD_NOT_DETERMINE. STOP. Look at MISSING_FIELDS:" >&2
       echo "  in ccmax-before.txt; re-run with --debug if needed." >&2
       exit 1 ;;
    64) echo "FATAL: invalid arguments to verify-live-build.sh" >&2; exit 1 ;;
    *) echo "FATAL: unexpected exit code $VERIFY_EXIT" >&2; exit 1 ;;
esac
grep -q '^STATUS:[[:space:]]\+VERIFIED_MATCH' ccmax-before.txt \
    || { echo "FATAL: STATUS line missing or not VERIFIED_MATCH" >&2; exit 1; }
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

### 1.2 Generate `rollback-ccmax.sh` from the captured digest (and verify the rollback image is retrievable)

> The live image's digest is now established fact — captured from the running
> container in step 1. Generate the rollback script from it, with the
> **correct** ordering: pull first, destroy only if pull succeeds.

```bash
cd ~/ccflare-upgrade-2026-08-03

# Extract the captured digest. Manifest digest is required (it pins the
# full image identity and works with `docker manifest inspect` / pull by
# digest). If manifest_digest is empty, the verify-live-build.sh summary
# is incomplete — DO NOT fall back to config_digest, because a config
# digest is a different artifact and the rollback script's pull
# reference may not resolve.
DIGEST=$(jq -r '.image.manifest_digest // empty' ./verify-live-build.summary.json)
if [ -z "$DIGEST" ]; then
    echo "FATAL: captured manifest_digest is empty. The verify-live-build.sh" >&2
    echo "  summary should always populate image.manifest_digest for a" >&2
    echo "  successful capture. If it is empty, the manifest extraction" >&2
    echo "  in the script broke, OR the image was pulled by a tag that the" >&2
    echo "  registry did not promote to a RepoDigest." >&2
    echo "  Inspect the summary manually: jq '.image' verify-live-build.summary.json" >&2
    exit 1
fi
echo "Live ccmax image ref: $DIGEST"

# Pre-flight: the rollback image MUST be retrievable from the registry OR
# already in the local image cache on ccmax. If neither, the upgrade is
# one-way and we HALT before any state change. This is the loud refusal
# the operator must see up front.
ssh deploy@ccmax bash -s <<SSHCOMMAND
set -euo pipefail
IMAGE_REF='$DIGEST'
BARE="\${IMAGE_REF#*@}"
if docker image inspect "\$BARE" >/dev/null 2>&1; then
    echo "rollback image present in local cache: \$BARE"
    exit 0
fi
echo "rollback image NOT in local cache; attempting pull..."
if docker pull "\$IMAGE_REF" >/dev/null 2>&1; then
    echo "rollback image pulled successfully: \$BARE"
    exit 0
fi
echo "FATAL: rollback image \$IMAGE_REF is not retrievable." >&2
echo "  HALT — this upgrade is one-way." >&2
exit 1
SSHCOMMAND
```

**Expected output**:

```
Live ccmax image ref: registry.zp.digital/ccflare@sha256:<64 hex chars>
rollback image present in local cache: sha256:<64 hex chars>
```

or

```
Live ccmax image ref: registry.zp.digital/ccflare@sha256:<64 hex chars>
rollback image NOT in local cache; attempting pull...
rollback image pulled successfully: sha256:<64 hex chars>
```

**If the pre-flight exits non-zero** (the image is neither cached nor
pullable): **HALT the entire upgrade**. The operator must decide: stop
here, or proceed knowing the upgrade is irreversible. Do not "try the
deploy anyway" — the rollback script will refuse to run later, and the
operator will discover that during an outage.

Now generate the script. The key property of this script is the **order
of operations**: pull succeeds → only then stop+rm → only then re-run.
If pull fails, the script aborts with no state change.

```bash
cat > rollback-ccmax.sh <<EOF
#!/usr/bin/env bash
# rollback-ccmax.sh — generated from step 1.2 capture on $(date -u +%Y-%m-%dT%H:%M:%SZ).
# Rollback target (live, not hearsay): $DIGEST
#
# Order of operations is load-bearing:
#   1. Pre-flight: image must be retrievable (cache or pull).
#   2. ONLY if pre-flight passes, destroy the running container.
#   3. Re-run with the captured image and the captured env.
# A pull failure aborts the script with no state change.

set -euo pipefail

ROLLBACK_IMAGE="$DIGEST"
BARE_DIGEST="\${ROLLBACK_IMAGE#*@}"

# 1. Pre-flight.
if ! docker image inspect "\$BARE_DIGEST" >/dev/null 2>&1; then
    if ! docker pull "\$ROLLBACK_IMAGE" >/dev/null 2>&1; then
        echo "FATAL: rollback image \$ROLLBACK_IMAGE is not retrievable." >&2
        echo "  HALT — this upgrade is one-way." >&2
        exit 1
    fi
fi

# 2. Destroy (only now that we have the replacement in hand).
docker stop ccflare
docker rm ccflare

# 3. Re-run with the captured env. Operator MUST substitute the
#    env-file path; the runbook captured it in step 4.1.
docker run -d --name ccflare --restart=unless-stopped \\
    --env-file /etc/ccflare/ccflare.env \\
    -p 8080:8080 \\
    -v /var/lib/ccflare:/data \\
    "\$ROLLBACK_IMAGE"
EOF
chmod +x rollback-ccmax.sh

# Verify the generated script: digest is 64 hex chars, ordering is pull-first.
echo "--- generated rollback-ccmax.sh ---"
cat rollback-ccmax.sh
echo "--- end ---"
```

**Expected** (key lines in the cat output, all present and in this order):

```bash
ROLLBACK_IMAGE="registry.zp.digital/ccflare@sha256:<exactly 64 hex chars>"
...
if ! docker image inspect "$BARE_DIGEST" >/dev/null 2>&1; then
    if ! docker pull "$ROLLBACK_IMAGE" >/dev/null 2>&1; then
...
docker stop ccflare
docker rm ccflare
```

**Failure modes**:
- `ROLLBACK_IMAGE` line has fewer than 64 hex chars after `sha256:`: the
  digest was truncated. Re-run `jq -r '.image.manifest_digest' ...` and
  check the source.
- The `docker pull` line appears AFTER `docker stop` / `docker rm`: the
  ordering is wrong. Re-generate the script from this step; do not edit
  it manually.

> The ccproxy2 rollback script is **not** generated here. The operator-
> mandated order is ccmax first, then ccproxy2. The ccproxy2 capture
> happens in step 3; the ccproxy2 rollback script is generated in
> step 3.1, after we know ccproxy2's live image and have verified its
> retrievability. This avoids carrying a placeholder digest forward.

**If the captured digest does not match the operator's hearsay `08c93b57…`**: the
operator's report was inaccurate. Use the captured value. The previously-recorded
"current version v3.5.44+zp6" claim is still trusted only if the
`org.opencontainers.image.version` OCI label on the captured image says
`v3.5.44+zp6` (or an equivalent operator-applied suffix). The label is in the
`*-before.txt` capture; check it before continuing. If the label says something
else, **STOP and ask the operator** which version was actually running.

### 1.3 Stash the Bun revision from the captured container (sanity-check only)

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

> Three layers of verification, all required. The canary tag is mutable;
> its content can change without the digest changing unless the operator
> re-pins. A rebase that reverts and re-applies the fix can pass the
> merge-base check while the fix is absent from HEAD's source — that's
> why we verify against HEAD's actual source tree, not just its history.
>
> **Three artifacts to verify, all three must pass**:
>
> 1. **Canary tag** (`oven/bun:canary-alpine`, mutable) — what's at HEAD
>    of Bun's canary now.
> 2. **Pinned digests** (in `Dockerfile.provenance`, `aead8187…` amd64 /
>    `91bbe5b25a…` arm64) — what the Dockerfile actually builds against.
>    Older digests can lose the fix in a revert-and-reapply scenario; the
>    canary tag check alone doesn't cover this.
> 3. **HEAD's source** at the extracted revision — does the file the fix
>    modified actually contain the fix's marker. History says yes; source
>    says yes or no.

```bash
# Read the embedded Bun revision from the canary image. Capture stderr;
# do NOT swallow it. Validate the value is exactly 40 hex chars — empty
# or partial values mean the docker invocation failed and we must abort.
docker pull oven/bun:canary-alpine >/dev/null
EMBEDDED_REV=$(docker run --rm oven/bun:canary-alpine bun --revision 2>&1 \
    | tr -d '[:space:]')
if ! [[ "$EMBEDDED_REV" =~ ^[0-9a-f]{40}$ ]]; then
    echo "FATAL: could not extract Bun revision from canary." >&2
    echo "  raw output: '$EMBEDDED_REV'" >&2
    echo "  docker likely failed (daemon down, image pull blocked, or 'docker' missing)." >&2
    echo "  ABORT — do not proceed without a verified revision." >&2
    exit 1
fi
echo "embedded Bun revision (canary HEAD): $EMBEDDED_REV"
```

**Expected**: a 40-char hex SHA like `f68e504ae48a5a54eb3017f29baa99dd31660a5e`.
If not — abort above.

```bash
# Containment test on the canary HEAD — must be AHEAD or IDENTICAL of the
# fix commit (789be97db9b746533cf692e8367146e2d3c0d7cb), with 0 commits behind.
gh api repos/oven-sh/bun/compare/789be97db9b746533cf692e8367146e2d3c0d7cb...${EMBEDDED_REV} > canary-compare.json
echo "exit=$?"
jq -e '
    .status == "ahead" or .status == "identical"
        and .behind_by == 0
        and .merge_base_commit.sha == "789be97db9b746533cf692e8367146e2d3c0d7cb"
' canary-compare.json >/dev/null || {
    echo "FATAL: canary HEAD does not contain bun#35093." >&2
    jq '{status, ahead_by, behind_by, merge_base_commit: .merge_base_commit.sha}' canary-compare.json >&2
    exit 1
}
echo "canary HEAD contains the fix."
```

**Expected**: `canary HEAD contains the fix.`

```bash
# Pull the PINNED digests from Dockerfile.provenance (NOT just the canary
# tag). The pinned digests may be older than the canary; they may have
# lost the fix in a revert-and-reapply scenario the canary didn't.
PINNED_AMD64="sha256:aead81873566d42926d8cbb8dc915bdd5547d2f59a8f7e46220ba83dd167b210"
PINNED_ARM64="sha256:91bbe5b25a29561ae6fad60587fef03350acb6c74bebaef87b6031738e96bf94"
docker pull "oven/bun@${PINNED_AMD64}" >/dev/null
PINNED_REV=$(docker run --rm "oven/bun@${PINNED_AMD64}" bun --revision 2>&1 \
    | tr -d '[:space:]')
if ! [[ "$PINNED_REV" =~ ^[0-9a-f]{40}$ ]]; then
    echo "FATAL: could not extract Bun revision from pinned digest." >&2
    exit 1
fi
echo "embedded Bun revision (pinned amd64 digest): $PINNED_REV"

# Containment test on the pinned digest.
gh api repos/oven-sh/bun/compare/789be97db9b746533cf692e8367146e2d3c0d7cb...${PINNED_REV} > pinned-compare.json
jq -e '
    .status == "ahead" or .status == "identical"
        and .behind_by == 0
        and .merge_base_commit.sha == "789be97db9b746533cf692e8367146e2d3c0d7cb"
' pinned-compare.json >/dev/null || {
    echo "FATAL: pinned amd64 digest does NOT contain bun#35093." >&2
    jq '{status, ahead_by, behind_by, merge_base_commit: .merge_base_commit.sha}' pinned-compare.json >&2
    echo "  The Dockerfile.provenance pin is stale. Either revert to the previous" >&2
    echo "  image (rollback) or wait for the canary to recover before pinning a" >&2
    echo "  new digest." >&2
    exit 1
}
echo "pinned amd64 digest contains the fix."
```

**Expected**: `pinned amd64 digest contains the fix.`

```bash
# Verify the fix's marker is present in HEAD's actual source tree at the
# extracted revision. The fix commit (789be97…, title "fetch: error the
# response body stream when a fully-buffered response is aborted") modified
# a specific file. Use gh api to fetch the file from that revision and
# grep for the error-handling pattern the fix added.
# The exact path and marker are revision-specific; this command surfaces
# the title so the operator can confirm it's the same fix the canary
# supposedly contains.
FIX_TITLE=$(jq -r '.merge_base_commit.title' pinned-compare.json)
echo "merge-base commit title: $FIX_TITLE"
# Read the file the fix most likely touched (src/bun.js / src/fetch.ts —
# both have been home to fetch-abort fixes). We probe src/bun.js first.
gh api "repos/oven-sh/bun/contents/src/bun.js?ref=${PINNED_REV}" \
    --jq '.content' | tr -d ' ' | base64 -d 2>/dev/null > bun-head-src.js || true
if grep -qE 'response body stream.*fully-buffered.*aborted|fetchAbort|response.*aborted' \
    bun-head-src.js 2>/dev/null; then
    echo "fix marker present in HEAD source (src/bun.js)."
else
    # Try the fetch source as fallback.
    gh api "repos/oven-sh/bun/contents/src/fetch.ts?ref=${PINNED_REV}" \
        --jq '.content' | tr -d ' ' | base64 -d 2>/dev/null > bun-head-fetch.ts || true
    if grep -qE 'response body stream.*fully-buffered.*aborted|fetchAbort|response.*aborted' \
        bun-head-fetch.ts 2>/dev/null; then
        echo "fix marker present in HEAD source (src/fetch.ts)."
    else
        echo "FATAL: fix marker NOT found in HEAD source." >&2
        echo "  The merge-base commit has the fix in its history but the fix" >&2
        echo "  appears to have been reverted. ABORT." >&2
        exit 1
    fi
fi
```

**Expected**: `fix marker present in HEAD source (src/bun.js).` (or `src/fetch.ts`).

**If any of the three layers fails**: the canary (or the pinned digest, or HEAD)
does not contain `bun#35093`. **ABORT the build.** Do not pin a new digest
into `Dockerfile.provenance` and proceed — the supply-chain argument for the
canary is that it contains the fix, in HEAD's source. Without the fix, the
deploy is unprovable. Report the failed layer to the operator; the operator
decides whether to wait for the canary to recover or to fall back to the
previous image (which is what the rollback scripts in step 0 are for).

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
    --no-cache \
    --pull \
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
VERIFY_EXIT=$?
echo "verify-live-build exit=$VERIFY_EXIT"
case $VERIFY_EXIT in
    0) echo "VERIFIED_MATCH — captured cleanly" ;;
    1) echo "FATAL: VERIFIED_DRIFT. STOP." >&2; exit 1 ;;
    2) echo "FATAL: COULD_NOT_DETERMINE. STOP." >&2; exit 1 ;;
    *) echo "FATAL: unexpected exit code $VERIFY_EXIT" >&2; exit 1 ;;
esac
grep -q '^STATUS:[[:space:]]\+VERIFIED_MATCH' ccproxy2-before.txt \
    || { echo "FATAL: STATUS line missing or not VERIFIED_MATCH" >&2; exit 1; }
```

**Expected**: `STATUS: VERIFIED_MATCH` on the last line of the report. Same
verdict rules as step 1.

```bash
# Save for the post-upgrade comparison
cp verify-live-build.summary.json ccproxy2-before.summary.json
```

> **DO NOT deploy ccproxy2 yet.** Step 4-6 are about ccmax. The ccproxy2
> deploy is step 7.

### 3.1 Generate `rollback-ccproxy2.sh` from the captured digest

> Same pattern as step 1.2: pull-first ordering, retrievability pre-flight,
> generated (not interpolated) from the captured value. Assumes ccproxy2 runs
> the same image as ccmax — the operator reports they were both on `v3.5.44+zp6`.
> If the captured digest on ccproxy2 differs from ccmax's, the generated script
> reflects ccproxy2's own live image, not ccmax's.

```bash
cd ~/ccflare-upgrade-2026-08-03

DIGEST=$(jq -r '.image.manifest_digest // empty' ccproxy2-before.summary.json)
if [ -z "$DIGEST" ]; then
    echo "FATAL: captured manifest_digest is empty. See step 1.2 for the" >&2
    echo "  rationale — a config_digest fallback would generate a" >&2
    echo "  rollback script whose pull reference may not resolve." >&2
    echo "  Inspect the summary manually: jq '.image' ccproxy2-before.summary.json" >&2
    exit 1
fi
echo "Live ccproxy2 image ref: $DIGEST"

# Pre-flight: image must be retrievable from ccproxy2's local cache or the
# registry. If neither, the upgrade is one-way; HALT before any mutation.
ssh deploy@ccproxy2 bash -s <<SSHCOMMAND
set -euo pipefail
IMAGE_REF='$DIGEST'
BARE="\${IMAGE_REF#*@}"
if docker image inspect "\$BARE" >/dev/null 2>&1; then
    echo "rollback image present in local cache: \$BARE"
    exit 0
fi
echo "rollback image NOT in local cache; attempting pull..."
if docker pull "\$IMAGE_REF" >/dev/null 2>&1; then
    echo "rollback image pulled successfully: \$BARE"
    exit 0
fi
echo "FATAL: rollback image \$IMAGE_REF is not retrievable." >&2
echo "  HALT — this upgrade is one-way for ccproxy2." >&2
exit 1
SSHCOMMAND

cat > rollback-ccproxy2.sh <<EOF
#!/usr/bin/env bash
# rollback-ccproxy2.sh — generated from step 3.1 capture on $(date -u +%Y-%m-%dT%H:%M:%SZ).
# Rollback target (live, not hearsay): $DIGEST
#
# Order of operations is load-bearing:
#   1. Pre-flight: image must be retrievable (cache or pull).
#   2. ONLY if pre-flight passes, destroy the running container.
#   3. Re-run with the captured image and the captured env.
# A pull failure aborts the script with no state change.

set -euo pipefail

ROLLBACK_IMAGE="$DIGEST"
BARE_DIGEST="\${ROLLBACK_IMAGE#*@}"

if ! docker image inspect "\$BARE_DIGEST" >/dev/null 2>&1; then
    if ! docker pull "\$ROLLBACK_IMAGE" >/dev/null 2>&1; then
        echo "FATAL: rollback image \$ROLLBACK_IMAGE is not retrievable." >&2
        echo "  HALT — this upgrade is one-way." >&2
        exit 1
    fi
fi

docker stop ccflare
docker rm ccflare

docker run -d --name ccflare --restart=unless-stopped \\
    --env-file /etc/ccflare/ccflare.env \\
    -p 8080:8080 \\
    -v /var/lib/ccflare:/data \\
    "\$ROLLBACK_IMAGE"
EOF
chmod +x rollback-ccproxy2.sh

# Verify both rollback scripts exist and have the correct ordering.
echo "--- rollback-ccmax.sh ---"; cat rollback-ccmax.sh
echo "--- rollback-ccproxy2.sh ---"; cat rollback-ccproxy2.sh
echo "--- end ---"
```

**Expected**: both scripts present, each with:
- A `ROLLBACK_IMAGE="registry.zp.digital/ccflare@sha256:<64 hex chars>"` line
- A pre-flight `docker image inspect` / `docker pull` block BEFORE `docker stop` / `docker rm`

**If either pre-flight fails**: the affected host's upgrade is one-way. Decide
explicitly whether to proceed; do not proceed by default.

---

## Step 4 — Deploy ccmax (preserve env, pre-pull, bounded wait)

### 4.1 Capture the FULL env from the running container into a file

> Capture the entire env block — every `KEY=value`, not a hand-picked
> subset. The runbook previously enumerated six vars and silently dropped
> `BETTER_CCFLARE_DB_PATH` plus any operator-specific var (TZ, LOG_LEVEL,
> HTTP_PROXY, OAUTH_CLIENT_ID/SECRET, ANTHROPIC_BASE_URL, SENTRY_DSN,
> additional `BETTER_CCFLARE_*` knobs). Capture-all avoids the
> silent-drop class entirely. The captured file becomes the source of
> truth for both the new container's launch AND the post-deploy diff.

```bash
cd ~/ccflare-upgrade-2026-08-03

# Capture the running container's env in docker --env-file format
# (one KEY=value per line, no quoting, no escaping). This is the exact
# format the new container will consume via --env-file.
ssh deploy@ccmax 'docker inspect --format "{{range .Config.Env}}{{println .}}{{end}}" ccflare' \
    | sort > ccmax-env-before.txt

# Sanity-check the critical var is captured. The list is informational;
# the diff in step 4.7 is the actual gate.
echo "ALERT_ANOMALY_ENABLED line in captured env:"
grep '^ALERT_ANOMALY_ENABLED' ccmax-env-before.txt || echo "  <absent>"
```

**Expected**: a non-empty file with one `KEY=value` per line. The file
**must** contain a line beginning with `ALERT_ANOMALY_ENABLED=` (the
value may be `0`, `1`, or anything else — that is for the operator to
verify, not for the script to assume). If the line is absent, the
current container was not launched with that env var explicitly; the
runbook still proceeds (the var may have a config-file default), but
the operator should check whether the deliberate `0` value was lost
in a prior config write. **If `ALERT_ANOMALY_ENABLED=0` was the
operator's stated requirement and the line is absent or has a
non-zero value, STOP and confirm with the operator before continuing.**

The file is now the canonical env for the new container. Do not edit it
by hand. The new container will be launched with `--env-file
ccmax-env-before.txt` (step 4.4).

### 4.2 Eyeball the existing container's run flags (no template)

> A template-based `docker inspect` capture was previously suggested but
> silently dropped flags like `--network host`, `--cap-add NET_ADMIN`,
> `--add-host=...`, log-driver options, etc. The new container must
> replicate the old container's full launch shape, not a template-
> derived subset. The only honest capture is the operator's eyes on the
> actual `docker run` line. This is a 2am runbook — eyeballing is
> load-bearing, not optional.

Open a second terminal and run:

```bash
ssh deploy@ccmax 'ps -ef | grep "docker run\|ccflare" | grep -v grep'
ssh deploy@ccmax 'docker inspect ccflare \
    --format "{{.HostConfig.RestartPolicy.Name}} {{range .Mounts}}[{{.Type}}]{{.Source}}:{{.Destination}}{{end}} {{json .HostConfig.PortBindings}} {{json .HostConfig.NetworkMode}} {{json .HostConfig.CapAdd}} {{json .HostConfig.CapDrop}} {{json .HostConfig.ExtraHosts}} {{.HostConfig.LogConfig.Type}} {{json .HostConfig.LogConfig.Config}}"'
```

**Goal**: produce the list of flags the new container's launch MUST
match. Write the result into `ccmax-run-shape.txt` (operator-supplied,
not template-derived). The new container's `docker run` line in step
4.4 must include every flag the operator eyeballed — missing one
silently degrades the deploy.

### 4.3 Pre-pull the NEW image on ccmax and verify (acquire before destroy)

> **The same destructive-before-verify pattern the rollback was just
> fixed for recurs in the upgrade itself** if we pull the new image
> AFTER `docker rm`. A pull failure would leave ccmax (the operator's
> own dashboard) down with no path back. The new image is pulled and
> verified BEFORE any state change.

```bash
ssh deploy@ccmax bash -s <<'SSHCOMMAND'
set -euo pipefail

NEW_IMAGE="registry.zp.digital/ccflare:v3.5.46"

# Acquire the new image first.
echo "pulling $NEW_IMAGE..."
if ! docker pull "$NEW_IMAGE" >/dev/null 2>&1; then
    echo "FATAL: docker pull $NEW_IMAGE failed." >&2
    echo "  registry.zp.digital is unreachable from ccmax OR the image" >&2
    echo "  has not been pushed yet. Check /etc/docker/daemon.json for" >&2
    echo "  registry-mirrors / insecure-registries. Do not proceed — the" >&2
    echo "  old container must stay running until the new image is in" >&2
    echo "  hand. The rollback script (step 1.2) is for after a deploy," >&2
    echo "  not before." >&2
    exit 1
fi

# Verify the pulled image is the one we expect. Cross-check the digest
# against the digest the build host pushed (captured in step 2.6).
echo "verifying pulled image matches build host's pushed digest..."
LOCAL_DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "$NEW_IMAGE")
echo "  local RepoDigest: $LOCAL_DIGEST"
# The operator substitutes the pushed digest here from pushed-digest.txt.
EXPECTED_DIGEST_FROM_BUILD_HOST=$(cat ~/ccflare-upgrade-2026-08-03/pushed-digest.txt)
echo "  expected from build: $EXPECTED_DIGEST_FROM_BUILD_HOST"
if [ "$LOCAL_DIGEST" != "$EXPECTED_DIGEST_FROM_BUILD_HOST" ]; then
    echo "FATAL: pulled image digest does NOT match the build host's" >&2
    echo "  pushed digest. Possible causes: registry-mirror returned a" >&2
    echo "  stale or wrong image, OR the operator pushed to a different" >&2
    echo "  tag than ccmax is pulling. Do not proceed." >&2
    exit 1
fi
echo "pre-pull OK. The new image is in ccmax's local cache."
SSHCOMMAND
echo "exit=$?"
```

**Expected** (last line): `pre-pull OK. The new image is in ccmax's local cache.`

**If the pre-pull fails**:
- **`docker pull` failed**: registry unreachable, image not yet
  replicated, or auth expired. **DO NOT** proceed to step 4.4. The
  old container is still running (we have not touched it). Investigate
  connectivity first. The fallback is: wait, retry, or stop the entire
  upgrade.
- **Digest mismatch**: a registry mirror returned the wrong image. The
  pulled image is in ccmax's local cache as `registry.zp.digital/ccflare:v3.5.46`
  but it is NOT the one the build host pushed. **DO NOT** proceed.
  Either the registry has a stale image OR the operator pushed to a
  different tag. Investigate. If the only way forward is to use the
  pulled image anyway, edit step 4.4 to use that image's actual digest
  and document the deviation — do not silently proceed.

### 4.4 Stop, remove, and re-launch ccmax (with `--env-file` and the eyeballed flags)

> The destructive step. Runs only after step 4.3 confirmed the new image
> is in ccmax's local cache. Two changes from the previous runbook:
>
> 1. `--env-file` is used (not repeated `-e`). The captured env from
>    step 4.1 is the source of truth; nothing is hand-maintained.
> 2. The docker run line must include every flag from step 4.2's
>    eyeball. A template is not provided — the operator's eyeballed
>    flags go here literally.

If the operator uses **docker compose** instead of `docker run`, the
env preservation rule still applies — but compose files have a
default-flip hazard. The mandatory pre-check:

```bash
# Compose pre-check: ALERT_ANOMALY_ENABLED=0 must be present as a
# LITERAL in the compose file (no ${VAR:-1} interpolation, no
# "0" string the YAML parser might coerce to int).
ssh deploy@ccmax 'grep -nE "^\s*ALERT_ANOMALY_ENABLED" \
    docker-compose.yml compose.yaml 2>/dev/null' || true
```

**Expected output** (one of these — if neither file exists, the
operator is not using compose; skip this pre-check):

```yaml
  environment:
    ALERT_ANOMALY_ENABLED: "0"
```

or:

```yaml
  environment:
    - ALERT_ANOMALY_ENABLED=0
```

**If the literal `=0` is NOT present in the compose file**: **STOP**.
Add the line to the compose file BEFORE running `docker compose up`.
If the file uses `${ALERT_ANOMALY_ENABLED:-1}` or similar
interpolation, replace it with the literal `0` — the interpolation
default (`1`) is exactly the silent-flip this rule was written to
prevent. After the compose file change, re-run the grep to confirm.

For `docker run` deploys (no compose), proceed:

```bash
cd ~/ccflare-upgrade-2026-08-03
scp ccmax-env-before.txt deploy@ccmax:/etc/ccflare/ccflare.env
ssh deploy@ccmax 'chmod 600 /etc/ccflare/ccflare.env'

ssh deploy@ccmax <<'SSHCOMMAND'
set -euo pipefail

# Destroy the old container. The new image is in local cache (step 4.3).
docker stop ccflare
docker rm ccflare

# Launch with the captured env-file. Plus the eyeballed flags from
# step 4.2. The new image ref comes from the same pulled tag.
# DO NOT hand-maintain env vars; the file is the source of truth.
docker run -d \
    --name ccflare \
    --restart=unless-stopped \
    -p 8080:8080 \
    -v /var/lib/ccflare:/data \
    --env-file /etc/ccflare/ccflare.env \
    registry.zp.digital/ccflare:v3.5.46
SSHCOMMAND
echo "exit=$?"
```

**Expected** (last line of SSH output): the first 12 hex chars of the
new container id.

**If the SSH heredoc exits non-zero**: the destructive step completed
(`docker stop` and `docker rm` ran), but the new `docker run` failed.
**The old container is GONE.** Recovery branch:

1. Check `docker logs` on the failed new container for the error
   message.
2. If the error is recoverable (port conflict, volume already in use,
   name collision), fix and re-run the `docker run` line manually.
3. If the error is NOT recoverable (image corruption, env-file
   unreadable, runtime config bug in the new image), execute the
   generated `rollback-ccmax.sh` to restore the old image and env.
4. Either way, the runbook HALTs here. Do not proceed to step 4.5.

### 4.5 Wait for the new container to be healthy (bounded loop with auto-rollback)

> The previous runbook's `sleep 60; check; if starting, sleep 30 and
> re-check` had no max iterations. At 2am, a hung healthcheck means
> the operator waits indefinitely. This version caps the wait at
> ~3 minutes; if the container is not healthy by then, the runbook
> auto-rolls back via the generated `rollback-ccmax.sh`.

```bash
# Bounded health wait. /health's start_period is 40s; allow up to 6
# iterations of 30s sleep + check = ~3 minutes total before auto-rollback.
HEALTHY=""
for i in 1 2 3 4 5 6; do
    STATUS=$(ssh deploy@ccmax 'docker inspect --format "{{.State.Health.Status}}" ccflare' 2>/dev/null)
    case "$STATUS" in
        healthy)
            HEALTHY="yes"
            echo "iteration $i: healthy"
            break
            ;;
        starting)
            echo "iteration $i: starting (waiting 30s)"
            sleep 30
            ;;
        unhealthy)
            echo "iteration $i: unhealthy (waiting 30s, will retry up to limit)"
            sleep 30
            ;;
        "")
            echo "iteration $i: container not inspectable (SSH or docker issue)"
            sleep 30
            ;;
        *)
            echo "iteration $i: unexpected status '$STATUS' (waiting 30s)"
            sleep 30
            ;;
    esac
done

if [ "$HEALTHY" != "yes" ]; then
    echo "FATAL: container did not become healthy within ~3 minutes." >&2
    echo "  Auto-rolling back via rollback-ccmax.sh." >&2
    scp ~/ccflare-upgrade-2026-08-03/rollback-ccmax.sh deploy@ccmax:/tmp/
    ssh deploy@ccmax 'bash /tmp/rollback-ccmax.sh'
    echo "FATAL: rollback attempted. Investigate offline." >&2
    exit 1
fi
```

**Expected**: `iteration N: healthy` followed by no auto-rollback
message.

**If the loop times out**: auto-rollback has executed. **STOP** the
runbook; do not proceed to step 4.6. The operator's dashboard (ccmax)
is restored to its v3.5.44+zp6 state; the upgrade has been rolled
back; investigate offline.

### 4.6 Capture the new image's provenance on ccmax (with exit-code discipline)

```bash
cd ~/ccflare-upgrade-2026-08-03
scripts/verify-live-build.sh \
    --ssh deploy@ccmax \
    --container ccflare \
    --health-port 8080 \
    -o ccmax-after.txt
VERIFY_EXIT=$?
echo "verify-live-build exit=$VERIFY_EXIT"
grep -q '^STATUS:[[:space:]]\+VERIFIED_MATCH' ccmax-after.txt \
    || { echo "FATAL: STATUS line missing or not VERIFIED_MATCH — investigate before proceeding" >&2; exit 1; }
```

**Expected** (last lines of `ccmax-after.txt`):

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

**Failure modes**:
- `verify-live-build exit=1` (VERIFIED_DRIFT): the new container does
  not agree with its own image labels. The image is the wrong one OR
  the labels were overridden at runtime. **STOP**.
- `verify-live-build exit=2` (COULD_NOT_DETERMINE): a required signal
  was not extractable. **STOP**. Check `MISSING_FIELDS:` in
  `ccmax-after.txt` and the method lines; re-run with `--debug` if
  needed.
- `verify-live-build exit=0` but `STATUS: VERIFIED_DRIFT` (the script
  exited 0 by mistake): the grep gate above catches this. **STOP**.
- `HEALTH_GIT_SHA` does NOT match `c3376345a7c811874dd58346af2c09b55dadf0a3`:
  same STOP, same reasoning as step 5.1.

### 4.7 Env diff (captured-vs-running)

> The post-deploy env diff is the gate that catches a silent env drop.
> If the new container is missing any var the old container had, the
> diff is non-empty. Empty diff is the expected case; a non-empty diff
> is a STOP.

```bash
cd ~/ccflare-upgrade-2026-08-03

# Pull the running container's env in the same --env-file format.
ssh deploy@ccmax 'docker exec ccflare sh -c "tr \"\\0\" \"\\n\" < /proc/1/environ"' \
    | sort > ccmax-env-after.txt

# Diff. Empty diff is the goal.
echo "--- env diff (captured before vs running after) ---"
diff ccmax-env-before.txt ccmax-env-after.txt
DIFF_RC=$?
echo "--- end diff (exit=$DIFF_RC, 0=identical) ---"

if [ $DIFF_RC -ne 0 ]; then
    echo "FATAL: env drifted between pre-upgrade capture and post-upgrade" >&2
    echo "  running state. A var is missing from the new container. The" >&2
    echo "  --env-file path may be wrong, or the operator-edited env was" >&2
    echo "  lost in transit. Roll back per rollback-ccmax.sh and reconcile" >&2
    echo "  the env before retrying." >&2
    exit 1
fi

# Specific re-confirmation of the deliberate flag.
echo "ALERT_ANOMALY_ENABLED in running container:"
grep '^ALERT_ANOMALY_ENABLED' ccmax-env-after.txt || echo "  <absent: would default to file/env precedence — verify>"
```

**Expected**: `--- end diff (exit=0, 0=identical) ---` and
`ALERT_ANOMALY_ENABLED=0`.

**If diff is non-empty**: the new container is missing at least one
var from the captured env. The most common causes are: `--env-file`
path is wrong (file does not exist or has different content), the
docker run line overrode with a stray `-e`, or the operator-edited
env file in /etc/ccflare was overwritten. **STOP**; roll back; do
not proceed to step 5.

---

## Step 5 — Verify ccmax's behaviour (functional, not just provenance)

These checks are about runtime behaviour, not image metadata. Each must pass
on ccmax before proceeding to ccproxy2.

### 5.1 /health (the operator-visible upgrade signal)

```bash
EXPECTED_GIT_SHA="c3376345a7c811874dd58346af2c09b55dadf0a3"
EXPECTED_GIT_REF="v3.5.46"

curl -fsS --max-time 10 --connect-timeout 5 http://ccmax:8080/health | tee /tmp/ccmax-health.json | jq --arg expected "$EXPECTED_GIT_SHA" '{
    status,
    version,
    git_sha,
    git_ref,
    build_date,
    git_sha_matches_expected: (.git_sha == $expected),
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
  "git_sha_matches_expected": true,
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
- `git_sha_matches_expected: false`: the SHA on the running image does NOT
  match `c3376345a7c811874dd58346af2c09b55dadf0a3`. **STOP**. The image is
  not the one this runbook was designed to deploy. This catches the
  case where the build host was reused across days and `GIT_SHA` resolved
  to a stale value, OR the operator typo'd, OR the build used a different
  source tree than step 2.1's `git checkout v3.5.46`.
- `git_ref` is not `v3.5.46`: same STOP, same reason.
- `pool.routable` dropped to 0 vs. before: the new build broke account
  selection. **STOP.**
- `curl` exited with code 28 (operation timeout) or code 7 (connect
  refused): the container is hung or the port is unmapped. See step 4.5
  for the bounded health wait — if the container is reported healthy but
  `/health` itself hangs, the server's request loop is broken. Roll back
  per `rollback-ccmax.sh` and investigate offline.

### 5.2 /api/stats (the HTTP 500 SQLSTATE 42803 regression canary)

> This is the exact endpoint that returned HTTP 500 with `SQLSTATE 42803`
> the last time we broke Postgres compatibility. It is the most reliable
> detector of "the migration parity broke."

```bash
ADMIN_KEY="<the operator's pre-existing admin API key for ccmax>"
curl -fsS --max-time 15 --connect-timeout 5 -w "\nHTTP_STATUS: %{http_code}\n" \
    -H "Authorization: Bearer ${ADMIN_KEY}" \
    http://ccmax:8080/api/stats | tail -30
```

**Expected**: `HTTP_STATUS: 200` and a JSON body with at least the keys
`totalRequests`, `successRate`, `activeAccounts`, `totalTokens`, `accounts[]`,
`recentErrors[]`. The numeric values will differ from the pre-upgrade capture
(that's fine — there has been traffic).

**If `HTTP_STATUS: 500`**: the migration parity is broken. The body will
contain `SQLSTATE 42803` or similar Postgres-shaped errors. **Roll back
ccmax** using `rollback-ccmax.sh` (the script is at the runbook root;
generated in step 1.2). **STOP** — do not proceed to ccproxy2.

**If `HTTP_STATUS: 401`**: the API key is missing admin scope, or is wrong.
That is NOT a regression — substitute a valid admin key and retry. If no
admin key is available, the operator must mint one before continuing.

**If curl exits with code 28 (operation timeout) or 7 (connect refused)**:
the server is hung or unreachable. The bounded health wait in step 4.5
passed, so the container is "healthy" — but a healthy container can still
hang on a request that blocks on a bad migration. Roll back per
`rollback-ccmax.sh`. The migration parity is broken even if `/health`
returns 200.

### 5.3 /api/insights/anomalies (lightweight post-deploy sanity)

```bash
curl -fsS --max-time 15 --connect-timeout 5 -w "\nHTTP_STATUS: %{http_code}\n" \
    -H "Authorization: Bearer ${ADMIN_KEY}" \
    "http://ccmax:8080/api/insights/anomalies?range=24h" \
    | jq '{meta: .meta, detector_count: (.anomalies | length)}'
```

**Expected**: `HTTP_STATUS: 200`. `meta.truncated` may be true on a busy host
that's fine. `meta` should include `range`, `zScoreThreshold`, and the
configured detectors.

**If `HTTP_STATUS: 5xx`**: the anomalies endpoint is also a Postgres-shaped
query path. **Roll back ccmax** per `rollback-ccmax.sh`.

**If curl times out (exit 28)**: same as 5.2 — roll back.

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

### 7.0 Pre-step-7 ccmax re-check (do not skip)

> Between step 6's "ccmax is healthy" and step 7's first mutation, ccmax
> can independently degrade (new container crashes on second write, host
> runs out of disk, network blip, etc.). The operator's own dashboard
> is ccmax; if it silently goes down during the ccproxy2 work, the
> operator may not notice until step 7.4's failures push them to
> investigate. Verify ccmax one more time before touching ccproxy2.

```bash
curl -fsS --max-time 5 --connect-timeout 3 http://ccmax:8080/health \
    | jq -e '.status == "ok"' >/dev/null || {
        echo "FATAL: ccmax is not ok RIGHT NOW. STOP. Investigate before" >&2
        echo "  touching ccproxy2 — the operator's dashboard visibility is" >&2
        echo "  gone and you cannot safely reason about the deploy state." >&2
        exit 1
    }
echo "ccmax still healthy."
```

**Expected**: `ccmax still healthy.`

**If ccmax is degraded or unreachable**: **STOP**. Do not start
ccproxy2 work. The operator's primary visibility is gone. Roll back
ccmax per `rollback-ccmax.sh` if needed, then investigate.

### 7.1 Capture existing env into a file

```bash
cd ~/ccflare-upgrade-2026-08-03

ssh deploy@ccproxy2 'docker inspect --format "{{range .Config.Env}}{{println .}}{{end}}" ccflare' \
    | sort > ccproxy2-env-before.txt

echo "ALERT_ANOMALY_ENABLED line in captured env:"
grep '^ALERT_ANOMALY_ENABLED' ccproxy2-env-before.txt || echo "  <absent>"
```

**Expected**: same `ALERT_ANOMALY_ENABLED=0` (per the operator's stated
requirement). If absent or non-zero, STOP and confirm with the
operator.

### 7.2 Pre-pull NEW image, then stop+remove+relaunch with `--env-file`

> Mirror of step 4.3 + 4.4. Same acquire-before-destroy pattern; same
> `--env-file`; same compose pre-check; same recovery branch if the
> destructive step partially fails.

```bash
# Pre-pull the new image.
ssh deploy@ccproxy2 bash -s <<'SSHCOMMAND'
set -euo pipefail
NEW_IMAGE="registry.zp.digital/ccflare:v3.5.46"
if ! docker pull "$NEW_IMAGE" >/dev/null 2>&1; then
    echo "FATAL: docker pull $NEW_IMAGE failed on ccproxy2." >&2
    exit 1
fi
LOCAL_DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "$NEW_IMAGE")
EXPECTED=$(cat ~/ccflare-upgrade-2026-08-03/pushed-digest.txt)
if [ "$LOCAL_DIGEST" != "$EXPECTED" ]; then
    echo "FATAL: ccproxy2 pulled digest does NOT match build host's pushed digest." >&2
    exit 1
fi
echo "ccproxy2 pre-pull OK."
SSHCOMMAND

# Compose pre-check (mirror of step 4.4).
ssh deploy@ccproxy2 'grep -nE "^\s*ALERT_ANOMALY_ENABLED" \
    docker-compose.yml compose.yaml 2>/dev/null' || true

# Stop, remove, re-launch with --env-file.
cd ~/ccflare-upgrade-2026-08-03
scp ccproxy2-env-before.txt deploy@ccproxy2:/etc/ccflare/ccflare.env
ssh deploy@ccproxy2 'chmod 600 /etc/ccflare/ccflare.env'

ssh deploy@ccproxy2 <<'SSHCOMMAND'
set -euo pipefail
docker stop ccflare
docker rm ccflare
docker run -d \
    --name ccflare \
    --restart=unless-stopped \
    -p 8080:8080 \
    -v /var/lib/ccflare:/data \
    --env-file /etc/ccflare/ccflare.env \
    registry.zp.digital/ccflare:v3.5.46
SSHCOMMAND
echo "exit=$?"
```

**Expected**: the SSH heredoc returns the new container id; no FATAL
lines in the pre-pull output.

**If the heredoc exits non-zero** after the pre-pull passed: the
destructive step partially failed. **The old container is GONE.**
Recovery per the same branch as step 4.4: check logs, fix and re-run
the `docker run` line, or execute `rollback-ccproxy2.sh`.

### 7.3 Wait for healthy (bounded) and capture provenance

> Mirrors step 4.5 + 4.6 with the same bounded-loop auto-rollback and
> the same exit-code discipline on the verify-live-build invocation.

```bash
HEALTHY=""
for i in 1 2 3 4 5 6; do
    STATUS=$(ssh deploy@ccproxy2 'docker inspect --format "{{.State.Health.Status}}" ccflare' 2>/dev/null)
    case "$STATUS" in
        healthy) HEALTHY="yes"; echo "iteration $i: healthy"; break ;;
        starting|unhealthy|"") sleep 30; echo "iteration $i: $STATUS" ;;
        *) sleep 30; echo "iteration $i: unexpected '$STATUS'" ;;
    esac
done
[ "$HEALTHY" = "yes" ] || {
    echo "FATAL: ccproxy2 not healthy in ~3 min. Auto-rolling back." >&2
    scp ~/ccflare-upgrade-2026-08-03/rollback-ccproxy2.sh deploy@ccproxy2:/tmp/
    ssh deploy@ccproxy2 'bash /tmp/rollback-ccproxy2.sh'
    exit 1
}

cd ~/ccflare-upgrade-2026-08-03
scripts/verify-live-build.sh \
    --ssh deploy@ccproxy2 \
    --container ccflare \
    --health-port 8080 \
    -o ccproxy2-after.txt
VERIFY_EXIT=$?
echo "verify-live-build exit=$VERIFY_EXIT"
grep -q '^STATUS:[[:space:]]\+VERIFIED_MATCH' ccproxy2-after.txt \
    || { echo "FATAL: STATUS line missing or not VERIFIED_MATCH — STOP" >&2; exit 1; }
```

**Expected**: `verify-live-build exit=0` and the STATUS line check passes.

### 7.4 Functional verification (mirror step 5)

Repeat every check from step 5 against `ccproxy2:8080`. Same pass
criteria. The HTTP 500 SQLSTATE 42803 case on `/api/stats` is the
most load-bearing gate; if it returns 5xx on ccproxy2, **roll back
ccproxy2 per `rollback-ccproxy2.sh`**.

### 7.4.5 ccproxy2 dashboard eye-check (operator, BLOCKING)

> The ccmax dashboard eye-check (step 5.4) has no machine-verifiable
> equivalent on ccproxy2 — a regression that breaks the 5h/7d rendering
> path on ccproxy2 would not surface on /health, /api/stats, or
> /api/insights/anomalies. The operator must look at the page.

Open `https://ccproxy2/accounts` in a browser. For at least one
account on the page, confirm:

- A **"5-hour"** progress bar is visible with a non-zero utilization value.
- A **"Weekly"** progress bar is visible.
- Per-model weekly scoped windows (e.g. **"Fable (Weekly)"**) appear
  if the account has them.
- A reset time string is visible on each bar.

**If the bars are missing or empty on ccproxy2**: the rate-limit
rendering regressed. Roll back ccproxy2 per `rollback-ccproxy2.sh`.
Do not consider step 7 complete until the operator confirms the
dashboard renders.

### 7.5 Env diff (captured-vs-running) on ccproxy2

> Mirror of step 4.7. The post-deploy env diff catches a silent env drop.

```bash
cd ~/ccflare-upgrade-2026-08-03
ssh deploy@ccproxy2 'docker exec ccflare sh -c "tr \"\\0\" \"\\n\" < /proc/1/environ"' \
    | sort > ccproxy2-env-after.txt
diff ccproxy2-env-before.txt ccproxy2-env-after.txt
[ $? -eq 0 ] || { echo "FATAL: ccproxy2 env drifted. Roll back." >&2; exit 1; }
grep '^ALERT_ANOMALY_ENABLED' ccproxy2-env-after.txt
```

**Expected**: empty diff output and `ALERT_ANOMALY_ENABLED=0`.

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
ccmax-env-after.txt
ccproxy2-before.txt
ccproxy2-before.summary.json
ccproxy2-after.txt
ccproxy2-after.summary.json
ccproxy2-env-before.txt
ccproxy2-env-after.txt
canary-compare.json
pinned-compare.json
pushed-digest.txt
ccmax-run-shape.txt
rollback-ccmax.sh
rollback-ccproxy2.sh
```

Archive the directory somewhere safe. If either host later misbehaves, the
`*-before.txt` and `*-after.txt` captures are the comparison basis.

---

## Appendix A — Rollback (one command per host)

> The rollback scripts are **generated in steps 1.2 (ccmax) and 3.1 (ccproxy2)**
> from the live captured digests. They do NOT exist at the start of the runbook
> — by design, because any pre-written digest is hearsay.

If anything goes wrong at any point after step 4, roll back the affected host
with the generated script:

```bash
# On the operator's workstation:
scp rollback-ccmax.sh deploy@ccmax:/tmp/
ssh deploy@ccmax 'bash /tmp/rollback-ccmax.sh'
```

The generated script's contract:
- Pre-flight: confirm the captured image is retrievable (local cache or pull).
  If the image has been garbage-collected from the registry, the script aborts
  with `FATAL: rollback image ... is not retrievable. HALT — this upgrade is one-way.`
  and **no state change occurs**.
- Only after the pre-flight passes: `docker stop ccflare && docker rm ccflare`.
- Re-launch with the captured env file and the captured image ref (full 64-char
  digest, no truncation, no tag re-resolution).

This is **not** a fix — it's a known-good restore. The operator should then
investigate offline.

**If the rollback script refuses to run** (the pre-flight fails): the captured
image is gone from the registry. There is no automated path back. The operator
must either (a) find a preserved copy of the v3.5.44+zp6 image elsewhere
(backup of the registry, a separate build that hasn't been GC'd), or (b) accept
that this host is now running v3.5.46 with whatever bugs that introduced.

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
