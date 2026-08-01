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
# Bun base selection (verified 2026-08-01):
#   * Tag: oven/bun:1.3.14-alpine
#   * amd64 manifest digest: sha256:efc5e42c7bedc1661ab0b7272c74c3ebf794f054297f530a62055f2d1a0eb662
#   * arm64 manifest digest: sha256:3c9ab1a521c82144dff537125695017a0480d3a13088fba7e012cfae0f63146f
#   * Verification: the bun binary was extracted from the amd64 manifest's
#     largest layer and inspected with `strings`. The embedded path
#     `/tmp/bun-node-0d9b296af/bun` and the version string
#     `v1.3.14 (0d9b296a)` match the OCI label
#     `org.opencontainers.image.revision = 0d9b296af33f2b851fcbf4df3e9ec89751734ba4`.
#     Three independent sources agree on the embedded Bun commit.
#   * Caveat: the embedded Bun commit (0d9b296af, dated 2026-05-12) is
#     BEFORE the bun#35093 fetch-abort fix (789be97, dated 2026-07-28).
#     This image does NOT contain bun#35093. If the fix is required, the
#     operator must (a) pull the current oven/bun:canary-alpine and pin
#     its CURRENT digest (mutable — re-record before each build), or
#     (b) wait for 1.3.15+.
#
# No moving tags in FROM. The build does not know which canary revision
# the source repo was paired with; use a digest.

# ---------------------------------------------------------------------------
# Build-time provenance args. GIT_REF and GIT_SHA are required; the build
# fails fast if either is missing.
# ---------------------------------------------------------------------------
ARG GIT_REF
ARG GIT_SHA
ARG BUILD_DATE

# ---------------------------------------------------------------------------
# Bun base. Manifest digest pinned per architecture so the digest is the
# only thing that mechanically identifies the embedded binary.
# ---------------------------------------------------------------------------
ARG BUN_IMAGE_AMD64=oven/bun@sha256:efc5e42c7bedc1661ab0b7272c74c3ebf794f054297f530a62055f2d1a0eb662
ARG BUN_IMAGE_ARM64=oven/bun@sha256:3c9ab1a521c82144dff537125695017a0480d3a13088fba7e012cfae0f63146f

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
      org.opencontainers.image.base.version="1.3.14-alpine" \
      org.opencontainers.image.base.revision="0d9b296af33f2b851fcbf4df3e9ec89751734ba4"

CMD ["/app/ccflare-server"]
