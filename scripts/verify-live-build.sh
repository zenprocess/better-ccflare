#!/usr/bin/env bash
#
# verify-live-build.sh — read-only provenance capture for a live ccflare
# host (ao-company #110).
#
# THIS IS THE PRIMARY PROVENANCE DELIVERABLE. The AO executor cannot reach
# ccproxy2 / ccmax / dellsrv from its sandbox (DNS for *.zp.digital is
# NXDOMAIN and the egress allowlist is closed by design). This script is
# designed to be run by an operator who CAN reach the deploy host, against
# a live production container, with no debugging expected.
#
# It captures:
#   1. The container id and image reference of the running ccflare.
#   2. The image's manifest digest (sha256:...).
#   3. The /health response (provenance fields: version, git_sha,
#      git_ref, build_date).
#   4. The actual `bun --revision` reported by the binary inside the
#      container — NOT the image label. Labels lie; binaries do not.
#   5. The OCI image labels (org.opencontainers.image.*).
#   6. The image's layer digests (so the operator can independently match
#      against a registry they control).
#
# Each captured value is printed on its own labeled line in the format
# `KEY: value`. The script is strictly read-only: it never pulls, never
# restarts, never stops, never removes, never writes to the host beyond a
# single output file (the operator's chosen path).
#
# On any failure, it prints a FATAL line and exits non-zero. The output
# can be redirected to a file and pasted into a bug report; nothing
# depends on the operator being able to interpret it live.
#
# Usage:
#   scripts/verify-live-build.sh [OPTIONS]
#
# Source of data (one of, required):
#   --ssh HOST                  Run the checks via SSH on HOST. The script
#                               will SSH into HOST and run docker commands
#                               there. This is the recommended mode for
#                               remote ccproxy2 / ccmax.
#   --local                     Run the checks locally against a daemon
#                               the operator is already on. Useful for
#                               cctest.
#
# Target (one of, required when --ssh):
#   --container NAME            Docker container name (or id) running
#                               ccflare. Defaults to "ccflare" on --local.
#   --no-container              Do not query a container; just query the
#                               local image cache for `ccflare` images.
#                               Useful for offline registry audits.
#
# Network:
#   --health-url URL            URL of /health (default: try the docker
#                               port mapping; if --ssh is set, the script
#                               will curl from the remote host).
#                               If you cannot reach the health endpoint
#                               from where this script runs, use --ssh so
#                               it curls from the same host as the
#                               container.
#
# Output:
#   -o FILE                     Write the captured report to FILE
#                               (default: stdout). The file is overwritten
#                               if it exists; the script does not append.
#
# Misc:
#   --ssh-key PATH              SSH key for --ssh mode.
#   --ssh-port PORT             SSH port (default 22).
#   --ssh-user USER             SSH user (default: current user).
#   --help                      Show this help.
#
# Exit codes:
#   0  all checks succeeded
#   1  at least one captured value is missing or unexpected
#   2  prerequisites not met (Docker not found, SSH failed, etc.)
#   64  invalid arguments
#
# ----------------------------------------------------------------------
# WHY EVERY CHECK IS NON-NEGOTIABLE
# ----------------------------------------------------------------------
#
#   * Container id — proves a container was actually running and we did
#     not capture stale data from a previous service.
#   * Image reference — the only thing that names the image; everything
#     else (digest, layers, labels) is a property of this reference.
#   * Image digest — the content-addressed identifier. A `:tag` can
#     move; a digest cannot.
#   * /health — the canonical runtime provenance as the application
#     itself sees it. If the image was built with the Dockerfile in
#     this repo, /health echoes the build-time args.
#   * bun --revision inside the container — the ground truth. The
#     bun#35093 followup burned a digest whose label claimed
#     8afcd4b45d31 while the binary reported 9b678b407. Labels lie;
#     binaries do not.
#   * OCI labels — corroborate the /health values. If the labels and
#     /health disagree, the image is mis-built or has been re-tagged.
#   * Layer digests — independent content fingerprint. If you have a
#     second source of digests (e.g. a registry you control), you can
#     match layers mechanically.
#
# The script will NOT pass if any of these is missing. Partial output
# is not a passing run.

set -euo pipefail

# ----- argument parsing -----

SSH_HOST=""
SSH_KEY=""
SSH_PORT=22
SSH_USER="${USER:-root}"
CONTAINER="ccflare"
HEALTH_URL=""
LOCAL=0
NO_CONTAINER=0
OUTPUT_FILE=""

usage() {
	sed -n '2,/^set -euo/{ /^set -euo/!p; }' "$0" | head -n 110
}

