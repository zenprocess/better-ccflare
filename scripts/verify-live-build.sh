#!/usr/bin/env bash
#
# verify-live-build.sh — read-only provenance capture for a live ccflare
# host.
#
# THIS IS THE PRIMARY PROVENANCE DELIVERABLE. The AO executor cannot reach
# ccproxy2 / ccmax / dellsrv from its sandbox (DNS for *.zp.digital is
# NXDOMAIN and the egress allowlist is closed by design). This script is
# designed to be run by an operator who CAN reach the deploy host, against
# a live production container, with no debugging expected.
#
# It captures, on the running ccflare container:
#   1. The container id and image reference.
#   2. The image's manifest digest (RepoDigest sha256:...; falls back to
#      the config digest sha256:... if the image was pulled by tag).
#   3. The /health response — including the build-time provenance fields
#      added in #109 (version, git_sha, git_ref, build_date).
#   4. The Bun runtime revision from inside the container (NOT the OCI
#      label — labels lie, binaries do not). The compiled ccflare image
#      does NOT ship a `bun` binary, so we read the build-time snapshot
#      at /etc/ccflare-bun-revision and, when that is missing, fall back
#      to `strings /app/ccflare-server | grep bun-node-<sha>`. We mark
#      the method used so the operator can see exactly which signal came
#      from where.
#   5. The full set of OCI labels (org.opencontainers.image.*).
#   6. The image's layer digests (so the operator can independently match
#      against a registry they control).
#
# Each captured value is printed on its own labeled line in the form
# `KEY: value`. The script also writes a machine-readable JSON summary
# file (default: ./verify-live-build.summary.json). Exit code carries the
# verdict.
#
# Three terminal states are DISTINGUISHED, never collapsed:
#
#   VERIFIED_MATCH       (exit 0)
#       All required captures succeeded, AND every cross-corroboration
#       check between the captured values agrees:
#         - /health.git_sha  == OCI org.opencontainers.image.revision
#         - /health.git_ref  == OCI org.opencontainers.image.version
#         - /health.build_date == OCI org.opencontainers.image.created
#         - bun revision     == OCI org.opencontainers.image.base.revision
#
#   VERIFIED_DRIFT       (exit 1)
#       Captures all succeeded AND at least one cross-corroboration
#       check DISAGREED. The running image is stale, mis-built, or has
#       been re-tagged. The exact disagreement is recorded.
#
#   COULD_NOT_DETERMINE  (exit 2)
#       At least one REQUIRED capture could not be obtained: container
#       not found, runtime missing, /health unreachable, /health body
#       unparseable, required fields missing or "unknown", bun revision
#       not extractable. The script never renders this state as success;
#       that's the failure mode this script exists to prevent.
#
# Why the three states are DISTINCT exits and a labelled summary line:
# the deploy is currently unverifiable because a "could not check"
# path silently reports green. This script refuses to do that — when it
# cannot determine, it says so. When it can determine and the build is
# drifted, it says so. When it can determine and everything agrees, it
# says so.
#
# ----------------------------------------------------------------------
# READ-ONLY PROTOCOL
# ----------------------------------------------------------------------
#
# The script is STRICTLY READ-ONLY against the operator's host and the
# target container. It performs only the following subcommands; each is
# read-only and reversing it requires no cleanup:
#
#   docker|podman ps                  (list running containers)
#   docker|podman inspect             (read-only metadata)
#   docker|podman images              (read-only image list)
#   docker|podman exec ...            (read-only shell command, never
#                                     modifies the container's writable
#                                     layer if the commands stay within
#                                     the documented set)
#   curl                              (GET only; never POST/PUT/DELETE)
#   ssh ...                           (BatchMode=yes; read-only — only
#                                     wraps the same docker commands)
#
# The script NEVER runs: pull, push, tag, build, run, rm, stop, start,
# restart, kill, exec with a non-read-only command, update, network
# connect, login. The script does NOT write to the container's writable
# layer. The only host filesystem writes are to the operator-chosen
# --summary-file path, the optional --output-file path, and $TMPDIR
# scratch files that the script removes on exit.
#
# ----------------------------------------------------------------------
# USAGE
# ----------------------------------------------------------------------
#
#   scripts/verify-live-build.sh [OPTIONS]
#
# Source (one of, required):
#   --ssh HOST                  Run the checks via SSH on HOST. The script
#                               will SSH into HOST and run docker|podman
#                               commands there. This is the recommended
#                               mode for ccmax / ccproxy2.
#   --local                     Run the checks locally. Useful for cctest
#                               or for a curl-from-laptop smoke test.
#
# Target:
#   --container NAME            Container name or id (default: "ccflare").
#                               Matched as an exact ^/NAME$ first; if
#                               that fails we fall back to compose
#                               labels, then to substring matches.
#   --image-ref REF             Skip container discovery and target this
#                               image reference directly (read-only
#                               inspect against the local image cache).
#   --no-container              Do not query a container; just query the
#                               local image cache. Useful for offline
#                               registry audits.
#
# Runtime:
#   --runtime {auto|docker|podman}  (default: auto). Auto tries docker
#                                   first, then podman; on --ssh this
#                                   refers to the REMOTE host's runtime.
#
# Network / health:
#   --health-url URL            URL of /health (default: auto — see the
#                               port-discovery logic in step 4).
#   --health-port PORT          Container-internal port for /health
#                               (default: 8080 — the value exposed by
#                               the canonical Dockerfile's PORT env).
#
# Output:
#   -o FILE                     Mirror the human-readable report to FILE.
#   --summary-file PATH         JSON summary (default:
#                               ./verify-live-build.summary.json). Pass
#                               an empty string to disable.
#
# Misc:
#   --ssh-key PATH              SSH key for --ssh mode.
#   --ssh-port PORT             SSH port (default 22).
#   --ssh-user USER             SSH user (default: current user).
#   --debug                     Dump extra diagnostics on failure (raw
#                               commands + outputs) to stderr.
#   --help                      Show this help.
#
# Exit codes:
#   0  VERIFIED_MATCH
#   1  VERIFIED_DRIFT
#   2  COULD_NOT_DETERMINE
#   64 invalid arguments
#
# ----------------------------------------------------------------------
# ASSUMPTIONS (explicit — correct now or the script will misbehave)
# ----------------------------------------------------------------------
#
# 1. The container is named "ccflare" by default; --container overrides.
#    Compose deployments usually prepend a project name and separator
#    (e.g. "myproject_ccflare_1"). We match those as a substring.
# 2. The container publishes its internal /health on port 8080 unless
#    --health-port says otherwise. We do NOT assume the host port is
#    8080 — we discover it via PortBindings and use 127.0.0.1 if
#    reachable; otherwise we fall back to in-container curl.
# 3. The ccflare image is built from this repo's canonical Dockerfile,
#    which records the embedded Bun revision at
#    /etc/ccflare-bun-revision at build time AND compiles the server to
#    /app/ccflare-server. The compiled server does NOT contain a `bun`
#    binary, so plain `docker exec ... bun --revision` will fail in any
#    build that succeeded (this is the build-1.0+ shape). We capture
#    the same answer via the recorded file plus, as a last resort,
#    `strings` on the compiled binary.
# 4. The runtime CLI surface (docker|podman) supports the same flags we
#    use: ps, ps --filter, ps --format, inspect --format, images
#    --format, exec. Both modern docker (24+) and podman (4.0+) do.
# 5. The /health endpoint returns HTTP 200 with a JSON body whose keys
#    may include "version", "git_sha", "git_ref", "build_date". Missing
#    keys are surfaced as distinct states, not silently treated as empty
#    strings (PR #109 deliberately reports "unknown" for unset fields,
#    so we distinguish "absent: not_in_response" from "unknown").
# 6. The host runs Linux. macOS / WSL hosts running docker desktop are
#    unusual for an operator running against production; we don't
#    special-case them.
# 7. The script writes only to the operator's chosen -o and summary file
#    paths plus $TMPDIR for captured /health bodies. The container is
#    read-only inspected via `docker exec` and never written to.
# 8. `jq`, `curl`, and `ssh` may all be missing on the operator's host
#    or the remote host. We treat each missing tool as a degraded-mode
#    fact, not a fatal failure, EXCEPT `ssh` in --ssh mode.
#
# ----------------------------------------------------------------------

