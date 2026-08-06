#!/usr/bin/env bash
#
# deploy-provenance-canary.sh — operator primitive for issue #110.
#
# Compares the served git_sha from a ccflare /health endpoint against an
# expected SHA the operator supplies. This is the simpler assertion
# primitive; the more capable comparator (that resolves the expected SHA
# from a git repo itself) lives at scripts/provenance-canary.sh.
#
# ----------------------------------------------------------------------
# USAGE
# ----------------------------------------------------------------------
#
#   scripts/deploy-provenance-canary.sh <base-url> <expected-git-sha>
#   scripts/deploy-provenance-canary.sh --health-file <path> <expected-git-sha>
#
#   base-url        Base URL of the ccflare instance, e.g.
#                   http://localhost:8081 (the /health path is appended).
#   expected-git-sha  Full 40-character SHA the deploy branch HEAD points
#                   to. Obtain with: git rev-parse origin/<branch>
#
#   --health-file PATH
#                   Read the /health response body from a file instead of
#                   fetching it over HTTP. Useful in sandboxes that block
#                   TCP bind, in CI runners, and for replaying a captured
#                   response after the fact. The body is parsed exactly
#                   the same way as the HTTP path; the comparison logic
#                   is identical.
#
# ----------------------------------------------------------------------
# EXIT CODES
# ----------------------------------------------------------------------
#
#   0  MATCH             served git_sha equals expected
#   1  MISMATCH          served git_sha differs from expected
#   2  COULD_NOT_CHECK   no verdict was reached (network failure,
#                        non-200 HTTP, missing/empty/unknown git_sha,
#                        non-JSON body). A canary that reports green
#                        when it could not actually check is worse than
#                        no canary.
#   64 invalid arguments
#
# ----------------------------------------------------------------------
# SECURITY
# ----------------------------------------------------------------------
#
# The script is read-only. It does not write anywhere except a small
# temp file under $TMPDIR (removed on exit). No credentials, no
# hostnames, no repository URLs are embedded — the endpoint is always
# supplied as an argument. SSRF: if untrusted callers can pass <base-url>
# they can probe internal IPs; restrict the caller's environment.
#

set -euo pipefail

# ----- argument parsing -----

usage() {
	sed -n '2,/^set -euo/{ /^set -euo/!p; }' "$0" | head -n 45
}

if [ $# -eq 1 ] && { [ "$1" = "-h" ] || [ "$1" = "--help" ]; }; then
	usage
	exit 0
fi

BASE_URL=""
EXPECTED_SHA=""
HEALTH_FILE=""

# Parse optional flag first.
while [ $# -gt 0 ]; do
	case "$1" in
		--health-file)
			HEALTH_FILE="${2:?--health-file requires a value}"
			shift 2
			;;
		--help|-h)
			usage
			exit 0
			;;
		*)
			break
			;;
	esac
done

