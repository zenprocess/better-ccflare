# scripts/tests — bats harnesses for ccflare shell scripts

Two bats suites cover the operator-facing shell scripts in `scripts/`.
Both run entirely against bash shims; no live network, no live
container runtime, no live git remote.

## Layout

- `mock-runtime.sh` — configurable shim impersonating `docker` AND
  `podman`. Driven by `$MOCK_SCENARIO`. Used by verify-live-build.
- `mock-network.sh` — configurable shim impersonating `curl` AND
  `git`. Driven by `$MOCK_SCENARIO`. Used by provenance-canary.
- `helpers.bash` — bats `setup`/`teardown`, env wiring, and per-suite
  runner helpers (`run_script`, `run_canary`, `json_field`). Installs
  both mock sets into `PATH` so a single helper file covers both
  suites.
- `verify-live-build.bats` — tests for `scripts/verify-live-build.sh`.
- `provenance-canary.bats` — tests for `scripts/provenance-canary.sh`.

## Running

```sh
bats scripts/tests/*.bats
```

Or per the tap format:

```sh
bats --tap scripts/tests/*.bats
```

## verify-live-build.bats

Six scenarios for the layered build/runtime comparator:

1. **all-match** — every captured value agrees, layered digest present
   → expects `VERIFIED_MATCH` (exit 0).
2. **drift** — /health says `git_sha=A`, OCI label says `revision=B`
   → expects `VERIFIED_DRIFT` (exit 1).
3. **health-down** — /health 500s; everything else works
   → expects `COULD_NOT_DETERMINE` (exit 2).
4. **pre-109-image** — /health succeeds but lacks the four provenance
   fields (image predates PR #109)
   → expects `COULD_NOT_DETERMINE` (exit 2).
5. **multi-match** — two `ccflare` candidates returned by `docker ps`
   → expects `AMBIGUOUS` listing + `COULD_NOT_DETERMINE` (exit 2).
6. **no-runtime** — neither `docker` nor `podman` findable
   → expects `FATAL: no usable container runtime detected` (exit 2).

## provenance-canary.bats

Eight scenarios for the runtime /health comparator. The critical test
is the second one — it is the regression test for the false-green bug
the operator filed against an earlier release of the canary.

1. **wrong-service (no identity fields)** — host returns a non-ccflare
   service's JSON. The body uses a deliberately synthetic stand-in
   shape (`{"status":"ok","service":"other-service","items":42}`).
   The canary must reject.
2. **wrong-service with injected ccflare SHAs** — same synthetic
   stand-in body but with `git_sha` matching the deploy branch HEAD.
   The identity assertion must reject this. (Without the identity
   assertion, the canary reports `VERIFIED_MATCH` against a
   non-ccflare service — a false-green worse than no check.)
3. **real ccflare matches deploy HEAD** — happy path.
4. **real ccflare with drift SHA** — `git_sha` does not match deploy
   HEAD. `VERIFIED_DRIFT` (exit 1).
5. **ccflare-shaped body with wrong strategy** — second identity
   assertion path: `accounts` is integer-valid but `strategy` is not
   from the ccflare set. Reject.
6. **host unreachable** — `COULD_NOT_CHECK` (exit 2).
7. **non-200 response** — `COULD_NOT_CHECK` (exit 2).
8. **non-JSON response** — `COULD_NOT_CHECK` (exit 2).

## Why mocked and not live

The scripts under test are for operator use against internal hosts.
AO workers cannot reach those hosts (DNS for the internal zone is
closed by design). The mock shims keep the harness pure: no Docker
daemon required, no containers left behind, deterministic, fast.
