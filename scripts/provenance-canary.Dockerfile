# syntax=docker/dockerfile:1.7
#
# Containerized wrapper for the provenance canary. The canary is a bash
# comparator; it MUST be run from somewhere that can reach both the deploy
# host's /health endpoint and the git repo. This image packages git, curl,
# jq, and bash into a 5 MB alpine root so a docker daemon on the deploy
# host (or any LAN host) can run the canary as a scheduled container.
#
# Build:
#   docker build -t ccflare-provenance-canary:latest \
#       -f scripts/provenance-canary.Dockerfile scripts/
#
# Run:
#   docker run --rm --network=host \
#       ccflare-provenance-canary:latest \
#       --host http://ccproxy2.example:8080/health \
#       --repo https://github.com/zenprocess/better-ccflare.git \
#       --branch deploy/2026-07-30
#
# Exit code is the verdict (0 match, 1 drift, 2 could-not-check).
#
# Pin the image tag when scheduling. The canary itself is small enough
# to re-pull on each invocation; if you do, mount a credentials secret
# for private repos:
#   docker run --rm \
#       --mount type=bind,source=$HOME/.ssh/id_ed25519,target=/ssh/id_ed25519,readonly \
#       ccflare-provenance-canary:latest \
#       --ssh-key /ssh/id_ed25519 \
#       --host http://ccproxy2.example:8080/health \
#       --repo git@github.com:zenprocess/better-ccflare.git \
#       --branch deploy/2026-07-30

FROM alpine:3.20

RUN apk add --no-cache \
        bash \
        curl \
        git \
        jq \
        openssh-client \
    && addgroup -S canary && adduser -S canary -G canary

USER canary

COPY provenance-canary.sh /usr/local/bin/provenance-canary.sh

ENTRYPOINT ["/usr/local/bin/provenance-canary.sh"]
CMD ["--help"]