set -euo pipefail

# ----- temp space -----
TMPDIR_BASE="${TMPDIR:-/tmp}"
if [ ! -d "$TMPDIR_BASE" ] || [ ! -w "$TMPDIR_BASE" ]; then
	TMPDIR_BASE="$HOME"
fi
TMPDIR="$TMPDIR_BASE"
export TMPDIR

# ----- default state -----

SSH_HOST=""
SSH_KEY=""
SSH_PORT=22
SSH_USER="${USER:-root}"
LOCAL=0
NO_CONTAINER=0
CONTAINER="ccflare"
IMAGE_REF_OVERRIDE=""
RUNTIME_CHOICE="auto"
HEALTH_URL=""
HEALTH_PORT=8080
OUTPUT_FILE=""
SUMMARY_FILE="./verify-live-build.summary.json"
DEBUG=0

# Captured values (all initialised to a sentinel distinct from any real value).
RUNTIME=""               # "docker" | "podman"
CONTAINER_ID=""
CONTAINER_NAME=""
CONTAINER_FOUND_VIA=""   # diagnostic: how we identified the container
IMAGE_REF=""
IMAGE_DIGEST=""          # manifest sha256 (may be empty if pulled by tag)
IMAGE_CONFIG_DIGEST=""   # always set if we can inspect the image
OCI_LABELS_JSON=""       # full JSON of image labels
LAYERS_JSON=""           # rootfs layers as JSON array
HEALTH_AVAILABLE=0       # 1 if we got an HTTP 200
HEALTH_HTTP_STATUS=""    # raw status code (e.g. "200", "000")
HEALTH_BODY=""           # raw body (may be empty)
HEALTH_VERSION=""
HEALTH_GIT_SHA=""
HEALTH_GIT_REF=""
HEALTH_BUILD_DATE=""
HEALTH_FIELDS_PRESENT=""
BUN_REVISION=""
BUN_REVISION_METHOD="none"  # "exec" | "file" | "strings" | "none"
JQ_AVAILABLE=0
CURL_AVAILABLE=0
SSH_AVAILABLE=0

# Verdict state.
DRIFT_SIGNALS=""
MISSING_FIELDS=""

usage() {
	sed -n '2,/^set -euo/{ /^set -euo/!p; }' "$0" | head -n 200
}

# ----- option parsing -----

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
		--local)
			LOCAL=1
			shift
			;;
		--container)
			CONTAINER="${2:?--container requires a value}"
			shift 2
			;;
		--image-ref)
			IMAGE_REF_OVERRIDE="${2:?--image-ref requires a value}"
			NO_CONTAINER=1
			shift 2
			;;
		--no-container)
			NO_CONTAINER=1
			shift
			;;
		--runtime)
			RUNTIME_CHOICE="${2:?--runtime requires a value}"
			shift 2
			;;
		--health-url)
			HEALTH_URL="${2:?--health-url requires a value}"
			shift 2
			;;
		--health-port)
			HEALTH_PORT="${2:?--health-port requires a value}"
			shift 2
			;;
		-o)
			OUTPUT_FILE="${2:?-o requires a value}"
			shift 2
			;;
		--summary-file)
			SUMMARY_FILE="${2:?--summary-file requires a value (use '' to disable)}"
			shift 2
			;;
		--debug)
			DEBUG=1
			shift
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

case "$RUNTIME_CHOICE" in
	auto|docker|podman) ;;
	*)
		echo "ERROR: --runtime must be one of: auto, docker, podman" >&2
		exit 64
		;;
esac

# ----- output mirroring -----
#
# We DO NOT use `exec > >(tee ...)` — it fails under sandboxed stdio
# (process substitution is denied in some CI / bats environments).
# Instead we buffer the entire transcript in $OUTPUT_BUFFER and at
# exit we write it to stdout (already captured by the caller) and, if
# the operator asked for it, to $OUTPUT_FILE on disk.
#
# `say` is the only stdout writer — every `echo "..."` in this script
# that targets stdout (i.e. not `>&2`) was converted to `say "..."`.
# Stderr-writes remain `echo "..." >&2` so error messages flush
# immediately.

OUTPUT_BUFFER=""
OUTPUT_FILE_DEST=""
if [ -n "$OUTPUT_FILE" ]; then
	OUTPUT_BUFFER=$(mktemp "${TMPDIR_BASE}/ccflare-vlb-out.XXXXXX" 2>/dev/null || echo "")
	if [ -n "$OUTPUT_BUFFER" ]; then
		: > "$OUTPUT_BUFFER"
	else
		echo "FATAL: cannot create output buffer under $TMPDIR_BASE" >&2
		exit 2
	fi
	OUTPUT_FILE_DEST="$OUTPUT_FILE"
fi