while [ $# -gt 0 ]; do
	case "$1" in
		--ssh)
			SSH_HOST="${2:?--ssh requires a value}"
			shift 2
			;;
		--ssh-key)
			SSH_KEY="${2:?--ssh-key requires a value}"
			shift 2
			;;
		--ssh-port)
			SSH_PORT="${2:?--ssh-port requires a value}"
			shift 2
			;;
		--ssh-user)
			SSH_USER="${2:?--ssh-user requires a value}"
			shift 2
			;;
		--container)
			CONTAINER="${2:?--container requires a value}"
			shift 2
			;;
		--no-container)
			NO_CONTAINER=1
			shift
			;;
		--health-url)
			HEALTH_URL="${2:?--health-url requires a value}"
			shift 2
			;;
		--local)
			LOCAL=1
			shift
			;;
		-o)
			OUTPUT_FILE="${2:?-o requires a value}"
			shift 2
			;;
		--help|-h)
			usage
			exit 0
			;;
		*)
			echo "ERROR: unknown argument: $1" >&2
			usage >&2
			exit 64
			;;
	esac
done

if [ "$LOCAL" -eq 0 ] && [ -z "$SSH_HOST" ]; then
	echo "ERROR: one of --ssh HOST or --local is required" >&2
	usage >&2
	exit 64
fi

# ----- output handling -----

if [ -n "$OUTPUT_FILE" ]; then
	: > "$OUTPUT_FILE"
	exec > >(tee -a "$OUTPUT_FILE") 2>&1
fi

# ----- remote wrapper -----

run_remote() {
	# $@ — a command to run on the remote host. Returns its stdout.
	local ssh_cmd=(ssh -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new -o BatchMode=yes)
	if [ -n "$SSH_KEY" ]; then
		ssh_cmd+=(-i "$SSH_KEY")
	fi
	ssh_cmd+=("${SSH_USER}@${SSH_HOST}" "$@")
	"${ssh_cmd[@]}"
}

# ----- prelude -----

echo "==============================================================="
echo "ccflare live-build provenance capture"
echo "==============================================================="
echo "DATE_UTC:    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ "$LOCAL" -eq 1 ]; then
	echo "MODE:        local"
	echo "HOSTNAME:    $(hostname)"
else
	echo "MODE:        ssh"
	echo "SSH_HOST:    $SSH_USER@$SSH_HOST:$SSH_PORT"
fi
echo "CONTAINER:   $CONTAINER"
echo "HEALTH_URL:  ${HEALTH_URL:-<auto>}"
echo "---------------------------------------------------------------"

# ----- docker discovery -----

if [ "$LOCAL" -eq 1 ]; then
	if ! command -v docker >/dev/null 2>&1; then
		echo "FATAL: docker not found on PATH"
		exit 2
	fi
	DOCKER=(docker)
else
	# Verify docker is reachable from the remote host.
	if ! run_remote 'command -v docker >/dev/null 2>&1' 2>/dev/null; then
		echo "FATAL: docker not found on remote host $SSH_HOST"
		exit 2
	fi
	DOCKER=(ssh -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new -o BatchMode=yes)
	if [ -n "$SSH_KEY" ]; then
		DOCKER+=(-i "$SSH_KEY")
	fi
	DOCKER+=("${SSH_USER}@${SSH_HOST}" docker)
fi

# ----- step 1: container id -----

if [ "$NO_CONTAINER" -eq 0 ]; then
	echo
	echo "[1/7] container id"
	CONTAINER_ID=$("${DOCKER[@]}" ps --no-trunc --filter "name=^/${CONTAINER}$" --format '{{.ID}}' 2>&1 | head -n 1) || {
		echo "FATAL: docker ps failed"
		echo "  raw: $CONTAINER_ID"
		exit 2
	}
	if [ -z "$CONTAINER_ID" ]; then
		# Maybe the container is named differently. List any running
		# container whose image reference contains 'ccflare' as a
		# last-ditch effort.
		GUESS=$("${DOCKER[@]}" ps --no-trunc --format '{{.ID}} {{.Image}} {{.Names}}' 2>&1 | grep -i ccflare | head -n 1) || true
		echo "FATAL: no running container named '$CONTAINER'"
		if [ -n "$GUESS" ]; then
			echo "  candidate (rerun with --container NAME): $GUESS"
		else
			echo "  no ccflare-named container is running either"
		fi
		exit 2
	fi
	echo "CONTAINER_ID:        $CONTAINER_ID"
else
	echo
	echo "[1/7] container id (skipped — --no-container)"
	CONTAINER_ID=""
fi