if [ -n "$HEALTH_FILE" ]; then
	# File mode: 1 positional (expected SHA). URL is unused.
	if [ $# -ne 1 ]; then
		echo "ERROR: --health-file mode expects 1 argument: <expected-git-sha>" >&2
		usage >&2
		exit 64
	fi
	EXPECTED_SHA="$1"
else
	# HTTP mode: 2 positionals (base URL, expected SHA).
	if [ $# -ne 2 ]; then
		echo "ERROR: expected 2 arguments: <base-url> <expected-git-sha>" >&2
		usage >&2
		exit 64
	fi
	BASE_URL="$1"
	EXPECTED_SHA="$2"
	# Strip trailing slash from base URL so concatenation is predictable.
	BASE_URL="${BASE_URL%/}"
fi

# Require the full 40-char SHA. A canary that mistakes a stale short SHA
# for a match is the exact bug we are catching; we do not allow the
# comparison to be ambiguous by design.
if [ "${#EXPECTED_SHA}" -ne 40 ]; then
	echo "ERROR: expected-git-sha must be 40 characters (got ${#EXPECTED_SHA})" >&2
	echo "  Resolve it with: git rev-parse origin/<branch>" >&2
	exit 64
fi

# Hex characters only — defends against shell-injection-shaped input.
if ! printf '%s' "$EXPECTED_SHA" | grep -qE '^[0-9a-f]{40}$'; then
	echo "ERROR: expected-git-sha must be lowercase hex (got '$EXPECTED_SHA')" >&2
	exit 64
fi

# ----- tools -----

if ! command -v curl >/dev/null 2>&1; then
	echo "ERROR: required tool not found: curl" >&2
	exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
	echo "ERROR: required tool not found: jq" >&2
	exit 2
fi

# ----- temp file location -----
#
# Use $TMPDIR if writable so the script works under sandboxed runtimes
# that block /tmp. Fall back to operator $HOME, then /tmp.

if [ -z "${TMPDIR:-}" ] || [ ! -w "${TMPDIR:-}" ]; then
	if [ -n "${HOME:-}" ] && [ -w "${HOME:-}" ]; then
		TMPDIR_BASE="$HOME"
	elif [ -d "/tmp" ] && [ -w "/tmp" ]; then
		TMPDIR_BASE="/tmp"
	else
		TMPDIR_BASE="."
	fi
else
	TMPDIR_BASE="$TMPDIR"
fi
export TMPDIR="$TMPDIR_BASE"

HEALTH_BODY_FILE="$TMPDIR_BASE/deploy-provenance-health.$$.body"
HEALTH_ERR_FILE="$TMPDIR_BASE/deploy-provenance-health.$$.err"
rm -f "$HEALTH_BODY_FILE" "$HEALTH_ERR_FILE"

cleanup() {
	rm -f "$HEALTH_BODY_FILE" "$HEALTH_ERR_FILE" 2>/dev/null || true
}
trap cleanup EXIT

# ----- 1. fetch /health -----
#
# We capture the HTTP status and the body separately. curl returns
# non-zero on non-2xx with -f, which would collapse "host down" into
# "host up but wrong image". We use -s without -f and inspect status
# manually so each failure mode is distinguishable.
#
# --health-file mode: skip the HTTP path entirely and read the body
# from a file. Useful for sandboxes that block TCP bind and for CI.

HEALTH_URL="${BASE_URL}/health"

if [ -n "$HEALTH_FILE" ]; then
	echo "[1/3] reading health file $HEALTH_FILE"
	if [ ! -f "$HEALTH_FILE" ]; then
		echo "  ERROR: --health-file path not found: $HEALTH_FILE"
		echo "VERDICT: COULD_NOT_CHECK (health file missing)"
		exit 2
	fi
	if [ ! -s "$HEALTH_FILE" ]; then
		echo "  ERROR: --health-file path is empty: $HEALTH_FILE"
		echo "VERDICT: COULD_NOT_CHECK (empty health file)"
		exit 2
	fi
	cp "$HEALTH_FILE" "$HEALTH_BODY_FILE"
	HTTP_STATUS="200"
else
	echo "[1/3] fetching $HEALTH_URL"

	set +e
	HTTP_STATUS=$(curl -sS --max-time 10 \
		-o "$HEALTH_BODY_FILE" \
		-w '%{http_code}' \
		"$HEALTH_URL" 2>"$HEALTH_ERR_FILE")
	CURL_RC=$?
	set -e

	if [ "$CURL_RC" -ne 0 ]; then
		ERR=""
		if [ -s "$HEALTH_ERR_FILE" ]; then
			ERR=$(cat "$HEALTH_ERR_FILE")
		fi
		echo "  ERROR: curl failed (rc=$CURL_RC): $ERR"
		echo "VERDICT: COULD_NOT_CHECK (host unreachable)"
		exit 2
	fi

	if [ "$HTTP_STATUS" != "200" ]; then
		BODY=""
		if [ -s "$HEALTH_BODY_FILE" ]; then
			BODY=$(cat "$HEALTH_BODY_FILE")
		fi
		echo "  ERROR: HTTP $HTTP_STATUS (expected 200)"
		echo "  body: ${BODY:0:200}"
		echo "VERDICT: COULD_NOT_CHECK (host returned non-200)"
		exit 2
	fi

	if [ ! -s "$HEALTH_BODY_FILE" ]; then
		echo "  ERROR: /health returned an empty body"
		echo "VERDICT: COULD_NOT_CHECK (empty response)"
		exit 2
	fi
fi

BODY=$(cat "$HEALTH_BODY_FILE")

# ----- 2. parse body -----

if ! printf '%s' "$BODY" | jq -e . >/dev/null 2>&1; then
	echo "  ERROR: /health body is not JSON"
	echo "  body: ${BODY:0:200}"
	echo "VERDICT: COULD_NOT_CHECK (non-JSON response)"
	exit 2
fi

SERVED_SHA=$(printf '%s' "$BODY" | jq -r '.git_sha // ""')
SERVED_REF=$(printf '%s' "$BODY" | jq -r '.git_ref // "unknown"')
SERVED_VERSION=$(printf '%s' "$BODY" | jq -r '.version // "unknown"')
SERVED_BUILD_DATE=$(printf '%s' "$BODY" | jq -r '.build_date // "unknown"')

echo "  /health reports:"
echo "    version:     $SERVED_VERSION"
echo "    git_sha:     $SERVED_SHA"
echo "    git_ref:     $SERVED_REF"
echo "    build_date:  $SERVED_BUILD_DATE"

# Field absent (older image) or explicitly "unknown" (dev build) or empty
# — all of these mean the running image is unprovable by construction.
if [ -z "$SERVED_SHA" ] || [ "$SERVED_SHA" = "unknown" ]; then
	if [ "$SERVED_SHA" = "unknown" ]; then
		echo "  ERROR: /health git_sha is the literal string \"unknown\""
	elif [ -z "$SERVED_SHA" ]; then
		echo "  ERROR: /health did not include git_sha at all"
	fi
	echo "  This means the running image was built without CCFLARE_GIT_SHA"
	echo "  injected at build time. The image is unprovable by construction."
	echo "VERDICT: COULD_NOT_CHECK (running image missing git_sha)"
	exit 2
fi

# Field present but empty is also caught by the [ -z ... ] branch above.
# Above we distinguish the two cases in the diagnostic so the operator
# can tell which failure mode hit.

# ----- 3. compare -----
#
# Same-length 40-char SHA strings compared with exact equality. No
# tolerance, no prefix match — the only way a canary should pass is by
# comparing the served git_sha byte-for-byte against the expected.

echo "[2/3] comparing"
echo "  served:   $SERVED_SHA"
echo "  expected: $EXPECTED_SHA"

if [ "$SERVED_SHA" = "$EXPECTED_SHA" ]; then
	echo "  MATCH"
	echo "VERDICT: MATCH"
	exit 0
fi

echo "  MISMATCH (served git_sha does not match expected)"
echo "VERDICT: MISMATCH"
exit 1