say() {
	if [ -n "$OUTPUT_BUFFER" ]; then
		printf '%s\n' "$*" >> "$OUTPUT_BUFFER"
	else
		printf '%s\n' "$*"
	fi
}

on_exit() {
	local rc=$?
	if [ -n "$OUTPUT_BUFFER" ]; then
		if [ -n "$OUTPUT_FILE_DEST" ] && [ -w "$(dirname "$OUTPUT_FILE_DEST")" ]; then
			cp "$OUTPUT_BUFFER" "$OUTPUT_FILE_DEST" 2>/dev/null || true
		fi
		# Flush the buffer to stdout so anyone tail-following the
		# invocation sees the same transcript.
		cat "$OUTPUT_BUFFER"
		rm -f "$OUTPUT_BUFFER" 2>/dev/null || true
	fi
	return $rc
}
trap on_exit EXIT

# ----- command availability helpers -----

have() { command -v "$1" >/dev/null 2>&1; }

# ----- remote/host wrapper -----

run_remote() {
	local ssh_cmd
	ssh_cmd=(ssh -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new -o BatchMode=yes)
	if [ -n "$SSH_KEY" ]; then
		ssh_cmd+=(-i "$SSH_KEY")
	fi
	ssh_cmd+=("${SSH_USER}@${SSH_HOST}" "$@")
	"${ssh_cmd[@]}"
}

# ----- runtime abstraction -----
#
# Every docker|podman subcommand flows through `rt`. In --local mode
# `rt` = "$RUNTIME <subcmd>". In --ssh mode `rt` = "ssh HOST $RUNTIME
# <subcmd>". A single point of dispatch makes the read-only contract
# auditable.

rt() {
	if [ "$LOCAL" -eq 1 ]; then
		"$RUNTIME" "$@"
	else
		run_remote "$RUNTIME" "$@"
	fi
}

# ----- prelude -----

say "==============================================================="
say "ccflare live-build provenance capture"
say "==============================================================="
say "DATE_UTC:    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ "$LOCAL" -eq 1 ]; then
	say "MODE:        local"
	say "HOSTNAME:    $(hostname 2>/dev/null || echo '<unknown>')"
else
	say "MODE:        ssh"
	say "SSH_HOST:    $SSH_USER@$SSH_HOST:$SSH_PORT"
fi
say "CONTAINER:   $CONTAINER"
say "HEALTH_URL:  ${HEALTH_URL:-<auto>}"
say "---------------------------------------------------------------"

# ----- runtime detection -----

say
say "[setup] detecting container runtime"
case "$RUNTIME_CHOICE" in
	docker|podman)
		RUNTIME="$RUNTIME_CHOICE"
		;;
	auto)
		if [ "$LOCAL" -eq 1 ]; then
			if have docker && docker info >/dev/null 2>&1; then
				RUNTIME="docker"
			elif have podman && podman info >/dev/null 2>&1; then
				RUNTIME="podman"
			fi
		else
			if run_remote 'command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1' 2>/dev/null; then
				RUNTIME="docker"
			elif run_remote 'command -v podman >/dev/null 2>&1 && podman info >/dev/null 2>&1' 2>/dev/null; then
				RUNTIME="podman"
			fi
		fi
		;;
esac

if [ -z "$RUNTIME" ]; then
	if [ "$LOCAL" -eq 1 ]; then
		echo "FATAL: no usable container runtime detected (tried docker, then podman)" >&2
		echo "  hint: install docker or podman, or set --runtime explicitly" >&2
		echo "  hint: if you intended to target a remote host, use --ssh HOST" >&2
	else
		echo "FATAL: no usable container runtime on remote host $SSH_HOST" >&2
		echo "  hint: install docker or podman on $SSH_HOST, or set --runtime explicitly" >&2
	fi
	exit 2
fi

say "RUNTIME:             $RUNTIME"

set +e
RT_VERSION_RAW=$(rt version 2>&1 | head -n 1)
set -e
say "RUNTIME_VERSION:     ${RT_VERSION_RAW:-<unavailable>}"

if have jq; then JQ_AVAILABLE=1; else JQ_AVAILABLE=0; fi
if have curl; then CURL_AVAILABLE=1; else CURL_AVAILABLE=0; fi
if have ssh; then SSH_AVAILABLE=1; else SSH_AVAILABLE=0; fi

if [ "$LOCAL" -eq 0 ] && [ "$SSH_AVAILABLE" -eq 0 ]; then
	echo "FATAL: --ssh requested but ssh is not on PATH on this host" >&2
	exit 2
fi

say "JQ_AVAILABLE:        $JQ_AVAILABLE (local host)"
say "CURL_AVAILABLE:      $CURL_AVAILABLE (local host)"

# ----- step 1: container identification -----

say
say "[1/7] identifying the ccflare container (target: '$CONTAINER')"

resolve_container() {
	local name="$1"

	# Strategy A: exact name match.
	local out
	out=$(rt ps --no-trunc --filter "name=^/${name}\$" --format '{{.ID}} {{.Names}}' 2>/dev/null || true)
	if [ -n "$out" ]; then
		local count
		count=$(printf '%s\n' "$out" | grep -c .)
		if [ "$count" -eq 1 ]; then
			CONTAINER_ID="${out%% *}"
			local rest="${out#* }"
			CONTAINER_NAME="${rest%% *}"
			CONTAINER_NAME="${CONTAINER_NAME#/}"
			CONTAINER_NAME="${CONTAINER_NAME%/}"
			CONTAINER_FOUND_VIA="exact_name=^/${name}\$"
			return 0
		fi
	fi

	# Strategy B: compose service label.
	out=$(rt ps --no-trunc --filter "label=com.docker.compose.service=${name}" --format '{{.ID}} {{.Names}}' 2>/dev/null || true)
	if [ -n "$out" ]; then
		local count
		count=$(printf '%s\n' "$out" | grep -c .)
		if [ "$count" -eq 1 ]; then
			CONTAINER_ID="${out%% *}"
			local rest="${out#* }"
			CONTAINER_NAME="${rest%% *}"
			CONTAINER_NAME="${CONTAINER_NAME#/}"
			CONTAINER_NAME="${CONTAINER_NAME%/}"
			CONTAINER_FOUND_VIA="compose_service=${name}"
			return 0
		fi
	fi

	# Strategy C: substring in any field (last-ditch). Match anywhere
	# "ccflare" appears in the row — names like "ccflare", "ccflare-1",
	# "myproj_ccflare_1", or images like "ccflare:1.0.0" all count. If
	# more than one row matches, we AMBIGUOUS rather than guess — the
	# operator picks with --container NAME.
	out=$(rt ps --no-trunc --format '{{.ID}} {{.Names}} {{.Image}}' 2>/dev/null \
		| grep -i "${name}" || true)
	if [ -n "$out" ]; then
		local count
		count=$(printf '%s\n' "$out" | grep -c .)
		if [ "$count" -eq 1 ]; then
			CONTAINER_ID="${out%% *}"
			local rest="${out#* }"
			CONTAINER_NAME="${rest%% *}"
			CONTAINER_NAME="${CONTAINER_NAME#/}"
			CONTAINER_NAME="${CONTAINER_NAME%/}"
			CONTAINER_FOUND_VIA="substring=${name}"
			return 0
		elif [ "$count" -gt 1 ]; then
			echo "  AMBIGUOUS: $count candidate containers match '${name}':" >&2
			printf '%s\n' "$out" >&2
			return 2
		fi
	fi
	return 1
}

