#!/usr/bin/env bash
#
# mock-network.sh — bats shim that impersonates `curl` and `git` for the
# provenance-canary test harness. No real network access, no real git
# remote.
#
# The shim is invoked as either `curl` or `git` (same file, two symlinks).
# Behaviour is driven by $MOCK_SCENARIO. The shim writes a body file when
# called as curl and exits 0 with HTTP 200, or 7 (connection refused) when
# the scenario demands it.
#
# Scenarios:
#   godkb-200               /health returns the godkb knowledge-base body
#                           that the live host currently serves. The body
#                           does NOT include ccflare's four provenance
#                           fields. Used to demonstrate the false-green
#                           the live deployment now exhibits.
#
#   godkb-with-ccflare-shas /health returns the godkb body but with the
#                           four ccflare provenance fields injected AND
#                           the git_sha matching the deploy branch HEAD.
#                           Used to demonstrate that the canary's parse-
#                           compare path treats any JSON with the right
#                           field values as a match, regardless of which
#                           service actually served the body.
#
#   real-ccflare            /health returns the full ccflare body the
#                           running instance serves (used as the fix
#                           verification case).
#
#   health-down             curl exits 7 (connection refused).
#
#   non-200                 curl exits 0 with HTTP_STATUS=500.
#
#   non-json                curl exits 0 with HTTP_STATUS=200 and a body
#                           that is not JSON.

set -u

SCEN="${MOCK_SCENARIO:-help}"

# Default SHA the test harness expects when checking match/mismatch.
# The bats test sets this via $MOCK_EXPECTED_SHA.
EXPECTED_SHA="${MOCK_EXPECTED_SHA:-0000000000000000000000000000000000000000}"

# We are called as either `curl` or `git`. Detect by basename.
SELF="$(basename "$0")"

if [ "$SELF" = "git" ]; then
	# The provenance-canary script under test invokes git in two ways:
	#   git clone --depth=1 --branch X URL DIR       (fresh clone)
	#   git -C DIR rev-parse refs/heads/X            (HEAD resolve)
	#
	# Both can be answered without a real remote. `git clone` with a
	# local path succeeds; we make the script use --git-dir instead so
	# no clone is needed at all (the tests will pass --git-dir). But if
	# the test forgets, handle clone of a local path by creating the
	# target dir and writing the expected SHA into a known file. The
	# simplest correct path: write a real repo at $MOCK_GIT_DIR on demand
	# and require tests to pass --git-dir.
	#
	# Tests set MOCK_GIT_DIR to a path containing a real bare repo whose
	# HEAD for refs/heads/<branch> is MOCK_EXPECTED_SHA.
	if [ "${1:-}" = "clone" ]; then
		# If REPO_URL is a path to an existing directory, copy it.
		# Otherwise write a stub and succeed.
		echo "mock-git: clone unsupported in this scenario; pass --git-dir" >&2
		exit 1
	fi
	if [ "${1:-}" = "rev-parse" ]; then
		# Called as: git -C <dir> rev-parse <ref>
		# The test's --git-dir contains a real git repo with the
		# expected SHA at refs/heads/<branch>.
		shift
		# Strip -C <dir> if present.
		while [ $# -gt 0 ]; do
			case "$1" in
				-C) shift 2 ;;
				*) break ;;
			esac
		done
		# First positional is refs/heads/<branch> or origin/<branch>.
		# We don't actually have origin/<branch> in the test repo
		# unless we set it up; fall through to the real git binary.
		exec /usr/bin/git "$@"
	fi
	# Fall through to real git for any other invocation.
	exec /usr/bin/git "$@"
fi

# --- curl ---

# Parse curl flags we care about. The script calls:
#   curl -sS --max-time N -o BODY_PATH -w '%{http_code}' URL
# so we need: -o (body path), -w (status format), URL.

URL=""
BODY_PATH=""
HTTP_CODE="200"

# The script redirects stderr to a .err file; we use the same convention.
STDERR_LOG="${MOCK_CURL_STDERR_LOG:-/dev/null}"

# Pull URL and body path out of argv.
i=1
while [ $# -ge $i ]; do
	arg="${!i}"
	case "$arg" in
		-o)
			i=$((i + 1))
			BODY_PATH="${!i}"
			;;
		-w)
			i=$((i + 1))
			# format string; we'll just print HTTP_CODE
			;;
		--max-time|-sS|-s|-S|--connect-time)
			i=$((i + 1))
			;;
		http://*|https://*)
			URL="$arg"
			;;
	esac
	i=$((i + 1))
done

# Emit body and HTTP status depending on scenario.
case "$SCEN" in
	godkb-200)
		BODY='{"status":"ok","service":"godkb","last_indexed":1786054383.547513,"seconds_since_index":2024,"artifacts":38124,"projects":51,"vocabulary_terms":9}'
		# Note: no git_sha / git_ref / version / build_date.
		HTTP_CODE=200
		;;
	godkb-with-ccflare-shas)
		# Inject all four ccflare fields with values that match a
		# ccflare-shaped expected SHA. This proves the canary's parse-
		# compare path treats any JSON-with-the-right-fields as a
		# match, regardless of which service served it.
		BODY=$(printf '{"status":"ok","service":"godkb","version":"3.5.47","git_sha":"%s","git_ref":"main","build_date":"2026-08-07T00:00:00Z"}' "$EXPECTED_SHA")
		HTTP_CODE=200
		;;
	real-ccflare)
		# ccflare's /health body shape (HealthResponse in
		# packages/types/src/stats.ts). All required fields present.
		BODY=$(printf '{"status":"ok","accounts":3,"strategy":"session","timestamp":"2026-08-07T00:00:00Z","version":"3.5.47","git_sha":"%s","git_ref":"main","build_date":"2026-08-07T00:00:00Z","pool":{"configured":3}}' "$EXPECTED_SHA")
		HTTP_CODE=200
		;;
	real-ccflare-bad-strategy)
		# ccflare-shaped body but strategy is wrong — proves the
		# identity assertion catches the second path.
		BODY=$(printf '{"status":"ok","accounts":3,"strategy":"random-strategy","version":"3.5.47","git_sha":"%s","git_ref":"main","build_date":"2026-08-07T00:00:00Z"}' "$EXPECTED_SHA")
		HTTP_CODE=200
		;;
	health-down)
		# Connection refused. curl exits 7.
		echo "curl: (7) Failed to connect to host port 8080: Connection refused" >&2
		exit 7
		;;
	non-200)
		BODY="Internal Server Error"
		HTTP_CODE=500
		;;
	non-json)
		BODY="<html>not json</html>"
		HTTP_CODE=200
		;;
	*)
		echo "mock-network: unknown scenario: $SCEN" >&2
		exit 1
		;;
esac

if [ -n "$BODY_PATH" ]; then
	printf '%s' "$BODY" > "$BODY_PATH"
fi

# curl writes the format string on stdout. -w '%{http_code}' prints just
# the code. Print to stdout so curl's caller captures it via $(...).
printf '%s' "$HTTP_CODE"
exit 0
