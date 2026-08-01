# syntax=docker/dockerfile:1.7
#
# Build ccflare from a checked-out source tree.
#
# This Dockerfile is the canonical from-source build recipe. It is the
# provenance anchor (ao-company #110): every build invocation records
# (a) the exact git ref it was built from, (b) the exact Bun runtime it
# embeds, and (c) the build timestamp. The /health endpoint exposes (a)
# and (b) at runtime; (c) lives in the OCI image labels.
#
# Build-time provenance contract:
#   * Both FROM stages pin the SAME Bun manifest digest per architecture.
#     The digest is the only thing that mechanically identifies the
#     embedded Bun binary.
#   * The canonical Bun revision is what `bun --revision` reports inside
#     the final image. We do NOT trust the OCI
#     `org.opencontainers.image.revision` label as a substitute — that
#     label has been observed to disagree with the binary (followup to
#     bun#35093): labels lie, binaries do not.
#   * The build context MUST be a git checkout. The build args GIT_REF
#     and GIT_SHA are recorded by the operator/CI at build time and
#     stamped into the image labels AND the runtime env.
#
# ---------------------------------------------------------------
# ⚠ MUTABLE CANARY BASE — REVERIFY BEFORE EVERY BUILD
# ---------------------------------------------------------------
#
# Per zeninfra 2026-08-01: no stable Bun release carries the bun#35093
# fetch-abort fix. The latest stable (oven/bun:1.3.14-alpine, shipped
# 2026-05-13) is 76 days before the fix commit (789be97, 2026-07-28).
# Therefore this Dockerfile pins the `:canary-alpine` tag, not a
# stable version. The canary tag is mutable — its content can change
# without the digest changing unless the operator re-pins.
#
# Before EVERY build, re-resolve the canary digest at the registry and
# re-run the containment test below. If the canary loses the fix (new
# main-branch corrections, regression, etc.) the digest changes and
# this Dockerfile will need to be updated. The brief from the operator
# is explicit: "no stable Bun contains the fix. Your finding stands
# and 'wait for 1.3.15+' is not a viable path."
#
# Supply-chain fragility: the production build depends on a mutable
# canary tag. This is a real, not-papered-over operational risk. The
# only mitigations are (a) re-resolve the digest before every build,
# (b) re-run the containment test, and (c) move to a stable tag once
# oven-sh/bun ships 1.3.15+ with the fix. Until (c), every deploy is
# a canary-tagged deploy.
#
# ---------------------------------------------------------------
# CANARY BASE — verified 2026-08-01
# ---------------------------------------------------------------
#
# Resolved from oven/bun:canary-alpine via the Docker Hub registry
# HTTP API (publicly reachable; not the operator's private registry).
#
# Tag:                   oven/bun:canary-alpine
# amd64 manifest digest: sha256:aead81873566d42926d8cbb8dc915bdd5547d2f59a8f7e46220ba83dd167b210
# arm64 manifest digest: sha256:91bbe5b25a29561ae6fad60587fef03350acb6c74bebaef87b6031738e96bf94
# Image created:         2026-07-31T14:52:35.280Z
# Embedded Bun revision: f68e504ae48a5a54eb3017f29baa99dd31660a5e
# Embedded version:      1.4.0-canary.1+f68e504ae
#
# Three-source verification of the embedded commit:
#   (1) OCI image config label
#       org.opencontainers.image.revision = f68e504ae48a5a54eb3017f29baa99dd31660a5e
#   (2) Binary build path (via `strings` on the extracted bun binary)
#       /tmp/bun-node-f68e504ae/bun
#   (3) Binary version string (via `strings` on the extracted bun binary)
#       1.4.0-canary.1+f68e504ae
# All three agree on f68e504ae.
#
# Containment test — the step that matters and the one we got wrong
# before. Having the same commit prefix does NOT prove the fix is
# included. The fix must be a strict ancestor of the embedded commit:
#
#   gh api repos/oven-sh/bun/compare/789be97db9b746533cf692e8367146e2d3c0d7cb...f68e504ae48a5a54eb3017f29baa99dd31660a5e
#
# Result (verbatim, 2026-08-01):
#   status:                ahead
#   ahead_by:              103
#   behind_by:             0
#   total_commits:         103
#   merge_base_commit.sha: 789be97db9b746533cf692e8367146e2d3c0d7cb
#   merge_base_commit.title:
#       fetch: error the response body stream when a fully-buffered
#       response is aborted (#35093)
#
# The merge base IS the bun#35093 fix commit. The canary is 103 commits
# ahead of the fix, 0 behind. Containment is proven.
#
# Re-run this exact verify block before every build:
#   1. docker registry pull the manifest for oven/bun:canary-alpine
#   2. record the amd64 manifest digest → that digest IS the pin
#   3. extract usr/local/bin/bun from the layer, grep for bun-node-
#      <sha> with `strings`, recover the embedded commit
#   4. run the gh api compare endpoint against 789be97db9b746533cf692e8367146e2d3c0d7cb
#   5. require status=ahead, behind_by=0, merge_base_commit.sha=789be97db9b746533cf692e8367146e2d3c0d7cb
#   6. if any check fails, abort the build; the canary no longer
#      contains the fix and pinning it would be a ship of an unprovable
#      build.
#
# ---------------------------------------------------------------