if [ "$NO_CONTAINER" -eq 1 ]; then
	say "  skipped (--no-container or --image-ref)"
elif [ -n "$IMAGE_REF_OVERRIDE" ]; then
	say "  skipped (--image-ref)"
else
	if resolve_container "$CONTAINER"; then
		say "CONTAINER_ID:        $CONTAINER_ID"
		say "CONTAINER_NAME:      $CONTAINER_NAME"
		say "CONTAINER_FOUND_VIA: $CONTAINER_FOUND_VIA"
	else
		say "FATAL: no container matched '${CONTAINER}' on $RUNTIME"
		say "  next: re-run with --container <NAME|id> from the list below"
		say "  --- all running containers (id | name | image) ---"
		# This is a last-ditch brute-force listing — stderr so it
		# surfaces even if the script's main output buffer path is
		# unusual in the operator's environment. The `say`-side
		# listing follows.
		echo "FATAL: no container matched '${CONTAINER}' on $RUNTIME" >&2
		echo "  --- all running containers (id | name | image) ---" >&2
		rt ps --no-trunc --format '{{.ID}} | {{.Names}} | {{.Image}}' >&2 || true
		echo "  --- end list ---" >&2
		# Also surface on the buffered output so it appears in the
		# operator's -o file and JSON summary side-channel.
		echo "FATAL: no container matched '${CONTAINER}' on $RUNTIME" >> "$OUTPUT_BUFFER" 2>/dev/null || true
		echo "  --- all running containers (id | name | image) ---" >> "$OUTPUT_BUFFER" 2>/dev/null || true
		rt ps --no-trunc --format '{{.ID}} | {{.Names}} | {{.Image}}' >> "$OUTPUT_BUFFER" 2>/dev/null || true
		echo "  --- end list ---" >> "$OUTPUT_BUFFER" 2>/dev/null || true

		MISSING_FIELDS="${MISSING_FIELDS:+$MISSING_FIELDS,}container_id"
		NO_CONTAINER=1
		say "  continuing in --no-container degraded mode"
	fi
fi

# ----- step 2: image reference -----

say
say "[2/7] image reference"

if [ -n "$IMAGE_REF_OVERRIDE" ]; then
	IMAGE_REF="$IMAGE_REF_OVERRIDE"
elif [ -n "$CONTAINER_ID" ]; then
	set +e
	IMAGE_REF=$(rt inspect --format '{{.Config.Image}}' "$CONTAINER_ID" 2>&1)
	RT_RC=$?
	set -e
	if [ "$RT_RC" -ne 0 ] || [ -z "$IMAGE_REF" ]; then
		say "FATAL: failed to read .Config.Image for container $CONTAINER_ID"
		say "  raw: $IMAGE_REF"
		MISSING_FIELDS="${MISSING_FIELDS:+$MISSING_FIELDS,}image_ref"
		IMAGE_REF=""
	fi
elif [ "$NO_CONTAINER" -eq 1 ]; then
	set +e
	IMAGE_REF=$(rt images --no-trunc --format '{{.Repository}}:{{.Tag}}' 2>&1 \
		| grep -i -E "^(.+/)?${CONTAINER}([/:]|$)" | head -n 1)
	RT_RC=$?
	set -e
	if [ "$RT_RC" -ne 0 ] || [ -z "$IMAGE_REF" ]; then
		say "  no ccflare-named image in the local cache; that's OK if you're"
		say "  inspecting a registry you control"
		IMAGE_REF=""
	fi
else
	say "FATAL: no container and no --image-ref; cannot determine image"
	MISSING_FIELDS="${MISSING_FIELDS:+$MISSING_FIELDS,}image_ref"
fi

if [ -n "$IMAGE_REF" ]; then
	say "IMAGE_REF:           $IMAGE_REF"
else
	say "IMAGE_REF:           <absent: not_determined>"
fi

# ----- step 3: image digest -----

say
say "[3/7] image digest (manifest sha256)"

if [ -n "$IMAGE_REF" ]; then
	set +e
	IMAGE_DIGEST=$(rt inspect --format '{{index .RepoDigests 0}}' "$IMAGE_REF" 2>&1)
	RT_RC=$?
	set -e
	if [ "$RT_RC" -ne 0 ]; then
		say "FATAL: ${RUNTIME} inspect failed for $IMAGE_REF"
		say "  raw: $IMAGE_DIGEST"
		IMAGE_DIGEST=""
		MISSING_FIELDS="${MISSING_FIELDS:+$MISSING_FIELDS,}image_digest"
	fi

	set +e
	IMAGE_CONFIG_DIGEST=$(rt inspect --format '{{.Id}}' "$IMAGE_REF" 2>&1)
	RT_RC=$?
	set -e
	if [ "$RT_RC" -ne 0 ] || [ -z "$IMAGE_CONFIG_DIGEST" ]; then
		say "FATAL: failed to read image config digest for $IMAGE_REF"
		say "  raw: $IMAGE_CONFIG_DIGEST"
		IMAGE_CONFIG_DIGEST=""
		MISSING_FIELDS="${MISSING_FIELDS:+$MISSING_FIELDS,}image_config_digest"
	fi
else
	IMAGE_DIGEST=""
	IMAGE_CONFIG_DIGEST=""
	MISSING_FIELDS="${MISSING_FIELDS:+$MISSING_FIELDS,}image_digest"
fi

if [ -n "$IMAGE_DIGEST" ]; then
	say "IMAGE_DIGEST:        $IMAGE_DIGEST  (manifest)"
	say "IMAGE_CONFIG_DIGEST: $IMAGE_CONFIG_DIGEST  (image id)"
