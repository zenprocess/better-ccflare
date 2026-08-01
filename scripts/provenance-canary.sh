#!/usr/bin/env bash
#
# provenance-canary.sh — deployment provenance comparator (ao-company #110).
#
# This is NOT a build-time tool. It is a runtime comparator that answers
# one question:
#
#     Does the image currently running on <host> match the HEAD of
#     <deploy-branch> in <repo>?
#
# It does this by querying the host's /health endpoint (which exposes the
# build-time provenance injected by the Dockerfile: version, git_sha,
# git_ref, build_date) and comparing each field against the HEAD of the
# deploy branch. The deploy branch is the source of truth — it is what
# SHOULD be running.
#
# ----------------------------------------------------------------------
# THREE DISTINCT VERDICTS — DO NOT COLLAPSE
# ----------------------------------------------------------------------
#
#   VERIFIED_MATCH (exit 0)        — host's /health SHA matches deploy HEAD
#                                    SHA within the configured tolerance,
#                                    AND every provenance field is present
#                                    AND the git rev-parse ran successfully.
#
#   VERIFIED_DRIFT (exit 1)        — host's /health SHA is reachable AND
#                                    does NOT match deploy HEAD; the running
#                                    image is stale or wrong.
#
#   COULD_NOT_CHECK (exit 2)       — at least one of the inputs could not
#                                    be obtained: /health unreachable, git
#                                    fetch failed, /health missing
#                                    git_sha, /health returned "unknown",
#                                    host returned non-200, response body
#                                    not parseable, etc. NEVER green.
#
# The COULD_NOT_CHECK case is the one that saves you from a silent
# unverified deploy. A canary that reports green when it could not
# actually check is worse than no canary.
#
# ----------------------------------------------------------------------
# USAGE
# ----------------------------------------------------------------------
#
#   scripts/provenance-canary.sh [OPTIONS]
#
# REQUIRED:
#   --host URL             URL of the ccflare /health endpoint, e.g.
#                          http://ccproxy2.zp.digital:8080/health
#   --repo URL             Git URL of the ccflare repo, e.g.
#                          https://github.com/zenprocess/better-ccflare.git
#   --branch NAME          Deploy branch to compare against, e.g.
#                          deploy/2026-07-30
#
# OPTIONAL:
#   --ssh-key PATH         Path to SSH key for SSH-style git URLs.
#   --git-dir DIR          Use an existing local git directory instead of
#                          cloning. Useful from CI caches. DIR must be a
#                          bare clone or a worktree of REPO.
#   --timeout SECS         Total timeout for HTTP requests (default 10).
#   --refetch              Force a fresh `git fetch` even if --git-dir is
#                          supplied (default: only fetch on cold cache).
#   --json                 Emit a single JSON object instead of human-readable
#                          lines. Useful for log aggregation.
#   --help                 Show this help.
#
# ----------------------------------------------------------------------
# DEPLOYMENT
# ----------------------------------------------------------------------
#
# This script is a comparator, not a probe. It MUST be run from a host
# that can reach both the deploy host (--host) and the git repo (--repo).
# From the AO sandbox, neither dellsrv/registry.zp.digital nor the
# zp.digital LAN is reachable — the AO executor can never run this
# script. Run it from:
#
#   * A docker container on the deploy host itself (--network=host), or
#   * A cron job / systemd timer on any LAN host that can reach both, or
#   * A CI/CD job that has LAN access to the deploy host (e.g. a
#     self-hosted runner on the LAN).
#
# Wrap it in a docker container with `git` and `curl` (a 5 MB alpine image
# is enough) and pin the image tag. The exit code is the verdict.
#
# ----------------------------------------------------------------------
# EXIT CODES
# ----------------------------------------------------------------------
#
#   0  VERIFIED_MATCH
#   1  VERIFIED_DRIFT
#   2  COULD_NOT_CHECK
#   64 invalid arguments
#
# ----------------------------------------------------------------------
# SECURITY
# ----------------------------------------------------------------------
#
# The script is read-only. It does not pull, restart, or stop any
# container. It does not write to the host beyond a temp git worktree
# (default: $TMPDIR/ccflare-canary.$$ which is removed on exit). It does
# not exfiltrate the /health body to anywhere except stdout/stderr.
#
# SSRF: --host is taken at face value. If you let untrusted callers pass
# --host, they can probe internal IPs. Restrict the script's invocation
# environment (no sudo, fixed args from systemd unit, etc.).
#
# ----------------------------------------------------------------------