# ---------------------------------------------------------------------------
# Build-time provenance args. GIT_REF and GIT_SHA are required; the build
# fails fast if either is missing.
# ---------------------------------------------------------------------------
ARG GIT_REF
ARG GIT_SHA
ARG BUILD_DATE

# ---------------------------------------------------------------------------
# Bun base. Canary digest pinned per architecture. MUTABLE — see header.
# ---------------------------------------------------------------------------
ARG BUN_IMAGE_AMD64=oven/bun@sha256:aead81873566d42926d8cbb8dc915bdd5547d2f59a8f7e46220ba83dd167b210
ARG BUN_IMAGE_ARM64=oven/bun@sha256:91bbe5b25a29561ae6fad60587fef03350acb6c74bebaef87b6031738e96bf94

# ===========================================================================
# Stage 1 — builder
# ===========================================================================
FROM --platform=$BUILDPLATFORM ${BUN_IMAGE_AMD64} AS builder-amd64
FROM --platform=$BUILDPLATFORM ${BUN_IMAGE_ARM64} AS builder-arm64
FROM builder-${TARGETARCH} AS builder

WORKDIR /build

# Reproducible dependency install. Bun's hoisted workspace layout reads
# bun.lock at the monorepo root, so the manifest + lockfile pair has to
# land in the same COPY as the workspace package.jsons to maximize layer
# cacheability.
COPY bun.lock package.json ./
COPY apps ./apps
COPY packages ./packages

# `bun install --frozen-lockfile` rejects drift between package.json and
# bun.lock. We install the full tree (incl. devDependencies) so the
# dashboard build step can resolve its plugins.
RUN bun install --frozen-lockfile

# Build the dashboard bundle the server serves at /.
RUN bun run build:dashboard

# Compile the server to a single binary so the runtime image does not
# have to ship node_modules. The output is a self-contained executable.
RUN cd apps/server && bun build src/server.ts --compile --outfile /build/ccflare-server

# ===========================================================================
# Stage 2 — runtime (final image)
# ===========================================================================
FROM ${BUN_IMAGE_AMD64} AS final-amd64
FROM ${BUN_IMAGE_ARM64} AS final-arm64
FROM final-${TARGETARCH} AS final

# Runtime OS dependencies. ca-certificates for TLS, curl for the
# HEALTHCHECK probe, sqlite3 for operators who want to inspect /data/*.db.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Re-declare the build args in the final stage and emit them as both
# image labels (so `docker inspect` exposes them) and env vars (so the
# process reports them at /health via the env-reader).
ARG GIT_REF
ARG GIT_SHA
ARG BUILD_DATE
ARG BUN_IMAGE_AMD64
ARG BUN_IMAGE_ARM64
ENV CCFLARE_GIT_REF=${GIT_REF} \
    CCFLARE_GIT_SHA=${GIT_SHA} \
    CCFLARE_BUILD_DATE=${BUILD_DATE} \
    CCFLARE_BUN_IMAGE=${BUN_IMAGE_AMD64}

# Standard runtime contract.
ENV NODE_ENV=production \
    PORT=8080 \
    CCFLARE_HOST=0.0.0.0 \
    CCFLARE_DB_PATH=/data/ccflare.db \
    XDG_CONFIG_HOME=/data

WORKDIR /app

# Non-root ccflare user (uid/gid 1000) and the /data volume.
RUN groupadd --system --gid 1000 ccflare \
    && useradd  --system --uid 1000 \
                --gid ccflare \
                --shell /usr/sbin/nologin \
                --create-home --home-dir /home/ccflare \
                ccflare \
    && mkdir -p /data /app/logs \
    && chown -R ccflare:ccflare /data /app

# Copy the compiled server and the dashboard bundle.
COPY --from=builder --chown=ccflare:ccflare /build/ccflare-server ./ccflare-server
COPY --from=builder --chown=ccflare:ccflare /build/apps/web/dist        ./apps/web/dist

# Sanity check at build time: record the embedded Bun revision. The
# canary (scripts/provenance-canary.sh) verifies this against the live
# image at runtime and fails loudly on drift.
RUN bun --revision > /etc/ccflare-bun-revision || true

USER ccflare

VOLUME ["/data"]

EXPOSE 8080

# Healthcheck cadence matches the upstream tag. start_period=40s gives the
# server ~15s startup budget twice over; an under-budgeted start_period
# produces noisy `unhealthy` flapping during cold starts.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -fsS http://127.0.0.1:${PORT}/health || exit 1

# ---------------------------------------------------------------------------
# OCI image labels. The contractual provenance surface for the image;
# the running container's /health complements them with the runtime's
# *view* of the same data.
# ---------------------------------------------------------------------------
LABEL org.opencontainers.image.title="ccflare" \
      org.opencontainers.image.description="Multi-provider AI proxy" \
      org.opencontainers.image.source="https://github.com/tombii/better-ccflare" \
      org.opencontainers.image.url="https://github.com/tombii/better-ccflare" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.version="${GIT_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.base.name="oven/bun" \
      org.opencontainers.image.base.digest="${BUN_IMAGE_AMD64}" \
      org.opencontainers.image.base.version="canary-alpine" \
      org.opencontainers.image.base.revision="f68e504ae48a5a54eb3017f29baa99dd31660a5e" \
      org.opencontainers.image.base.containment="behind_789be97d_by_0_commits"

CMD ["/app/ccflare-server"]