elif [ -n "$IMAGE_CONFIG_DIGEST" ]; then
	say "IMAGE_DIGEST:        <absent: image_was_pulled_by_tag_no_RepoDigest>"
	say "IMAGE_CONFIG_DIGEST: $IMAGE_CONFIG_DIGEST  (image id)"
else
	say "IMAGE_DIGEST:        <absent: not_determined>"
	say "IMAGE_CONFIG_DIGEST: <absent: not_determined>"
	MISSING_FIELDS="${MISSING_FIELDS:+$MISSING_FIELDS,}image_digest"
fi

# ----- step 4: /health -----

say
say "[4/7] /health response"

fetch_health() {
	local url="$1"
	local body_file="$TMPDIR_BASE/ccflare-vlb-health.$$.body"
	local status_file="$TMPDIR_BASE/ccflare-vlb-health.$$.status"
	local err_file="$TMPDIR_BASE/ccflare-vlb-health.$$.err"
	rm -f "$body_file" "$status_file" "$err_file" 2>/dev/null || true

	local curl_rc=0
	if [ "$CURL_AVAILABLE" -eq 1 ]; then
		set +e
		curl -sS --max-time 10 --connect-timeout 5 \
			-o "$body_file" -w '%{http_code}' "$url" \
			>"$status_file" 2>"$err_file"
		curl_rc=$?
		set -e
	else
		if have wget; then
			set +e
			wget -q -O "$body_file" --timeout=10 "$url" 2>"$err_file"
			curl_rc=$?
			set -e
			if [ "$curl_rc" -eq 0 ]; then
				printf '200\n' >"$status_file"
			else
				printf '000\n' >"$status_file"
			fi
		else
			curl_rc=127
			printf 'curl/wget not available\n' >"$err_file"
		fi
	fi

	HEALTH_HTTP_STATUS=$(cat "$status_file" 2>/dev/null || echo "000")
	if [ -s "$body_file" ]; then
		HEALTH_BODY=$(cat "$body_file")
	else
		HEALTH_BODY=""
	fi
	rm -f "$body_file" "$status_file" "$err_file" 2>/dev/null || true

	if [ "$curl_rc" -ne 0 ]; then
		[ "$DEBUG" -eq 1 ] && echo "  debug: curl_rc=$curl_rc; body=$HEALTH_BODY" >&2
		return 1
	fi
	return 0
}

if [ -z "$HEALTH_URL" ]; then
	if [ "$LOCAL" -eq 1 ]; then
		HEALTH_URL="http://127.0.0.1:${HEALTH_PORT}/health"
	else
		HEALTH_URL="(remote — dispatched via ${RUNTIME} exec)"
	fi
fi

if [ "$LOCAL" -eq 1 ] && [ -n "$CONTAINER_ID" ]; then
	set +e
	HOST_PORT=$(rt inspect --format "{{(index (index .HostConfig.PortBindings \"${HEALTH_PORT}/tcp\") 0).HostPort}}" "$CONTAINER_ID" 2>/dev/null || echo "")
	set -e
	if [ -n "$HOST_PORT" ]; then
		HOST_URL="http://127.0.0.1:${HOST_PORT}/health"
		say "  discovered host port mapping: ${HEALTH_PORT}->${HOST_PORT}"
		fetch_health "$HOST_URL" || true
		if [ "$HEALTH_HTTP_STATUS" != "200" ]; then
			say "  host-side /health did not return 200; falling back to in-container curl"
			HEALTH_BODY=""
			HEALTH_HTTP_STATUS=""
		fi
	fi
	if [ "$HEALTH_HTTP_STATUS" != "200" ]; then
		set +e
		HEALTH_BODY=$(rt exec "$CONTAINER_ID" \
			curl -sS --max-time 10 \
			http://127.0.0.1:${HEALTH_PORT}/health 2>&1)
		HEALTH_RC=$?
		set -e
		if [ "$HEALTH_RC" -eq 0 ] && [ -n "$HEALTH_BODY" ]; then
			HEALTH_HTTP_STATUS="200"
		else
			say "FATAL: in-container /health unreachable"
			say "  raw: $HEALTH_BODY"
			HEALTH_BODY=""
			HEALTH_HTTP_STATUS=""
			MISSING_FIELDS="${MISSING_FIELDS:+$MISSING_FIELDS,}health_body"
		fi
	fi
elif [ "$LOCAL" -eq 1 ]; then
	fetch_health "$HEALTH_URL" || true
else
	set +e
	HEALTH_BODY=$(run_remote "$RUNTIME" exec "$CONTAINER_ID" \
		curl -sS --max-time 10 \
		http://127.0.0.1:${HEALTH_PORT}/health 2>&1)
	HEALTH_RC=$?
	set -e
	if [ "$HEALTH_RC" -eq 0 ] && [ -n "$HEALTH_BODY" ]; then
		HEALTH_HTTP_STATUS="200"
	else
		say "  in-container curl via remote failed; trying remote host curl"
		HEALTH_BODY=""
		HEALTH_HTTP_STATUS=""
		set +e
		REMOTE_HEALTH_URL="$HEALTH_URL"
		if [ "$REMOTE_HEALTH_URL" = "(remote — dispatched via ${RUNTIME} exec)" ]; then
			REMOTE_HEALTH_URL="http://127.0.0.1:${HEALTH_PORT}/health"
		fi
		HEALTH_BODY=$(run_remote curl -sS --max-time 10 \
			-w '\n%{http_code}' "$REMOTE_HEALTH_URL" 2>&1)
		HEALTH_RC=$?
		set -e
		if [ "$HEALTH_RC" -eq 0 ]; then
			last_line=$(printf '%s' "$HEALTH_BODY" | awk 'END{print}')
			case "$last_line" in
				2??|3??|4??|5??)
					HEALTH_HTTP_STATUS="$last_line"
					HEALTH_BODY=$(printf '%s' "$HEALTH_BODY" | sed '$d')
					;;
				*)
					HEALTH_HTTP_STATUS="200"
					;;
			esac
		fi
	fi
fi

say "HEALTH_HTTP_STATUS:  $HEALTH_HTTP_STATUS"
if [ "$HEALTH_HTTP_STATUS" = "200" ] && [ -n "$HEALTH_BODY" ]; then
	HEALTH_AVAILABLE=1
fi