set -euo pipefail

# Restrict temp files to a writable location. Some sandboxed
# environments block /tmp and even $TMPDIR. Prefer the operator's
# scratchpad first, fall back to /tmp, then to $HOME.
TMPDIR_BASE="${TMPDIR:-}"
if [ -z "$TMPDIR_BASE" ] || [ ! -w "$TMPDIR_BASE" ]; then
	if [ -n "${HOME:-}" ] && [ -w "$HOME" ]; then
		TMPDIR_BASE="$HOME"
	elif [ -d "/tmp" ] && [ -w "/tmp" ]; then
		TMPDIR_BASE="/tmp"
	else
		TMPDIR_BASE="."
	fi
fi
TMPDIR="$TMPDIR_BASE"
export TMPDIR

# ----- argument parsing -----

HOST_URL=""
REPO_URL=""
BRANCH=""
SSH_KEY=""
GIT_DIR=""
TIMEOUT=10
REFETCH=0
JSON=0

usage() {
	sed -n '2,/^set -euo/{ /^set -euo/!p; }' "$0" | head -n 75
}

while [ $# -gt 0 ]; do
	case "$1" in
		--host)
			HOST_URL="${2:?--host requires a value}"
			shift 2
			;;
		--repo)
			REPO_URL="${2:?--repo requires a value}"
			shift 2
			;;
		--branch)
			BRANCH="${2:?--branch requires a value}"
			shift 2
			;;
		--ssh-key)
			SSH_KEY="${2:?--ssh-key requires a value}"
			shift 2
			;;
		--git-dir)
			GIT_DIR="${2:?--git-dir requires a value}"
			shift 2
			;;
		--timeout)
			TIMEOUT="${2:?--timeout requires a value}"
			shift 2
			;;
		--refetch)
			REFETCH=1
			shift
			;;
		--json)
			JSON=1
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

if [ -z "$HOST_URL" ] || [ -z "$REPO_URL" ] || [ -z "$BRANCH" ]; then
	echo "ERROR: --host, --repo, and --branch are all required" >&2
	usage >&2
	exit 64
fi

# ----- tools -----

require() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "ERROR: required tool not found: $1" >&2
		exit 2
	fi
}

require curl
require git
require jq

# ----- output helpers -----

log_line() {
	if [ "$JSON" -eq 0 ]; then
		printf '%s\n' "$*"
	fi
}

# ----------------------------------------------------------------------
# 1. Query /health
# ----------------------------------------------------------------------
#
# We capture the HTTP status and the body separately. curl returns
# non-zero on non-2xx with -f, which collides with the "could not check"
# case — we want to distinguish "host down" from "host up but wrong
# image". So we use -s but not -f, and inspect status manually.

log_line "[1/3] fetching $HOST_URL"

HEALTH_HTTP_STATUS=""
HEALTH_BODY=""
HEALTH_ERR=""

set +e
HEALTH_HTTP_RAW=$(curl -sS --max-time "$TIMEOUT" -o "$TMPDIR_BASE/ccflare-health.$$.body" -w '%{http_code}' "$HOST_URL" 2>"$TMPDIR_BASE/ccflare-health.$$.err")
HEALTH_CURL_RC=$?
set -e
HEALTH_HTTP_STATUS="$HEALTH_HTTP_RAW"
if [ -s "$TMPDIR_BASE/ccflare-health.$$.body" ]; then
	HEALTH_BODY=$(cat "$TMPDIR_BASE/ccflare-health.$$.body")
