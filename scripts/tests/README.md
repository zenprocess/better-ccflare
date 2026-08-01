# verify-live-build test harness

Bats-based tests for `scripts/verify-live-build.sh`. Runs entirely against
a configurable bash-shim `docker` and `podman`; no real container runtime
required, no network access required.

## Layout

- `mock-runtime.sh` — single shim acting as `docker` AND `podman`. Behaviour
  is driven by `$MOCK_SCENARIO`, the scenario name passed by each test.
- `helpers.bash` — bats helpers (`setup`, `teardown`, env wiring).
- `verify-live-build.bats` — the tests. Six scenarios:
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

## Running

```sh
bats scripts/tests/verify-live-build.bats
```

Or per the script's own contract:

```sh
bats --tap scripts/tests/verify-live-build.bats
```

## Why mocked and not live

The script under test is for operator use against ccmax. AO workers
cannot reach ccmax (DNS for *.zp.digital is closed by design). The mock
runtime keeps the harness pure: no Docker daemon required, no
containers left behind, deterministic, fast.