if [ "$HEALTH_AVAILABLE" -eq 1 ]; then
	if [ "$JQ_AVAILABLE" -eq 1 ]; then
		extract_field() {
			local key="$1"
			local body="$2"
			local present
			present=$(printf '%s' "$body" | jq -r "has(\"${key}\")")
			if [ "$present" = "false" ]; then
				printf '%s' '<absent: not_in_response>'
			else
				jq -r --arg k "$key" '.[$k] // "<absent: not_in_response>"' <<<"$body"
			fi
		}
		HEALTH_VERSION=$(extract_field version "$HEALTH_BODY")
		HEALTH_GIT_SHA=$(extract_field git_sha "$HEALTH_BODY")
		HEALTH_GIT_REF=$(extract_field git_ref "$HEALTH_BODY")
		HEALTH_BUILD_DATE=$(extract_field build_date "$HEALTH_BODY")

		HEALTH_FIELDS_PRESENT=$(printf '%s' "$HEALTH_BODY" \
			| jq -r 'keys_unsorted | join(",")' 2>/dev/null || echo "")
	else
		say "  WARNING: jq missing — /health fields cannot be parsed"
		say "  raw body: $HEALTH_BODY"
		HEALTH_VERSION='<absent: jq_unavailable>'
		HEALTH_GIT_SHA='<absent: jq_unavailable>'
		HEALTH_GIT_REF='<absent: jq_unavailable>'
		HEALTH_BUILD_DATE='<absent: jq_unavailable>'
		HEALTH_FIELDS_PRESENT=""
		MISSING_FIELDS="${MISSING_FIELDS:+$MISSING_FIELDS,}health_fields"
	fi
else
	HEALTH_VERSION='<absent: health_unreachable>'
	HEALTH_GIT_SHA='<absent: health_unreachable>'
	HEALTH_GIT_REF='<absent: health_unreachable>'
	HEALTH_BUILD_DATE='<absent: health_unreachable>'
	HEALTH_FIELDS_PRESENT=""
	MISSING_FIELDS="${MISSING_FIELDS:+$MISSING_FIELDS,}health_body"
fi

say "HEALTH_VERSION:      $HEALTH_VERSION"
say "HEALTH_GIT_SHA:      $HEALTH_GIT_SHA"
say "HEALTH_GIT_REF:      $HEALTH_GIT_REF"
say "HEALTH_BUILD_DATE:   $HEALTH_BUILD_DATE"

# ----- step 5: bun revision from inside the container -----

say
say "[5/7] bun revision from binary INSIDE the container"
# Three methods tried in order; first success wins; method recorded.
#
# Method 1: `docker exec ... bun --revision` — works for images that
#           still ship a `bun` binary in PATH (older builds). Newer
#           builds only ship the compiled server, so this is expected
#           to fail.
#
# Method 2: `docker exec ... cat /etc/ccflare-bun-revision` — the
#           canonical Dockerfile records `bun --revision` at build
#           time into /etc/ccflare-bun-revision. This IS the binary's
#           revision, captured when the binary was still in the
#           builder stage.
#
# Method 3: `docker exec ... strings /app/ccflare-server | grep
#           bun-node-<sha>` — extracts the embedded commit prefix
#           from the compiled binary's symbol table. Independent
#           corroboration.
#
# In every case, label= or org.opencontainers.image.* is NOT used.
# Labels lie; binaries do not.

BUN_REVISION=""
BUN_REVISION_METHOD="none"

if [ -n "$CONTAINER_ID" ]; then
	set +e
	OUT=$(rt exec "$CONTAINER_ID" \
		sh -c 'command -v bun >/dev/null 2>&1 && bun --revision' 2>&1)
	RC=$?
	set -e
	if [ "$RC" -eq 0 ] && [ -n "$OUT" ]; then
		BUN_REVISION="$OUT"
		BUN_REVISION_METHOD="exec_bun"
	else
		set +e
		OUT=$(rt exec "$CONTAINER_ID" \
			sh -c 'cat /etc/ccflare-bun-revision 2>/dev/null' 2>&1)
		RC=$?
		set -e
		if [ "$RC" -eq 0 ] && [ -n "$OUT" ]; then
			BUN_REVISION="$OUT"
			BUN_REVISION_METHOD="build_snapshot:/etc/ccflare-bun-revision"
		else
			set +e
			OUT=$(rt exec "$CONTAINER_ID" \
				sh -c 'strings /app/ccflare-server 2>/dev/null \
					| grep -oE "bun-node-[0-9a-f]+" \
					| head -n 1' 2>&1)
			RC=$?
			set -e
			if [ "$RC" -eq 0 ] && [ -n "$OUT" ]; then
				BUN_REVISION="${OUT#bun-node-}"
				BUN_REVISION_METHOD="strings:/app/ccflare-server"
			fi
		fi
	fi
fi

if [ -z "$BUN_REVISION" ] && [ "$NO_CONTAINER" -eq 1 ]; then
	BUN_REVISION='<absent: container_not_inspected>'
	MISSING_FIELDS="${MISSING_FIELDS:+$MISSING_FIELDS,}bun_revision"
fi

if [ -n "$BUN_REVISION" ]; then
	say "BUN_REVISION:        $BUN_REVISION"
else
	say "BUN_REVISION:        <absent: not_extractable>"
	MISSING_FIELDS="${MISSING_FIELDS:+$MISSING_FIELDS,}bun_revision"
fi
say "BUN_REVISION_METHOD: $BUN_REVISION_METHOD"

# ----- step 6: OCI labels -----

say
say "[6/7] OCI labels (org.opencontainers.image.*)"

if [ -n "$IMAGE_REF" ]; then
	set +e
	OCI_LABELS_JSON=$(rt inspect --format '{{json .Config.Labels}}' "$IMAGE_REF" 2>&1)
	RT_RC=$?
	set -e
	if [ "$RT_RC" -ne 0 ]; then
		say "FATAL: ${RUNTIME} inspect labels failed"
		say "  raw: $OCI_LABELS_JSON"
		OCI_LABELS_JSON=""
		MISSING_FIELDS="${MISSING_FIELDS:+$MISSING_FIELDS,}oci_labels"
	else
		if [ "$JQ_AVAILABLE" -eq 1 ] && [ "$OCI_LABELS_JSON" != "null" ] && [ -n "$OCI_LABELS_JSON" ]; then
			while IFS= read -r line; do
				[ -z "$line" ] && continue
				say "OCI_LABEL:           $line"
			done < <(printf '%s' "$OCI_LABELS_JSON" \
				| jq -r 'to_entries[] | select(.key|startswith("org.opencontainers.image.")) | "\(.key)=\(.value)"' 2>/dev/null)
			for key in org.opencontainers.image.revision \
				org.opencontainers.image.version \
				org.opencontainers.image.created \
				org.opencontainers.image.base.revision; do
				val=$(printf '%s' "$OCI_LABELS_JSON" \
					| jq -r --arg k "$key" '.[$k] // "<absent: not_in_labels>"' 2>/dev/null || echo '<absent: jq_failed>')
				say "OCI_CHECK:           $key=$val"
			done
		elif [ "$OCI_LABELS_JSON" = "null" ] || [ -z "$OCI_LABELS_JSON" ]; then
			say "OCI_LABELS:          (none)"
		else
			say "OCI_LABELS_RAW:      $OCI_LABELS_JSON  (jq unavailable; unparsed)"
		fi
	fi