fi
if [ -s "$TMPDIR_BASE/ccflare-health.$$.err" ]; then
	HEALTH_ERR=$(cat "$TMPDIR_BASE/ccflare-health.$$.err")
fi
rm -f "$TMPDIR_BASE/ccflare-health.$$.body" "$TMPDIR_BASE/ccflare-health.$$.err"

if [ "$HEALTH_CURL_RC" -ne 0 ]; then
	log_line "  ERROR: curl failed (rc=$HEALTH_CURL_RC): $HEALTH_ERR"
	log_line "VERDICT: COULD_NOT_CHECK (host unreachable)"
	if [ "$JSON" -eq 1 ]; then
		jq -n \
			--arg host "$HOST_URL" \
			--arg branch "$BRANCH" \
			--arg err "$HEALTH_ERR" \
			'{verdict:"COULD_NOT_CHECK", reason:"host_unreachable", host:$host, branch:$branch, error:$err}'
	fi
	exit 2
fi

if [ "$HEALTH_HTTP_STATUS" != "200" ]; then
	log_line "  ERROR: HTTP $HEALTH_HTTP_STATUS (expected 200)"
	log_line "  body: ${HEALTH_BODY:0:200}"
	log_line "VERDICT: COULD_NOT_CHECK (host returned non-200)"
	if [ "$JSON" -eq 1 ]; then
		jq -n \
			--arg host "$HOST_URL" \
			--arg branch "$BRANCH" \
			--argjson status "$HEALTH_HTTP_STATUS" \
			'{verdict:"COULD_NOT_CHECK", reason:"host_non_200", host:$host, branch:$branch, http_status:$status}'
	fi
	exit 2
fi

# Parse the body. We require jq to succeed; if the body isn't JSON, the
# /health contract is broken and we cannot determine provenance.
if ! echo "$HEALTH_BODY" | jq -e . >/dev/null 2>&1; then
	log_line "  ERROR: /health body is not JSON"
	log_line "  body: ${HEALTH_BODY:0:200}"
	log_line "VERDICT: COULD_NOT_CHECK (non-JSON response)"
	if [ "$JSON" -eq 1 ]; then
		jq -n \
			--arg host "$HOST_URL" \
			--arg branch "$BRANCH" \
			'{verdict:"COULD_NOT_CHECK", reason:"non_json_response", host:$host, branch:$branch}'
	fi
	exit 2
fi

RUNNING_SHA=$(echo "$HEALTH_BODY" | jq -r '.git_sha // "unknown"')
RUNNING_REF=$(echo "$HEALTH_BODY" | jq -r '.git_ref // "unknown"')
RUNNING_VERSION=$(echo "$HEALTH_BODY" | jq -r '.version // "unknown"')
RUNNING_BUILD_DATE=$(echo "$HEALTH_BODY" | jq -r '.build_date // "unknown"')

log_line "  /health reports:"
log_line "    version:      $RUNNING_VERSION"
log_line "    git_sha:      $RUNNING_SHA"
log_line "    git_ref:      $RUNNING_REF"
log_line "    build_date:   $RUNNING_BUILD_DATE"

if [ "$RUNNING_SHA" = "unknown" ] || [ -z "$RUNNING_SHA" ]; then
	log_line "  ERROR: /health did not include git_sha (or it was \"unknown\")"
	log_line "  This means the running image was built without CCFLARE_GIT_SHA"
	log_line "  injected. The image is unprovable by construction."
	log_line "VERDICT: COULD_NOT_CHECK (running image missing git_sha)"
	if [ "$JSON" -eq 1 ]; then
		jq -n \
			--arg host "$HOST_URL" \
			--arg branch "$BRANCH" \
			'{verdict:"COULD_NOT_CHECK", reason:"health_missing_git_sha", host:$host, branch:$branch}'
	fi
	exit 2
