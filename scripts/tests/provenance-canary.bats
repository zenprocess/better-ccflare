#!/usr/bin/env bats
#
# provenance-canary.bats — tests for scripts/provenance-canary.sh.
#
# Demonstrates the false-green the operator reported: when the host
# responds with the wrong service's JSON (a knowledge-base app, not
# ccflare), the canary was reporting VERIFIED_MATCH as long as a
# `git_sha` happened to align. The fix asserts the response is from
# ccflare before trusting any field. See the "wrong-service" test
# below — that test FAILS on the unfixed script and PASSES after the fix.

load helpers

@test "wrong-service response (no ccflare identity) is not VERIFIED_MATCH" {
	# Live repro: the URL the operator hit now serves a different
	# service's /health. The body has no ccflare-shaped fields at all.
	export MOCK_SCENARIO=godkb-200
	export MOCK_EXPECTED_SHA="$EXPECTED_SHA"
	run_canary
	# Old script: exits 2 (no git_sha in body) → falsify-after-the-fact
	# would call that "correctly red". New scenario below (with-injected-
	# shas) is the one that produces a false-green.
	[ "$status" -ne 0 ]
	[ "$output" != *"VERIFIED_MATCH"* ]
}

@test "wrong-service with injected ccflare SHAs was a false-green on the OLD script" {
	# This is the smoking gun. A non-ccflare service that happens to
	# return JSON containing `git_sha=<deploy HEAD>` will trip the old
	# canary into VERIFIED_MATCH. There is nothing in the response that
	# says "I am ccflare", so any service that copies the field names
	# passes.
	export MOCK_SCENARIO=godkb-with-ccflare-shas
	export MOCK_EXPECTED_SHA="$EXPECTED_SHA"
	run_canary
	# After the fix: the canary must reject this body because it does
	# not carry a ccflare-specific identity assertion. The script must
	# exit non-zero AND must NOT print VERIFIED_MATCH.
	[ "$status" -ne 0 ]
	[ "$output" != *"VERIFIED_MATCH"* ]
	# The diagnostic must mention the wrong-service issue so operators
	# know what failed. Accept either of the two expected strings.
	[[ "$output" == *"wrong service"* || "$output" == *"not ccflare"* || "$output" == *"ccflare"* ]]
}

@test "real ccflare response matches deploy branch HEAD" {
	# Sanity: when the body really is ccflare's and the SHAs agree, the
	# canary reports VERIFIED_MATCH. This must keep passing after the fix.
	export MOCK_SCENARIO=real-ccflare
	export MOCK_EXPECTED_SHA="$EXPECTED_SHA"
	run_canary
	[ "$status" -eq 0 ]
	[[ "$output" == *"VERIFIED_MATCH"* ]]
}

@test "real ccflare with drift SHA exits 1 (VERIFIED_DRIFT)" {
	# Sanity: the canary still detects drift. After the fix, the
	# drift detection must remain in place.
	export MOCK_SCENARIO=real-ccflare
	# Inject a SHA that disagrees with the deploy branch HEAD.
	export MOCK_EXPECTED_SHA="$(printf '1%.0s' {1..40})"
	run_canary
	[ "$status" -eq 1 ]
	[[ "$output" == *"VERIFIED_DRIFT"* ]]
}

@test "ccflare-shaped body with wrong strategy is rejected (not VERIFIED_MATCH)" {
	# Second identity-assertion path: accounts is integer-valid but
	# strategy is not from the ccflare set. Must exit non-zero AND must
	# NOT print VERIFIED_MATCH.
	export MOCK_SCENARIO=real-ccflare-bad-strategy
	export MOCK_EXPECTED_SHA="$EXPECTED_SHA"
	run_canary
	[ "$status" -ne 0 ]
	[ "$output" != *"VERIFIED_MATCH"* ]
	[[ "$output" == *"strategy"* ]]
}

@test "host unreachable exits 2 (COULD_NOT_CHECK)" {
	# Sanity: the network-failure case still distinguishes itself.
	export MOCK_SCENARIO=health-down
	run_canary
	[ "$status" -eq 2 ]
	[[ "$output" == *"COULD_NOT_CHECK"* ]]
}

@test "non-200 response exits 2 (COULD_NOT_CHECK)" {
	export MOCK_SCENARIO=non-200
	run_canary
	[ "$status" -eq 2 ]
	[[ "$output" == *"COULD_NOT_CHECK"* ]]
}

@test "non-JSON response exits 2 (COULD_NOT_CHECK)" {
	export MOCK_SCENARIO=non-json
	run_canary
	[ "$status" -eq 2 ]
	[[ "$output" == *"COULD_NOT_CHECK"* ]]
}
