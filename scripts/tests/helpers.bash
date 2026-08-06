#!/usr/bin/env bash
# helpers.bash — bats setup/teardown for canary test harnesses.
#
# Two test suites share this file:
#   - verify-live-build.bats  (mocks docker|podman via mock-runtime.sh)
#   - provenance-canary.bats  (mocks curl|git via mock-network.sh)
#
# Every test installs both sets of mocks into PATH. The unused mock per
# test is harmless (the script under test never invokes it).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SCRIPT_DIR

# Make every writable temp go under $TMPDIR (sandbox-safe).
TEST_TMP_BASE="${TMPDIR:-/tmp}"

setup() {
	TEST_TMP="$(mktemp -d "$TEST_TMP_BASE/canary-test.XXXXXX")"
	export TEST_TMP
	MOCK_BIN="$TEST_TMP/bin"
	mkdir -p "$MOCK_BIN"

	# Mocks for verify-live-build (docker + podman shim).
	cp "$SCRIPT_DIR/mock-runtime.sh" "$MOCK_BIN/docker"
	cp "$SCRIPT_DIR/mock-runtime.sh" "$MOCK_BIN/podman"
	chmod +x "$MOCK_BIN/docker" "$MOCK_BIN/podman"

	# Mocks for provenance-canary (curl + git shim).
	cp "$SCRIPT_DIR/mock-network.sh" "$MOCK_BIN/curl"
	cp "$SCRIPT_DIR/mock-network.sh" "$MOCK_BIN/git"
	chmod +x "$MOCK_BIN/curl" "$MOCK_BIN/git"

	# Prepare a real git repo on disk so the canary's git rev-parse works.
	MOCK_GIT_DIR="$TEST_TMP/gitdir"
	mkdir -p "$MOCK_GIT_DIR"
	git init -q --bare "$MOCK_GIT_DIR/remote.git"
	WORK_TREE="$TEST_TMP/work"
	mkdir -p "$WORK_TREE"
	git -C "$WORK_TREE" init -q
	git -C "$WORK_TREE" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "init"
	EXPECTED_SHA=$(git -C "$WORK_TREE" rev-parse HEAD)
	MOCK_BRANCH="deploy/test-$$"
	git -C "$WORK_TREE" branch -M "$MOCK_BRANCH"
	git -C "$WORK_TREE" remote add origin "$MOCK_GIT_DIR/remote.git"
	git -C "$WORK_TREE" push -q origin "$MOCK_BRANCH"
	export MOCK_GIT_DIR EXPECTED_SHA MOCK_BRANCH

	export PATH="$MOCK_BIN:$PATH"
}

teardown() {
	[ -n "${TEST_TMP:-}" ] && rm -rf "$TEST_TMP"
}

# Run the verify-live-build.sh script under test (legacy harness).
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

# Run the provenance-canary.sh script under test (new harness).
run_canary() {
	run bash "$SCRIPT_DIR/../provenance-canary.sh" \
		--host "http://example.invalid:8080/health" \
		--repo "https://example.invalid/repo.git" \
		--branch "$MOCK_BRANCH" \
		--git-dir "$MOCK_GIT_DIR/remote.git" \
		--timeout 5 \
		"$@"
}

# Read a JSON field via the script's own summary file. If jq is missing
# we fall back to a regex on the same line.
json_field() {
	local file="$1" field="$2"
	if command -v jq >/dev/null 2>&1; then
		jq -r --arg k "$field" '.["'"$field"'"] // .["'"$(echo "$field" | tr '.' '_')"'"] // "<missing>"' "$file" 2>/dev/null
	else
		grep -E "^\s*\"$field\"" "$file" | head -1 | sed -E 's/^[^"]*"[^"]*"[^"]*"(.*)",?\s*$/\1/'
	fi
}