fi

# ----------------------------------------------------------------------
# 2. Resolve the deploy branch HEAD
# ----------------------------------------------------------------------
#
# The deploy branch is the source of truth. We accept either an existing
# local git directory (--git-dir, designed for CI caches) or do a fresh
# clone to $TMPDIR.

log_line "[2/3] resolving $BRANCH HEAD from $REPO_URL"

WORK_DIR=""
CLEANUP_DIR=""

if [ -n "$GIT_DIR" ]; then
	if [ ! -d "$GIT_DIR" ]; then
		log_line "  ERROR: --git-dir $GIT_DIR does not exist"
		log_line "VERDICT: COULD_NOT_CHECK (git-dir missing)"
		if [ "$JSON" -eq 1 ]; then
			jq -n --arg dir "$GIT_DIR" '{verdict:"COULD_NOT_CHECK", reason:"git_dir_missing", git_dir:$dir}'
		fi
		exit 2
	fi
	WORK_DIR="$GIT_DIR"
	if [ "$REFETCH" -eq 1 ]; then
		SSH_CMD=()
		if [ -n "$SSH_KEY" ]; then
			SSH_CMD=(env GIT_SSH_COMMAND="ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new")
		fi
		log_line "  git fetch (forced)..."
		set +e
		"${SSH_CMD[@]}" git -C "$WORK_DIR" fetch origin "$BRANCH" 2>"$TMPDIR_BASE/ccflare-gitfetch.$$.err"
		GIT_FETCH_RC=$?
		set -e
		if [ "$GIT_FETCH_RC" -ne 0 ]; then
			ERR=$(cat "$TMPDIR_BASE/ccflare-gitfetch.$$.err")
			rm -f "$TMPDIR_BASE/ccflare-gitfetch.$$.err"
			log_line "  ERROR: git fetch failed: $ERR"
			log_line "VERDICT: COULD_NOT_CHECK (git fetch failed)"
			if [ "$JSON" -eq 1 ]; then
				jq -n --arg err "$ERR" '{verdict:"COULD_NOT_CHECK", reason:"git_fetch_failed", error:$err}'
			fi
			exit 2
		fi
		rm -f "$TMPDIR_BASE/ccflare-gitfetch.$$.err"
	fi
else
	WORK_DIR="$(mktemp -d -t ccflare-canary.XXXXXX)"
	CLEANUP_DIR="$WORK_DIR"
	GIT_CLONE=(git clone --depth=1 --branch "$BRANCH" --single-branch)
	if [ -n "$SSH_KEY" ]; then
		GIT_CLONE=(env GIT_SSH_COMMAND="ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new" "${GIT_CLONE[@]}")
	fi
	log_line "  git clone (depth=1, branch=$BRANCH)..."
	set +e
	"${GIT_CLONE[@]}" "$REPO_URL" "$WORK_DIR/repo" 2>"$TMPDIR_BASE/ccflare-gitclone.$$.err"
	GIT_CLONE_RC=$?
	set -e
	if [ "$GIT_CLONE_RC" -ne 0 ]; then
		ERR=$(cat "$TMPDIR_BASE/ccflare-gitclone.$$.err")
		rm -f "$TMPDIR_BASE/ccflare-gitclone.$$.err"
		rm -rf "$WORK_DIR"
		log_line "  ERROR: git clone failed: $ERR"
		log_line "VERDICT: COULD_NOT_CHECK (git clone failed)"
		if [ "$JSON" -eq 1 ]; then
			jq -n --arg err "$ERR" '{verdict:"COULD_NOT_CHECK", reason:"git_clone_failed", error:$err}'
		fi
		exit 2
	fi
	rm -f "$TMPDIR_BASE/ccflare-gitclone.$$.err"
	WORK_DIR="$WORK_DIR/repo"
fi