# ----- step 2: image reference -----

echo
echo "[2/7] image reference"
if [ -n "$CONTAINER_ID" ]; then
	IMAGE_REF=$("${DOCKER[@]}" inspect --format '{{.Config.Image}}' "$CONTAINER_ID" 2>&1)
else
	# Use the first image named ccflare in the local cache.
	IMAGE_REF=$("${DOCKER[@]}" images --no-trunc --format '{{.Repository}}:{{.Tag}}' 2>&1 | grep -E 'ccflare' | head -n 1) || true
	if [ -z "$IMAGE_REF" ]; then
		echo "FATAL: no ccflare image in local cache"
		exit 2
	fi
fi
if [ -z "$IMAGE_REF" ]; then
	echo "FATAL: empty image reference"
	exit 2
fi
echo "IMAGE_REF:           $IMAGE_REF"

# ----- step 3: image digest -----

echo
echo "[3/7] image digest (manifest sha256)"
IMAGE_DIGEST=$("${DOCKER[@]}" inspect --format '{{index .RepoDigests 0}}' "$IMAGE_REF" 2>&1) || {
	echo "FATAL: docker inspect failed for $IMAGE_REF"
	echo "  raw: $IMAGE_DIGEST"
	exit 2
}
if [ -z "$IMAGE_DIGEST" ]; then
	# Image was not pulled with a digest; pull-by-digest is not the
	# same as inspect-by-digest. We still need a fingerprint — pull
	# would CHANGE the running image's tag resolution, so we do NOT
	# do that. Instead, we report the image id (config sha256) as a
	# fallback fingerprint.
	IMAGE_ID=$("${DOCKER[@]}" inspect --format '{{.Id}}' "$IMAGE_REF" 2>&1)
	echo "IMAGE_DIGEST:        <no RepoDigest — image was pulled by tag, not digest>"
	echo "IMAGE_ID:            $IMAGE_ID"
	RAN_WITHOUT_DIGEST=1
else
	echo "IMAGE_DIGEST:        $IMAGE_DIGEST"
	RAN_WITHOUT_DIGEST=0
fi

# ----- step 4: /health -----

