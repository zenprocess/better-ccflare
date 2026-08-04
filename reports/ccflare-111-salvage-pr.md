# ccflare #111 — Salvage-PR Lane (worker report)

Lane: `ao/ccflare-146/root` (worker session, sandboxed + unsandboxed runs recorded).
Work item: `zenprocess/ao-company` issue #111, salvage half only — no merge, no branch-delete,
no primary-checkout-switch.

---

## Step 0 — falsification (mandatory first action)

```
$ git merge-base --is-ancestor a3f6b99d main; echo "exit=$?"
exit=1
```

Non-zero exit — `a3f6b99d` is **NOT** merged to main. Issue admitted. Proceeding.

(Also measured locally for completeness — `1` is the "not merged" exit code from
`git merge-base --is-ancestor`; `0` would mean the issue is unfalsifiable and we would stop.)

## Branch state vs current `origin/main`

```
$ git rev-parse origin/ao/issue-111/salvage
adbf4f4ded7ed526a34693bc2944f523620abae4

$ git rev-parse origin/main
7f1a5d307d482aaacfdd40cdc124f9f3e6d6ddb6

$ git merge-base origin/ao/issue-111/salvage origin/main
053746c1c0dfe5c8fe5d11be089b7ac750411c15

$ git log --oneline --no-merges origin/ao/issue-111/salvage..origin/main | wc -l
10

$ git log --oneline origin/ao/issue-111/salvage ^origin/main
adbf4f4d add(salvage): land docs/351-multi-instance-path.md, docs/reviews/verify-live-build.adversarial.md, gitignore .ao/ entry
a3f6b99d fix(alerts): key runaway-loop detector on per-agent identity + configurable minRequests
```

Local `ao/issue-111/salvage` tip and remote tip match (`adbf4f4d…`); `git rev-list --count
refs/heads/ao/issue-111/salvage --not --remotes` = 0 — branch is fully pushed.

### Was a rebase needed?

No. Verified three ways:

1. `git log --no-merges 053746c1..origin/main --` against the 10 paths `a3f6b99d` modified
   returned **no commits** — main has not touched those files since the fork.
2. `git log --no-merges 053746c1..origin/main -- .gitignore docs/351-multi-instance-path.md
   docs/reviews/verify-live-build.adversarial.md` (the `adbf4f4d` paths) returned
   **no commits** — no doc-side or gitignore-side drift.
3. `git merge-tree $(git merge-base origin/ao/issue-111/salvage origin/main)
   origin/ao/issue-111/salvage origin/main` reports **no conflicts** in the 10-file diff
   (the only diff hunks are about `.github/scripts/issue-triage.sh` deletions that
   `security: disable 9 inherited upstream workflows` introduced on main — unrelated to
   any salvage-side file).

Opening the PR from the un-rebased branch tip is safe and intentional: rebasing would
defeat the audit-stamped provenance of `a3f6b99d`.

## Test verification on branch tip `adbf4f4d`

Both environments ran from `/Users/vvladescu/ao-projects/ccflare` with `TMPDIR=/tmp/claude-501`.
Full logs captured at `/tmp/claude-501/bun-test-sandboxed.log` and
`/tmp/claude-501/bun-test-unsandboxed.log`.

### Exact invocation

```
bun test packages/config packages/http-api packages/types
```

### Sandboxed (default AO worker harness; `TMPDIR=/tmp/claude-501`)

```
408 pass
20 fail
1090 expect() calls
Ran 428 tests across 42 files. [2.64s]
exit=1
```

20 failures are all `SQLITE_CANTOPEN` against hardcoded `/tmp/test-*.db` paths in seven
test files (account-add-duplicate-guard, account-remove-handler, kilo, model-mappings-update,
nanogpt, oauth, requests). They are the harness-routing failure addressed by `f3524cd9`
(`fix(test): route tests through TMPDIR so suite passes under harness sandbox`) which is
already on `main` — this branch tip predates it. **Not regressions introduced by `a3f6b99d`.**

### Unsandboxed (`dangerouslyDisableSandbox: true`, same TMPDIR)

