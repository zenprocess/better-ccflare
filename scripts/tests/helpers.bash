#!/usr/bin/env bash
# helpers.bash — bats setup/teardown for verify-live-build tests.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SCRIPT_DIR

# Setup is invoked before every test by bats.
setup() {
	# Isolated mock bin and tmpdir per test.
	TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/verify-live-build.XXXXXX")
	export TEST_TMP
	MOCK_BIN="$TEST_TMP/bin"
	mkdir -p "$MOCK_BIN"
	cp "$SCRIPT_DIR/mock-runtime.sh" "$MOCK_BIN/docker"
	cp "$SCRIPT_DIR/mock-runtime.sh" "$MOCK_BIN/podman"
	chmod +x "$MOCK_BIN/docker" "$MOCK_BIN/podman"
	export PATH="$MOCK_BIN:$PATH"
}

teardown() {
	[ -n "${TEST_TMP:-}" ] && rm -rf "$TEST_TMP"
}

# Run the script under test. The bats `run` builtin captures stdout,
# stderr, and exit code.
run_script() {
	local summary="$TEST_TMP/summary.json"
	local out="$TEST_TMP/out.txt"
	run bash "$SCRIPT_DIR/../verify-live-build.sh" \
		--local \
		--container ccflare \
		--summary-file "$summary" \
		-o "$out" \
		"$@"
}

# Read a JSON field via the script's own summary file. We control every
# field we emit so we can parse it with a one-liner. If jq is missing
# we fall back to a regex on the same line.
json_field() {
	local file="$1" field="$2"
	if command -v jq >/dev/null 2>&1; then
		jq -r --arg k "$field" '.["'"$field"'"] // .["'"$(echo "$field" | tr '.' '_')"'"] // "<missing>"' "$file" 2>/dev/null
	else
		grep -E "^\s*\"$field\"" "$file" | head -1 | sed -E 's/^[^"]*"[^"]*"[^"]*"(.*)",?\s*$/\1/'
	fi
}