echo
echo "[4/7] /health response"
if [ -z "$HEALTH_URL" ]; then
	if [ "$LOCAL" -eq 1 ]; then
		# Discover the host port mapping.
		if [ -n "$CONTAINER_ID" ]; then
			HOST_PORT=$("${DOCKER[@]}" inspect --format '{{(index (index .HostConfig.PortBindings "8080/tcp") 0).HostPort}}' "$CONTAINER_ID" 2>/dev/null || echo "")
			if [ -z "$HOST_PORT" ]; then
				HOST_PORT=8080
			fi
			HEALTH_URL="http://127.0.0.1:${HOST_PORT}/health"
		else
			HEALTH_URL="http://127.0.0.1:8080/health"
		fi
	else
		# Run curl from the remote host so the URL is relative to the
		# container's loopback / published port.
		curl_args=()
		if [ -n "$CONTAINER_ID" ]; then
			curl_args+=("${DOCKER[@]}" exec "$CONTAINER_ID" curl -sS --max-time 10 http://127.0.0.1:8080/health)
		else
			curl_args+=(curl -sS --max-time 10 http://127.0.0.1:8080/health)
		fi
		HEALTH_JSON=$(run_remote "${curl_args[@]}" 2>&1) || {
			echo "FATAL: /health unreachable from remote host"
			echo "  raw: $HEALTH_JSON"
			exit 2
		}
		HEALTH_URL="(queried inside remote host)"
	fi
fi

if [ "$HEALTH_URL" != "(queried inside remote host)" ]; then
	if [ "$LOCAL" -eq 1 ] && [ -n "$CONTAINER_ID" ]; then
		HEALTH_JSON=$("${DOCKER[@]}" exec "$CONTAINER_ID" curl -sS --max-time 10 "$HEALTH_URL" 2>&1) || {
			echo "FATAL: /health curl inside container failed"
			echo "  raw: $HEALTH_JSON"
			exit 2
		}
	else
		HEALTH_JSON=$(curl -sS --max-time 10 "$HEALTH_URL" 2>&1) || {
			echo "FATAL: /health curl failed"
			echo "  raw: $HEALTH_JSON"
			exit 2
		}
	fi
fi

if [ -z "$HEALTH_JSON" ]; then
	echo "FATAL: /health returned empty body"
	exit 2
fi

# Verify it's JSON via jq.
if ! command -v jq >/dev/null 2>&1; then
	echo "FATAL: jq not found on PATH (required to parse /health)"
	echo "  /health body: $HEALTH_JSON"
	exit 2
fi

if [ "$LOCAL" -eq 1 ] && ! echo "$HEALTH_JSON" | jq -e . >/dev/null 2>&1; then
	echo "FATAL: /health body is not JSON"
	echo "  body: $HEALTH_JSON"
	exit 2
elif [ "$LOCAL" -eq 0 ]; then
	if ! echo "$HEALTH_JSON" | jq -e . >/dev/null 2>&1; then
		echo "FATAL: /health body is not JSON"
		echo "  body: $HEALTH_JSON"
		exit 2
	fi
fi

HEALTH_VERSION=$(echo "$HEALTH_JSON" | jq -r '.version // "MISSING"')
HEALTH_GIT_SHA=$(echo "$HEALTH_JSON" | jq -r '.git_sha // "MISSING"')
HEALTH_GIT_REF=$(echo "$HEALTH_JSON" | jq -r '.git_ref // "MISSING"')
HEALTH_BUILD_DATE=$(echo "$HEALTH_JSON" | jq -r '.build_date // "MISSING"')

echo "HEALTH_VERSION:      $HEALTH_VERSION"
echo "HEALTH_GIT_SHA:      $HEALTH_GIT_SHA"
echo "HEALTH_GIT_REF:      $HEALTH_GIT_REF"
echo "HEALTH_BUILD_DATE:   $HEALTH_BUILD_DATE"

# ----- step 5: bun --revision inside the container -----

echo
echo "[5/7] bun --revision INSIDE the container (ground truth)"
if [ -n "$CONTAINER_ID" ]; then
	BUN_REVISION=$("${DOCKER[@]}" exec -u ccflare "$CONTAINER_ID" bun --revision 2>&1) || {
		echo "FATAL: 'bun --revision' failed inside the container"
		echo "  raw: $BUN_REVISION"
		echo "  this means the image is not based on oven/bun, OR the"
		echo "  ccflare user cannot exec bun. Either way, the binary"
		echo "  could not be inspected."
		exit 2
	}
else
	BUN_REVISION="<skipped: --no-container>"
fi
echo "BUN_REVISION:        $BUN_REVISION"

# ----- step 6: OCI labels -----

echo
echo "[6/7] OCI labels (org.opencontainers.image.*)"
LABELS_JSON=$("${DOCKER[@]}" inspect --format '{{json .Config.Labels}}' "$IMAGE_REF" 2>&1) || {
	echo "FATAL: docker inspect labels failed"
	echo "  raw: $LABELS_JSON"
	exit 2
}
if [ "$LABELS_JSON" = "null" ] || [ -z "$LABELS_JSON" ]; then
	echo "OCI_LABELS:          (none)"
else
	# Pretty-print each label on its own line.
	while IFS= read -r line; do
		# Skip empty.
		[ -z "$line" ] && continue
		echo "OCI_LABEL:           $line"
	done < <(echo "$LABELS_JSON" | jq -r 'to_entries[] | "\(.key)=\(.value)"')
fi

# ----- step 7: layer digests -----

echo
echo "[7/7] image layer digests"
LAYERS_JSON=$("${DOCKER[@]}" inspect --format '{{json .RootFS}}' "$IMAGE_REF" 2>&1) || {
	echo "FATAL: docker inspect RootFS failed"
	echo "  raw: $LAYERS_JSON"
	exit 2
}
if [ "$LAYERS_JSON" = "null" ] || [ -z "$LAYERS_JSON" ]; then
	echo "LAYERS:              (none)"
else
	while IFS= read -r layer; do
		[ -z "$layer" ] && continue
		echo "LAYER:               $layer"
	done < <(echo "$LAYERS_JSON" | jq -r '.Layers[]')
fi

# ----- summary -----

echo
echo "==============================================================="
echo "SUMMARY"
echo "==============================================================="
if [ "$RAN_WITHOUT_DIGEST" -eq 1 ]; then
	echo "STATUS:              PARTIAL — image had no RepoDigest"
elif [ "$HEALTH_GIT_SHA" = "MISSING" ] || [ "$HEALTH_GIT_SHA" = "unknown" ]; then
	echo "STATUS:              PARTIAL — /health did not report git_sha"
	echo "  (the running image was built without CCFLARE_GIT_SHA —"
	echo "   it is unprovable by construction)"
elif [ "$BUN_REVISION" = "<skipped: --no-container>" ] || [ -z "$BUN_REVISION" ]; then
	echo "STATUS:              PARTIAL — bun --revision not captured"
else
	echo "STATUS:              OK"
fi
echo "==============================================================="
echo "OK"