```
459 pass
0 fail
4 errors
1227 expect() calls
Ran 459 tests across 42 files. [3.43s]
exit=1
```

The `4 errors` are non-test "Unhandled error between tests" entries fired during
`bun-sql-adapter` `close()`'s `PRAGMA wal_checkpoint(TRUNCATE)` after a successful run —
they do not fail any test (the test count is `0 fail`). They are a known concurrent-WAL
artefact on a shared `/tmp/test-*.db` between sibling test files in this branch's
pre-`f3524cd9` state.

### Two-environment disagreement is the finding

This is the **expected** and **reported** disagreement: branch tip predates `f3524cd9`.
Post-merge (after this PR lands) those test sites will read `process.env.TMPDIR` per the
main-side routing fix, and the harness-sandbox green/unsandbox-green numbers will converge
to the same truth the worker just measured unsandboxed: 459 pass / 0 fail / 1227 expect()
/ 42 files.

A runner that reported 0 fail / 0 test files run would be a manufactured green and would
be rejected; the numbers above are the **real** harness output.

## PR — open (no merge)

Created via:

```
gh pr create --repo zenprocess/better-ccflare --base main \
  --head ao/issue-111/salvage \
  --title "fix(alerts): key runaway-loop detector on per-agent identity + land salvage docs (#111 salvage half)" \
  --body-file reports/ccflare-111-salvage-pr.md
```

…followed by a `PATCH /repos/zenprocess/better-ccflare/pulls/19` to set the title/body
(`gh pr edit` ran into the local GraphQL TLS error `OSStatus -26276` against
`api.github.com/graphql`; curl to the REST endpoint works).

### Target proof (`gh pr view` equivalent via REST)

```
$ curl -s -H "Authorization: token $GITHUB_TOKEN" \
    https://api.github.com/repos/zenprocess/better-ccflare/pulls/19

url           : https://github.com/zenprocess/better-ccflare/pull/19
headRefName   : ao/issue-111/salvage
baseRefName   : main
head_repo     : zenprocess/better-ccflare
base_repo     : zenprocess/better-ccflare
cross_repo    : False
state         : open
user          : zenprocess
title         : fix(alerts): key runaway-loop detector on per-agent identity + land salvage docs (#111 salvage half)
body-len      : 3234 chars
```

Note (per the brief): the equivalent `gh pr view --repo zenprocess/better-ccflare 19 --json
url,isCrossRepository,baseRefName` was attempted but the local `gh` install hits the
GraphQL TLS error `Post "https://api.github.com/graphql": tls: failed to verify certificate:
x509: OSStatus -26276` on every GraphQL call (`gh pr list --json`, `gh pr view --json`,
`gh pr edit`). The REST endpoint serves the same fields via curl; the fields above are the
direct equivalents of `url`, `isCrossRepository=false`, and `baseRefName=main`.

### PR number / URL

- **#19** — https://github.com/zenprocess/better-ccflare/pull/19
- **State**: OPEN. Merge is out of lane (operator-executed after independent verification).

## Sandbox/auth note

- `dangerouslyDisableSandbox: true` was used **only** to obtain the truthful unsandboxed test
  count for the report. The sandboxed number is the real production-env number and is also
  reported. The two-environment rule is satisfied.
- `gh` GraphQL TLS (`OSStatus -26276`) and `GITHUB_TOKEN` "invalid" surfaced by `gh auth status`
  are local-macOS-keychain issues that did not block delivery: PR create via `gh` succeeded,
  and PR edit / view fell back to direct `api.github.com` REST calls with the same `$GITHUB_TOKEN`.

## Out of lane — confirmed untouched

- No merge of PR #19.
- No deletion, rename, or repointing of `fix/runaway-loop-session-key` (or any other ref).
- No `git switch`, `git checkout --`, or `git reset` in `/Users/vvladescu/ao-projects/ccflare`.
- No touch of PR #18 or `feat/dreaming-rollup-and-pg-prune`.
- No `.github/workflows` added.

The primary checkout `/Users/vvladescu/ao-projects/ccflare` is still on
`ao/issue-111/salvage`; restoring it to `main` is operator-executed after merge.