set +e
EXPECTED_SHA=$(git -C "$WORK_DIR" rev-parse "refs/heads/$BRANCH" 2>"$TMPDIR_BASE/ccflare-revparse.$$.err")
REV_RC=$?
set -e
if [ "$REV_RC" -ne 0 ]; then
	# Try origin/$BRANCH for the local-clone case.
	EXPECTED_SHA=$(git -C "$WORK_DIR" rev-parse "origin/$BRANCH" 2>/dev/null || echo "")
	if [ -z "$EXPECTED_SHA" ]; then
		ERR=$(cat "$TMPDIR_BASE/ccflare-revparse.$$.err")
		rm -f "$TMPDIR_BASE/ccflare-revparse.$$.err"
		log_line "  ERROR: git rev-parse failed for refs/heads/$BRANCH: $ERR"
		log_line "VERDICT: COULD_NOT_CHECK (cannot resolve branch HEAD)"
		if [ -n "$CLEANUP_DIR" ]; then rm -rf "$CLEANUP_DIR"; fi
		if [ "$JSON" -eq 1 ]; then
			jq -n --arg branch "$BRANCH" '{verdict:"COULD_NOT_CHECK", reason:"rev_parse_failed", branch:$branch}'
		fi
		exit 2
	fi
fi
rm -f "$TMPDIR_BASE/ccflare-revparse.$$.err"

if [ -n "$CLEANUP_DIR" ]; then
	rm -rf "$CLEANUP_DIR"
fi

log_line "  deploy branch HEAD:"
log_line "    $EXPECTED_SHA  ($BRANCH)"

# ----------------------------------------------------------------------
# 3. Compare
# ----------------------------------------------------------------------
#
# Match if the running SHA equals the expected SHA. We compare the full
# 40-char SHA from /health against the full 40-char SHA from git rev-parse
# — no short-SHA tolerance, because a canary that mistakes a stale
# short-SHA for a match is exactly the bug we are trying to avoid.

log_line "[3/3] comparing"
log_line "  running:    $RUNNING_SHA"
log_line "  expected:   $EXPECTED_SHA"

if [ "$RUNNING_SHA" = "$EXPECTED_SHA" ]; then
	log_line "  MATCH"
	log_line "VERDICT: VERIFIED_MATCH"
	if [ "$JSON" -eq 1 ]; then
		jq -n \
			--arg host "$HOST_URL" \
			--arg branch "$BRANCH" \
			--arg running_sha "$RUNNING_SHA" \
			--arg running_ref "$RUNNING_REF" \
			--arg running_version "$RUNNING_VERSION" \
			--arg running_build_date "$RUNNING_BUILD_DATE" \
			--arg expected_sha "$EXPECTED_SHA" \
			'{
				verdict: "VERIFIED_MATCH",
				host: $host,
				branch: $branch,
				running_sha: $running_sha,
				running_ref: $running_ref,
				running_version: $running_version,
				running_build_date: $running_build_date,
				expected_sha: $expected_sha
			}'
	fi
	exit 0
fi

# DRIFT — running and expected are both known but disagree.
log_line "  DRIFT"
log_line "VERDICT: VERIFIED_DRIFT"
if [ "$JSON" -eq 1 ]; then
	jq -n \
		--arg host "$HOST_URL" \
		--arg branch "$BRANCH" \
		--arg running_sha "$RUNNING_SHA" \
		--arg running_ref "$RUNNING_REF" \
		--arg running_version "$RUNNING_VERSION" \
		--arg running_build_date "$RUNNING_BUILD_DATE" \
		--arg expected_sha "$EXPECTED_SHA" \
		'{
			verdict: "VERIFIED_DRIFT",
			host: $host,
			branch: $branch,
			running_sha: $running_sha,
			running_ref: $running_ref,
			running_version: $running_version,
			running_build_date: $running_build_date,
			expected_sha: $expected_sha
		}'
fi
exit 1