else
	say "OCI_LABELS:          <absent: image_not_inspected>"
	MISSING_FIELDS="${MISSING_FIELDS:+$MISSING_FIELDS,}oci_labels"
fi

# ----- step 7: layer digests -----

say
say "[7/7] image layer digests"

if [ -n "$IMAGE_REF" ] && [ "$JQ_AVAILABLE" -eq 1 ]; then
	set +e
	LAYERS_JSON=$(rt inspect --format '{{json .RootFS}}' "$IMAGE_REF" 2>&1)
	RT_RC=$?
	set -e
	if [ "$RT_RC" -ne 0 ]; then
		say "FATAL: ${RUNTIME} inspect RootFS failed"
		say "  raw: $LAYERS_JSON"
		LAYERS_JSON=""
		MISSING_FIELDS="${MISSING_FIELDS:+$MISSING_FIELDS,}layer_digests"
	elif [ "$LAYERS_JSON" = "null" ] || [ -z "$LAYERS_JSON" ]; then
		say "LAYERS:              (none)"
	else
		LAYER_COUNT=0
		while IFS= read -r layer; do
			[ -z "$layer" ] && continue
			say "LAYER:               $layer"
			LAYER_COUNT=$((LAYER_COUNT + 1))
		done < <(printf '%s' "$LAYERS_JSON" | jq -r '.Layers[]' 2>/dev/null)
		say "LAYER_COUNT:         $LAYER_COUNT"
	fi
elif [ -n "$IMAGE_REF" ]; then
	set +e
	LAYERS_RAW=$(rt inspect --format '{{json .RootFS}}' "$IMAGE_REF" 2>&1)
	RT_RC=$?
	set -e
	if [ "$RT_RC" -eq 0 ]; then
		say "LAYERS_RAW:          $LAYERS_RAW  (jq unavailable; unparsed)"
		LAYERS_JSON="$LAYERS_RAW"
	else
		say "LAYERS:              <absent: inspect_failed>"
		MISSING_FIELDS="${MISSING_FIELDS:+$MISSING_FIELDS,}layer_digests"
	fi
else
	say "LAYERS:              <absent: image_not_inspected>"
	MISSING_FIELDS="${MISSING_FIELDS:+$MISSING_FIELDS,}layer_digests"
fi

# ----------------------------------------------------------------------
# Verdict — cross-corroboration between captures.
# ----------------------------------------------------------------------

say
say "==============================================================="
say "VERDICT"
say "==============================================================="

read_label() {
	local key="$1"
	if [ "$JQ_AVAILABLE" -eq 0 ] || [ -z "$OCI_LABELS_JSON" ] || [ "$OCI_LABELS_JSON" = "null" ]; then
		return 1
	fi
	printf '%s' "$OCI_LABELS_JSON" | jq -r --arg k "$key" '.[$k] // ""' 2>/dev/null
}

is_concrete() {
	local v="$1"
	case "$v" in
		"<absent:"*|"") return 1 ;;
		unknown) return 1 ;;
		*) return 0 ;;
	esac
}

REQUIRED_FOR_MATCH=(
	"$HEALTH_GIT_SHA"
	"$HEALTH_GIT_REF"
	"$HEALTH_BUILD_DATE"
	"$BUN_REVISION"
)
REQUIRED_FIELDS_CONCRETE=0
for v in "${REQUIRED_FOR_MATCH[@]}"; do
	if is_concrete "$v"; then
		REQUIRED_FIELDS_CONCRETE=$((REQUIRED_FIELDS_CONCRETE + 1))
	fi
done

# check_match always returns 0 — the DRIFT_SIGNALS side-effect carries
# the detection. Returning non-zero under `set -e` would terminate the
# script before the verdict engine runs.
check_match() {
	local lhs_label="$1" lhs_value="$2"
	local rhs_label="$3" rhs_value="$4" rhs_field="$5"
	if is_concrete "$lhs_value" && is_concrete "$rhs_value"; then
		if [ "$lhs_value" != "$rhs_value" ]; then
			DRIFT_SIGNALS="${DRIFT_SIGNALS:+${DRIFT_SIGNALS}
}${rhs_field}|lhs=${lhs_label}=${lhs_value}|rhs=${rhs_label}=${rhs_value}"
		fi
	fi
	return 0
}

LABEL_REVISION=$(read_label org.opencontainers.image.revision || true)
LABEL_VERSION=$(read_label org.opencontainers.image.version || true)
LABEL_CREATED=$(read_label org.opencontainers.image.created || true)
LABEL_BASE_REVISION=$(read_label org.opencontainers.image.base.revision || true)

check_match "/health.git_sha" "$HEALTH_GIT_SHA" "oci.revision" "$LABEL_REVISION" "image.revision" || true
check_match "/health.git_ref" "$HEALTH_GIT_REF" "oci.version" "$LABEL_VERSION" "image.version" || true
check_match "/health.build_date" "$HEALTH_BUILD_DATE" "oci.created" "$LABEL_CREATED" "image.created" || true
check_match "/health.version" "$HEALTH_VERSION" "oci.version" "$LABEL_VERSION" "image.version" || true

if is_concrete "$BUN_REVISION" && is_concrete "$LABEL_BASE_REVISION"; then
	if [ "$BUN_REVISION" != "$LABEL_BASE_REVISION" ]; then
		if ! printf '%s' "$LABEL_BASE_REVISION" | grep -q "^${BUN_REVISION}"; then
			DRIFT_SIGNALS="${DRIFT_SIGNALS:+${DRIFT_SIGNALS}
}bun_revision_match|binary=${BUN_REVISION}|oci.base.revision=${LABEL_BASE_REVISION}"
		fi
	fi
fi

LAYER_COUNT_OK=0
if [ "$JQ_AVAILABLE" -eq 1 ] && [ -n "$LAYERS_JSON" ] && [ "$LAYERS_JSON" != "null" ]; then
	if printf '%s' "$LAYERS_JSON" | jq -e '(.Layers // []) | length > 0' >/dev/null 2>&1; then
		LAYER_COUNT_OK=1
	fi
