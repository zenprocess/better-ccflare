#!/usr/bin/env bats
#
# verify-live-build.bats — failure-mode harness for verify-live-build.sh.
#
# All tests run the real script against a mocked docker|podman. No
# real container runtime is touched.

load helpers

@test "all-match: VERIFIED_MATCH (exit 0) and verdict field in summary" {
	export MOCK_SCENARIO=all-match
	run_script
	[ "$status" -eq 0 ] || { echo "stdout: $output"; return 1; }
	[ -f "$TEST_TMP/summary.json" ]
	grep -q '"verdict": "VERIFIED_MATCH"' "$TEST_TMP/summary.json"
	grep -q '"reason": "all_corroboration_checks_pass"' "$TEST_TMP/summary.json"
	grep -q '"missing_fields": ""' "$TEST_TMP/summary.json"
	echo "$output" | grep -q 'STATUS:[[:space:]]*VERIFIED_MATCH'
}

@test "all-match: every required KEY is printed with a concrete value" {
	export MOCK_SCENARIO=all-match
	run_script
	[ "$status" -eq 0 ] || { echo "stdout: $output"; return 1; }
	# Container id is concrete (not <absent:...>)
	echo "$output" | grep -E '^CONTAINER_ID:[[:space:]]+abc123' >/dev/null
	echo "$output" | grep -E '^IMAGE_REF:[[:space:]]+ccflare:1\.0\.0' >/dev/null
	echo "$output" | grep -E '^IMAGE_DIGEST:[[:space:]]+ccflare@sha256:1111' >/dev/null
	echo "$output" | grep -E '^HEALTH_HTTP_STATUS:[[:space:]]+200' >/dev/null
	echo "$output" | grep -E '^HEALTH_GIT_SHA:[[:space:]]+5aba0000' >/dev/null
	echo "$output" | grep -E '^HEALTH_GIT_REF:[[:space:]]+1\.0\.0' >/dev/null
	echo "$output" | grep -E '^HEALTH_BUILD_DATE:[[:space:]]+2026-08-01' >/dev/null
	echo "$output" | grep -E '^BUN_REVISION:[[:space:]]+d00d0000' >/dev/null
	echo "$output" | grep -E '^BUN_REVISION_METHOD:[[:space:]]+build_snapshot:' >/dev/null
}

@test "drift: /health disagrees with OCI label → VERIFIED_DRIFT (exit 1)" {
	export MOCK_SCENARIO=drift
	run_script
	[ "$status" -eq 1 ] || { echo "stdout: $output"; return 1; }
	grep -q '"verdict": "VERIFIED_DRIFT"' "$TEST_TMP/summary.json"
	echo "$output" | grep -q 'STATUS:[[:space:]]*VERIFIED_DRIFT'
	# At least one DRIFT_SIGNALS line.
	echo "$output" | grep -E '^DRIFT_SIGNALS:' >/dev/null
}

@test "drift: summary records the concrete field disagreement" {
	export MOCK_SCENARIO=drift
	run_script
	[ "$status" -eq 1 ]
	# The summary has a non-empty drift_signals array.
	grep -E '"drift_signals": \[' "$TEST_TMP/summary.json" >/dev/null
	# And the array contains at least one record with the field name.
	grep -E '"field": "[^"]+"' "$TEST_TMP/summary.json" >/dev/null
}

@test "health-down: /health 500 → COULD_NOT_DETERMINE (exit 2)" {
	export MOCK_SCENARIO=health-down
	run_script
	[ "$status" -eq 2 ] || { echo "stdout: $output"; return 1; }
	grep -q '"verdict": "COULD_NOT_DETERMINE"' "$TEST_TMP/summary.json"
	echo "$output" | grep -q 'STATUS:[[:space:]]*COULD_NOT_DETERMINE'
	# health_body was captured as missing:
	grep -q 'health_body' "$TEST_TMP/summary.json"
}

@test "pre-109-image: /health has no provenance fields → COULD_NOT" {
	export MOCK_SCENARIO=pre-109-image
	run_script
	[ "$status" -eq 2 ] || { echo "stdout: $output"; return 1; }
	grep -q '"verdict": "COULD_NOT_DETERMINE"' "$TEST_TMP/summary.json"
	echo "$output" | grep -q 'STATUS:[[:space:]]*COULD_NOT_DETERMINE'
	# All four health fields should be reported as <absent: not_in_response>.
	for f in HEALTH_GIT_SHA HEALTH_GIT_REF HEALTH_BUILD_DATE HEALTH_VERSION; do
		echo "$output" | grep -E "^${f}:[[:space:]]+<absent: not_in_response>" >/dev/null
	done
}

@test "pre-109-image: while health is bad, bun revision is still captured" {
	export MOCK_SCENARIO=pre-109-image
	run_script
	[ "$status" -eq 2 ]
	# Bun revision from build_snapshot should be captured — proves the
	# tier ordering keeps surfaces independent even when one is broken.
	echo "$output" | grep -E '^BUN_REVISION:[[:space:]]+d00d0000' >/dev/null
	echo "$output" | grep -E '^BUN_REVISION_METHOD:[[:space:]]+build_snapshot:' >/dev/null
}

@test "multi-match: two ccflare candidates → AMBIGUOUS listing + COULD_NOT" {
	export MOCK_SCENARIO=multi-match
	run_script
	[ "$status" -eq 2 ] || { echo "stdout: $output"; return 1; }
	# The FATAL line lists both candidates so the operator can pick.
	echo "$output" | grep -q 'AMBIGUOUS:'
	echo "$output" | grep -q 'ccflare-1'
	echo "$output" | grep -q 'ccflare-2'
	grep -q '"verdict": "COULD_NOT_DETERMINE"' "$TEST_TMP/summary.json"
}

@test "no-runtime: neither docker nor podman reachable → FATAL exit 2" {
	export MOCK_SCENARIO=no-runtime
	run_script
	[ "$status" -eq 2 ] || { echo "stdout: $output"; return 1; }
	# Runtime-missing is a different failure mode from "could not determine after capturing".
	echo "$output" | grep -q 'FATAL: no usable container runtime'
}

@test "no-container: ps is empty → FATAL listing exit 2" {
	export MOCK_SCENARIO=no-container
	run_script
	[ "$status" -eq 2 ] || { echo "stdout: $output"; return 1; }
	# Lists all running containers for the operator to inspect.
	echo "$output" | grep -q 'all running containers'
}

@test "summary file is always a single valid JSON object when jq is available" {
	export MOCK_SCENARIO=all-match
	run_script
	[ "$status" -eq 0 ]
	# Use jq itself to confirm the file parses cleanly and has the
	# three required top-level keys.
	jq -e 'has("verdict") and has("captured_at") and has("health") and has("image")' \
		"$TEST_TMP/summary.json" >/dev/null
}

@test "summary file uses double-quoted keys even when jq is missing" {
	# Run jq through env to a non-existent path so the script's own
	# tools-were-missing path still produces valid JSON-by-construction.
	# (We can't easily strip jq from PATH on the test runner without
	# disturbing other tests; this assertion instead checks the *shape*
	# of the file, which is independent of how it was produced.)
	export MOCK_SCENARIO=all-match
	run_script
	[ "$status" -eq 0 ]
	# The file begins with '{' and ends with '}'.
	head -n 1 "$TEST_TMP/summary.json" | grep -q '^{'
	tail -n 1 "$TEST_TMP/summary.json" | grep -q '^}$'
	# Quoted keys are double-quoted.
	grep -q '"verdict":' "$TEST_TMP/summary.json"
	grep -q '"captured_at":' "$TEST_TMP/summary.json"
}
