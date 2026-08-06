# Hostname neutralization report

This report records every comment/doc-text rewrite that replaces
environment-specific machine references with generic wording, so the
comments read correctly for any deployment.

The PR containing these rewrites is tracked upstream as
**tombii/better-ccflare#385**.

## Scope

- **Discovery command:** `git grep -inE '<redacted-pattern>' upstream/main`
  — 9 matches across 9 files. The pattern matches deployment hostnames
  and short machine names from one particular operational environment.
- **Constraint:** comment and doc text only. Zero behavior change.
- **Coordination:** the three test files shared with a sibling
  test-stability PR were edited on comment lines only, so the two PRs
  do not collide.
  - `packages/database/src/migrations-dedup-preserving-state.test.ts`
  - `packages/proxy/src/__tests__/anthropic-terminal-recovery.test.ts`
  - `packages/proxy/src/__tests__/response-handler-anthropic-terminal-recovery.test.ts`
- **Acceptance:** the same discovery command run against the branch
  returns zero hits (verified post-commit).

## Rewrites (abstract → concrete)

The literal `before` strings are intentionally not reproduced here, so
this report itself satisfies the acceptance grep. The rewrites fall
into three shapes:

### Shape A — drop a hostname from a phrase

The deployment hostname was used as an adjective on a noun that already
implied real-world operation. The hostname is dropped, the noun is
preserved.

| File | Line | Before pattern | After |
|------|------|----------------|-------|
| `CB-INTEGRATION-REPORT.md` | 186 | `<host>.<tld>` parenthetical naming one deployment, with `etc.` | parenthetical removed; the bullet reads "Did NOT touch any live service." |
| `packages/dashboard-web/src/components/accounts/RateLimitProgress.test.tsx` | 271 | `on <machine>` | `in production` |
| `packages/database/src/migrations-dedup-preserving-state.test.ts` | 15 | `Production <machine> had exactly this state` | `Production had exactly this state` |
| `packages/http-api/src/services/__tests__/anomaly-insights.test.ts` | 253 | `live <machine> traffic` | `live traffic` |
| `packages/http-api/src/services/__tests__/anomaly-insights.test.ts` | 320 | `live <machine> fleet` | `live fleet` |

### Shape B — drop a hostname that is paired with a provider name

The provider name (`anthropic`, `minimax`) is a public product name and
must stay. The deployment hostname that prefixed it is dropped.

| File | Line | Before pattern | After |
|------|------|----------------|-------|
| `packages/proxy/src/__tests__/anthropic-terminal-recovery.test.ts` | 677 | `<machine>/<provider> 8-second 200 with 0 output tokens` | `<provider> 8-second 200 with 0 output tokens` |
| `packages/proxy/src/__tests__/response-handler-anthropic-terminal-recovery.test.ts` | 230 | `<machine>/<provider> IncompleteRead signature` | `<provider> IncompleteRead signature` |

### Shape C — drop a hostname together with a precise duration and/or date

When a precise outage duration or incident date is tied to a
deployment hostname, all three are generalised together: hostname is
replaced with `a proxy instance`, duration is approximated, and the
specific date is removed.

| File | Line | Before pattern | After |
|------|------|----------------|-------|
| `packages/http-api/src/handlers/__tests__/health-usage-exhausted.test.ts` | 286 | `<machine> was down <N> minutes because every account` | `a proxy instance was down for ~2 hours because every account` |
| `packages/proxy/src/handlers/proxy-operations.ts` | 1532 | `<N>-minute <machine> outage (production trace <date>)` | `approximately two-hour outage (production trace)` |

## What was deliberately left alone

- **Test names** (strings passed to `it(...)` / `test(...)`) still
  mention specific dates. These are code, not comments, and the
  constraint is "comment and doc text only".
- **The JSDoc block opening at line 6 of
  `health-usage-exhausted.test.ts`** mentions a precise outage
  duration but does not name a machine, so it is outside the scope of
  the rewrite rule ("a specific outage duration tied to a machine
  name").
- **Provider names** (`anthropic`, `minimax`, `bedrock`) are public
  product names and stay in every rewrite.

## Verification

```text
$ git grep -inE '<redacted-pattern>'
$ echo $?
1
```

No matches on the branch after the commit. The `<redacted-pattern>`
matches the same set the discovery command used; the report itself
uses the placeholder to avoid tripping the grep.

All rewrites are confined to comment/doc text — no code or test inputs
changed. The diffstat is 8 files, 9 insertions, 9 deletions: exactly
one line per rewrite.

## Follow-up: round 2 (added after this report was written)

A second pass, prompted by an independent review, extended the same
neutralisation to two additional classes of internal data that the
hostname pattern does not match:

- a literal operator filesystem path (one occurrence in the
  integration report),
- orchestration session identifiers of the form `(ccflare-NNN)`
  embedded in test descriptions and a few JSDoc comments.

The second pass modified 6 additional files for 10 line changes, on
top of the 8-file round-1 diff documented above. The full PR therefore
touches 12 files for 19 line changes across 2 commits. Two synthetic
test fixtures in `project-attribution.test.ts` are deliberately left
in place — see the PR body for the justification.

The report on this branch is the historical record of round 1; the
PR itself is the authoritative record of both rounds.
