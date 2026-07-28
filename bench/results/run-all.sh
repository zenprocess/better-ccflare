#!/usr/bin/env bash
# Re-runs the leak harness against all three Bun binaries.
# Run from the ccflare worktree root.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HARNESS="$ROOT/bench/bun-35093-harness.ts"
FULLTEST="$ROOT/bench/bun-35093-full-test.ts"
N="${N:-500}"
WARMUP="${WARMUP:-50}"
TARGET_URL="${TARGET_URL:-https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js}"
OUT="$ROOT/bench/results"
mkdir -p "$OUT"

run() {
  local bin="$1" name="$2"
  echo "=== $name ==="
  TARGET_URL="$TARGET_URL" N="$N" WARMUP="$WARMUP" \
    "$bin" "$FULLTEST" 2>&1 | tee "$OUT/${name}.json"
  echo
}

run "$(command -v bun)" "1.3.2"
run "/tmp/claude-501/bun-1.3.14/bun" "1.3.14"
run "/tmp/claude-501/bun-pr-35093/bun" "pr-35093"