elif [ "$JQ_AVAILABLE" -eq 0 ] && [ -n "$LAYERS_JSON" ] && [ "$LAYERS_JSON" != "null" ]; then
	if printf '%s' "$LAYERS_JSON" | grep -q "sha256"; then
		LAYER_COUNT_OK=1
	fi
fi

VERDICT=""
REASON=""
if [ -n "$MISSING_FIELDS" ]; then
	VERDICT="COULD_NOT_DETERMINE"
	REASON="missing_one_or_more_required_captures"
elif [ -n "$DRIFT_SIGNALS" ]; then
	VERDICT="VERIFIED_DRIFT"
	REASON="captured_values_disagree"
elif [ "$REQUIRED_FIELDS_CONCRETE" -lt 4 ] || [ "$LAYER_COUNT_OK" -eq 0 ] || [ "$HEALTH_AVAILABLE" -ne 1 ]; then
	VERDICT="COULD_NOT_DETERMINE"
	REASON="insufficient_concrete_captures"
else
	VERDICT="VERIFIED_MATCH"
	REASON="all_corroboration_checks_pass"
fi

# ----------------------------------------------------------------------
# Print summary and write the JSON summary file
# ----------------------------------------------------------------------

say
say "STATUS:              $VERDICT"
say "REASON:              $REASON"
if [ -n "$DRIFT_SIGNALS" ]; then
	say "DRIFT_SIGNALS:"
	printf '%s\n' "$DRIFT_SIGNALS" | while IFS='|' read -r f lhs rhs; do
		[ -z "$f" ] && continue
		say "  - $f"
		say "      $lhs"
		say "      $rhs"
	done
fi
if [ -n "$MISSING_FIELDS" ]; then
	say "MISSING_FIELDS:      $MISSING_FIELDS"
fi
say "==============================================================="

# ----- JSON summary writer -----

json_escape() {
	local v="$1"
	v="${v//\\/}"
	v="${v//\"/\\\"}"
	v="${v//[$'\n\r']/}"
	printf '%s' "$v"
}

if [ -n "$SUMMARY_FILE" ]; then
	SUMMARY_FILE_DIR=$(dirname "$SUMMARY_FILE")
	if [ "$SUMMARY_FILE_DIR" != "." ] && [ ! -d "$SUMMARY_FILE_DIR" ]; then
		# Best-effort mkdir — if it fails (e.g. read-only filesystem
		# at the operator's path) we fall back to the temp dir.
		if ! mkdir -p "$SUMMARY_FILE_DIR" 2>/dev/null; then
			SUMMARY_FILE="$TMPDIR_BASE/verify-live-build.summary.json"
		fi
	fi

	SUMMARY_TMP="$SUMMARY_FILE.tmp.$$"
	{
		printf '{\n'
		printf '  "verdict": "%s",\n' "$(json_escape "$VERDICT")"
		printf '  "reason": "%s",\n' "$(json_escape "$REASON")"
		printf '  "captured_at": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		printf '  "runtime": "%s",\n' "$(json_escape "$RUNTIME")"
		printf '  "mode": "%s",\n' "$( [ "$LOCAL" -eq 1 ] && echo local || echo ssh )"
		printf '  "ssh_host": "%s",\n' "$(json_escape "${SSH_USER}@${SSH_HOST}${SSH_PORT:+:${SSH_PORT}}")"
		printf '  "container": {\n'
		printf '    "id": "%s",\n' "$(json_escape "$CONTAINER_ID")"
		printf '    "name": "%s",\n' "$(json_escape "$CONTAINER_NAME")"
		printf '    "found_via": "%s"\n' "$(json_escape "$CONTAINER_FOUND_VIA")"
		printf '  },\n'
		printf '  "image": {\n'
		printf '    "ref": "%s",\n' "$(json_escape "$IMAGE_REF")"
		printf '    "manifest_digest": "%s",\n' "$(json_escape "$IMAGE_DIGEST")"
		printf '    "config_digest": "%s"\n' "$(json_escape "$IMAGE_CONFIG_DIGEST")"
		printf '  },\n'
		printf '  "health": {\n'
		printf '    "available": %s,\n' "$( [ "$HEALTH_AVAILABLE" -eq 1 ] && echo true || echo false )"
		printf '    "http_status": "%s",\n' "$(json_escape "$HEALTH_HTTP_STATUS")"
		printf '    "version": "%s",\n' "$(json_escape "$HEALTH_VERSION")"
		printf '    "git_sha": "%s",\n' "$(json_escape "$HEALTH_GIT_SHA")"
		printf '    "git_ref": "%s",\n' "$(json_escape "$HEALTH_GIT_REF")"
		printf '    "build_date": "%s",\n' "$(json_escape "$HEALTH_BUILD_DATE")"
		printf '    "fields_present": "%s"\n' "$(json_escape "$HEALTH_FIELDS_PRESENT")"
		printf '  },\n'
		printf '  "bun_revision": {\n'
		printf '    "value": "%s",\n' "$(json_escape "$BUN_REVISION")"
		printf '    "method": "%s"\n' "$(json_escape "$BUN_REVISION_METHOD")"
		printf '  },\n'
		printf '  "drift_signals": [\n'
		if [ -n "$DRIFT_SIGNALS" ]; then
			first=1
			printf '%s\n' "$DRIFT_SIGNALS" | while IFS='|' read -r f lhs rhs; do
				[ -z "$f" ] && continue
				sep=","
				if [ "$first" -eq 1 ]; then sep=""; fi
				printf '%s    {"field": "%s", "lhs": "%s", "rhs": "%s"}\n' \
					"$sep" \
					"$(json_escape "$f")" \
					"$(json_escape "$lhs")" \
					"$(json_escape "$rhs")"
				first=0
			done
		fi
		printf '  ],\n'
		printf '  "missing_fields": "%s"\n' "$(json_escape "$MISSING_FIELDS")"
		printf '}\n'
	} >"$SUMMARY_TMP" && mv "$SUMMARY_TMP" "$SUMMARY_FILE"
	say
	say "SUMMARY_FILE:        $SUMMARY_FILE"
fi

# ----- final exit code -----

case "$VERDICT" in
	VERIFIED_MATCH) exit 0 ;;
	VERIFIED_DRIFT) exit 1 ;;
	COULD_NOT_DETERMINE) exit 2 ;;
	*) exit 2 ;;
esac
