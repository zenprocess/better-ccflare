#!/usr/bin/env bash
#
# repo-hygiene-canary.sh — repo-sprawl budget comparator (ao-company #113).
#
# Answers one question:
#
#   Is this repo's local sprawl within its committed budgets?
#
# The seven metrics measured here are repo-sprawl signals (branches,
# worktrees, rescue refs, tags, unpushed commits, dirty-file age) -- NOT
# code-quality metrics. Code-quality hygiene (jscpd, lint, typecheck) is
# already gated by `bun run verify` and the existing biome/tsc scripts.
# This script is the alarm for the OTHER class of hygiene that the org
# audit found reproduces in every active repo: local-ref sprawl.
#
# ----------------------------------------------------------------------
# THREE DISTINCT VERDICTS -- DO NOT COLLAPSE
# ----------------------------------------------------------------------
#
#   OK (exit 0)                -- every metric is within its committed
#                                budget.
#
#   BREACH (exit 1)            -- at least one metric EXCEEDS its budget.
#                                A budget is the upper limit; measured
#                                greater than budget is a breach
#                                (measured equal to budget is OK by
#                                convention).
#
#   COULD_NOT_CHECK (exit 2)   -- at least one input was unreadable:
#                                budgets file missing, jq absent, a git
#                                query failed. NEVER green.
#
# ----------------------------------------------------------------------
# USAGE
# ----------------------------------------------------------------------
#
#   scripts/repo-hygiene-canary.sh [--repo PATH] [--offline]
#
#     --repo PATH    Path to the ccflare checkout to audit. Default: PWD.
#                    The repo MUST be a working tree (not a bare clone)
#                    for the dirtyFileMaxAgeHours metric.
#     --offline      Skip `git ls-remote` calls. localOnlyTags then
#                    counts every local tag (conservative overestimate).
#     --help         Show this help.
#
# ----------------------------------------------------------------------
# SCHEDULING
# ----------------------------------------------------------------------
#
# Designed for launchd / cron / a cald registered check. Run from a host
# that has read access to the repo working tree. Output is one line per
# metric in the form `metric=value budget=value OK|BREACH`, suitable for
# log aggregation. Exit code is the verdict.
#
# The unpushed metric MUST be `rev-list --count --branches --not --remotes`,
# never `--all`. The raw `--all` variant counts rescue refs and local tags
# and corrupted 4 of 12 org audits (590 vs 4 real unpushed commits).
#

set -euo pipefail

# REPO precedence: --repo flag > HYGIENE_REPO_PATH env var > PWD.
# HYGIENE_REPO_PATH is set by the launchd plist so launchd can invoke the
# canary without a wrapper script.
REPO="${HYGIENE_REPO_PATH:-${PWD}}"
OFFLINE=0

usage() {
  sed -n '2,40p' "$0"
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)    REPO="$2"; shift 2 ;;
    --offline) OFFLINE=1; shift ;;
    --help|-h) usage ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  echo "metric=jq measured=COULD_NOT_CHECK budget=- COULD_NOT_CHECK" >&2
  exit 2
fi

if ! command -v git >/dev/null 2>&1; then
  echo "metric=git measured=COULD_NOT_CHECK budget=- COULD_NOT_CHECK" >&2
  exit 2
fi

REPO_ABS="$(cd "$REPO" && pwd -P)"

if ! git -C "$REPO_ABS" rev-parse --git-dir >/dev/null 2>&1; then
  echo "metric=repo measured=COULD_NOT_CHECK budget=- COULD_NOT_CHECK reason=not-a-git-repo path=$REPO_ABS" >&2
  exit 2
fi

BUDGETS_FILE="$REPO_ABS/.zp/hygiene-budgets.json"

if [ ! -f "$BUDGETS_FILE" ]; then
  echo "metric=budgets-file measured=COULD_NOT_CHECK budget=- COULD_NOT_CHECK reason=missing-file path=$BUDGETS_FILE" >&2
  exit 2
fi

# -- helpers --

# Cross-platform mtime in seconds since epoch.
file_mtime() {
  if stat -f %m "$1" >/dev/null 2>&1; then
    stat -f %m "$1"
  else
    stat -c %Y "$1"
  fi
}

read_budget() {
  jq -r ".${1}" "$BUDGETS_FILE"
}

# -- metric collectors --

m_local_branches() {
  git -C "$REPO_ABS" branch | wc -l | tr -d ' '
}

m_worktrees() {
  git -C "$REPO_ABS" worktree list | wc -l | tr -d ' '
}

# Ephemeral worktrees live under /private/(tmp|var) per issue #113 spec.
m_ephemeral_worktrees() {
  git -C "$REPO_ABS" worktree list | grep -cE '/private/(tmp|var)/' || true
}

m_rescue_refs() {
  git -C "$REPO_ABS" for-each-ref refs/rescue | wc -l | tr -d ' '
}

# localOnlyTags = local tags minus tags known to any configured remote.
# If --offline, count every local tag (conservative overestimate).
# If a remote is unreachable, its tag set is treated as empty (also
# conservative).
m_local_only_tags() {
  local local_count
  local_count="$(git -C "$REPO_ABS" for-each-ref refs/tags --format='%(refname:short)' | wc -l | tr -d ' ')"

  if [ "$OFFLINE" -eq 1 ]; then
    echo "$local_count"
    return
  fi

  local known_count=0 remote known_names=""
  while IFS= read -r remote; do
    [ -z "$remote" ] && continue
    local tags
    if tags="$(git -C "$REPO_ABS" ls-remote --tags "$remote" 2>/dev/null | awk '{print $2}' | sed -n 's|^refs/tags/||p')"; then
      known_names="${known_names}
${tags}"
    fi
  done < <(git -C "$REPO_ABS" remote | awk '{print $1}')

  known_count="$(printf '%s\n' "$known_names" | grep -v '^$' | sort -u | wc -l | tr -d ' ')"

  local n=$((local_count - known_count))
  if [ "$n" -lt 0 ]; then n=0; fi
  echo "$n"
}

# MUST be --branches --not --remotes. Never --all.
m_unpushed() {
  git -C "$REPO_ABS" rev-list --count --branches --not --remotes
}

# OLDEST mtime (in hours) among porcelain-1 entries, or 0 if clean.
m_dirty_max_age_h() {
  local now oldest=0 f m age_s age_h line
  now="$(date +%s)"
  while IFS= read -r line; do
    f="$(echo "$line" | awk '{print $2}' | sed 's|.* -> ||')"
    [ -z "$f" ] && continue
    [ -f "$REPO_ABS/$f" ] || continue
    m="$(file_mtime "$REPO_ABS/$f")"
    age_s=$((now - m))
    age_h=$((age_s / 3600))
    if [ "$age_h" -gt "$oldest" ]; then oldest="$age_h"; fi
  done < <(git -C "$REPO_ABS" status --porcelain)
  echo "$oldest"
}

# -- driver --

breach=0
could_not_check=0

emit() {
  local metric="$1" measured="$2" budget="$3" verdict
  if [ "$measured" = "COULD_NOT_CHECK" ]; then
    verdict="COULD_NOT_CHECK"
    could_not_check=1
  elif [ "$measured" -gt "$budget" ] 2>/dev/null; then
    verdict="BREACH"
    breach=1
  else
    verdict="OK"
  fi
  printf '%s=%s budget=%s %s\n' "$metric" "$measured" "$budget" "$verdict"
}

for metric in localBranches worktrees ephemeralWorktrees rescueRefs localOnlyTags unpushedBranchCommits dirtyFileMaxAgeHours; do
  budget="$(read_budget "$metric")"
  if [ -z "$budget" ] || [ "$budget" = "null" ]; then
    emit "$metric" COULD_NOT_CHECK "-"
    continue
  fi
  case "$metric" in
    localBranches)         measured="$(m_local_branches)" ;;
    worktrees)             measured="$(m_worktrees)" ;;
    ephemeralWorktrees)    measured="$(m_ephemeral_worktrees)" ;;
    rescueRefs)            measured="$(m_rescue_refs)" ;;
    localOnlyTags)         measured="$(m_local_only_tags)" ;;
    unpushedBranchCommits) measured="$(m_unpushed)" ;;
    dirtyFileMaxAgeHours)  measured="$(m_dirty_max_age_h)" ;;
  esac
  emit "$metric" "$measured" "$budget"
done

if [ "$could_not_check" -eq 1 ]; then
  exit 2
fi
if [ "$breach" -eq 1 ]; then
  exit 1
fi
exit 0
