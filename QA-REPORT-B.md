# QA Report — Family B (MiniMax)

- **Target:** `fix/minimax-usage-hardening` @ `795fdadd54d1ba01e4e0af28c4fa62258eb645c1`
- **PR lineage checked:** PR #347 / `fix/minimax-usage-polling-bootstrap` @ `42dd946f865a8aca6c6089a28a4a5e2d3f90e949`
- **Refreshed upstream main:** `053746c1c0dfe5c8fe5d11be089b7ac750411c15`
- **QA date:** 2026-07-28
- **Overall verdict:** **FAIL**

The scoped typechecks and branch acceptance suite pass after generating the repository's required ignored build artifacts. The configured scoped Biome check fails. The hardening commit itself applies exactly and cleanly to PR #347's head, but directly merging the two branch histories conflicts because the hardening branch contains patch-equivalent cherry-picks of all three PR #347 commits. A separate correctness audit also found that F6's overlap premise is contradicted by the actual `UsageCache` scheduler and in-flight deduplication.

## Gate summary

| Gate | Verdict | Result |
| --- | --- | --- |
| Typecheck | **PASS** | `packages/providers` and `apps/server` both pass scoped `tsc --noEmit` after required generated artifacts are present. |
| Lint | **FAIL** | Scoped non-mutating Biome check exits 1 with 2 errors and 1 warning. The parent has the same file-level failures, but the hardening commit adds two new formatter deviations in added test lines. |
| Branch acceptance suite | **PASS** | Exact commit-message command: 44 pass, 0 fail, 124 expectations. |
| Cross-branch conflict check | **FAIL** | Both branches are clean against refreshed `upstream/main`, and commit `795fdadd` replays cleanly on PR #347, but a direct branch merge has five conflict hunks in two server files. |
| Scope audit | **PASS** | The target commit contains only F5/F6 source/tests plus its task report; no generated files, `.claude/` edits, unrelated deletions, or formatting sweep rode along. |
| Extra: replay hardening on PR #347 | **PASS** | Applying only `795fdadd^..795fdadd` to `42dd946f` succeeds and produces the exact target tree. |
| Extra: hardening diff duplicates/contradicts PR #347 diff | **PASS, with caveat** | F5/F6 are additive to PR #347's behavior. The *branch history* duplicates PR #347 as three patch-equivalent cherry-picks, which causes the direct-merge failure. F6 separately contradicts existing scheduler semantics outside PR #347's own diff; see the correctness finding. |

## Environment preparation

The environment instructions in `orchestrator/specs/qa-gates.md` were followed before QA:

1. Checked out refreshed `upstream/main`, then created the session QA branch at `795fdadd`.
2. Confirmed `node_modules` is a local directory, not a symlink.
3. Ran `bun install` first:

```text
bun install v1.3.2 (b131639c)
1 package installed
```

4. The first acceptance run exposed the documented missing generated worker stub:

```text
Cannot find module './inline-integrity-check-worker'
19 pass, 1 fail, 1 error
```

5. The initial root/CLI build attempts were blocked because the locally installed npm `bun@1.3.11` peer package had not run its postinstall. After running its own documented installer, the targeted builds succeeded:

```text
node node_modules/bun/install.js
bun run build:cli        # PASS; generated all three inline worker modules
bun run build:dashboard  # PASS; generated dist/embedded.ts and manifest.json
```

6. All generated outputs remained ignored and the tracked worktree stayed clean:

```text
!! apps/cli/dist/
!! packages/dashboard-web/dist/
!! packages/database/src/inline-incremental-vacuum-worker.ts
!! packages/database/src/inline-integrity-check-worker.ts
!! packages/database/src/inline-vacuum-worker.ts
```

No generated artifact is included in this report commit.

## 1. Typecheck — PASS

### Providers

```text
$ bunx tsc --noEmit -p packages/providers/tsconfig.json
# exit 0, no diagnostics
```

### Server

Before dashboard artifacts were generated, both the target and its parent produced the same two missing-artifact diagnostics (the target only shifted each line by one because it added an import):

```text
@better-ccflare/dashboard-web/dist/embedded
@better-ccflare/dashboard-web/dist/manifest.json
```

After `bun run build:dashboard`:

```text
$ bunx tsc --noEmit -p apps/server/tsconfig.json
# exit 0, no diagnostics
```

The final scoped typecheck therefore passes for both affected packages.

## 2. Lint — FAIL

Command (the non-mutating equivalent of the repository's configured `biome check --write --unsafe` script, scoped to the four changed TypeScript files):

```text
$ bunx --bun biome check \
    apps/server/src/server.ts \
    apps/server/src/server.test.ts \
    packages/providers/src/minimax-usage-fetcher.ts \
    packages/providers/src/__tests__/minimax-usage-fetcher.test.ts

Checked 4 files in 38ms. No fixes applied.
Found 2 errors.
Found 1 warning.
# exit 1
```

Reported issues:

- `apps/server/src/server.test.ts:1` — import organization error.
- `apps/server/src/server.test.ts` — formatter error.
- `packages/providers/src/__tests__/minimax-usage-fetcher.test.ts:379` — pre-existing `noNonNullAssertion` warning.

A control run on parent `2f03d9c2` also exits 1 with the same two file-level errors and one warning, so this branch did not create the existing import-order or non-null-assertion debt. However, the target adds two formatter deviations that are absent from the parent:

- `apps/server/src/server.test.ts:355-357` — `toContain(...)` wrapping.
- `apps/server/src/server.test.ts:440-442` — multiline `filter(...)` wrapping.

Per instruction, no lint fix was applied.

## 3. Branch acceptance suite — PASS

Exact command from the target commit message:

```text
$ bun test packages/providers/src/__tests__/minimax-usage-fetcher.test.ts apps/server/src/server.test.ts
bun test v1.3.2 (b131639c)

apps/server/src/server.test.ts:
⚠️  Dashboard assets not found - dashboard will be disabled

44 pass
0 fail
124 expect() calls
Ran 44 tests across 2 files. [352.00ms]
```

The first run failed only because the documented ignored worker stubs were absent. The final run above is after generating them and is the gate result.

## 4. Cross-branch conflict check — FAIL

### Ref freshness

Read-only fetches refreshed both refs:

```text
upstream-main=053746c1c0dfe5c8fe5d11be089b7ac750411c15
pr347-head=42dd946f865a8aca6c6089a28a4a5e2d3f90e949
```

A separate `gh pr view 347` metadata query was blocked by the local certificate store (`x509: OSStatus -26276`), so the remote OPEN state was not independently re-read. The exact PR head was fetched successfully, and mergeability was checked locally against refreshed `upstream/main`.

### Against `upstream/main` — PASS

`upstream/main` is an ancestor of both branches. `git merge-tree --write-tree` completed without conflicts and returned each branch's existing tree:

```text
upstream-main-to-hardening=fast-forward
merge-tree-upstream-hardening=f33bb1f714ad48aa05a792466aea4eb27d292a04
merge-tree-upstream-pr347=da97c91b3407f8fd573f3764f55763b7601e068e
merge-tree-conflicts=none
```

### Hardening commit replayed on PR #347 — PASS

The target's pre-hardening lineage and PR #347 have identical trees even though their commit IDs differ:

```text
42dd946f^{tree}  = da97c91b3407f8fd573f3764f55763b7601e068e
2f03d9c2^{tree}  = da97c91b3407f8fd573f3764f55763b7601e068e
```

Using a temporary index rooted at `42dd946f`, the exact binary patch `795fdadd^..795fdadd` passed `git apply --cached --check`. Applying it to that temporary index produced the exact target tree:

```text
hardening-patch-check=clean
applied-tree=f33bb1f714ad48aa05a792466aea4eb27d292a04
target-tree =f33bb1f714ad48aa05a792466aea4eb27d292a04
tree-equivalence=exact
```

This confirms **the hardening commit itself still applies cleanly on top of PR #347's head** without modifying PR #347.

### Patch-equivalent duplicate lineage

`git cherry -v` marks all three pre-hardening commits with `-` in both directions, proving patch equivalence:

```text
03cc6deb ↔ aa894198  fix: wire minimax usage polling into server bootstrap...
8a779b38 ↔ 9b96028b  test: add regression test that fails...
42dd946f ↔ 2f03d9c2  test: add structural guard that fails...
```

The trees are identical, so the cherry-picks did not modify PR #347's content. They are nevertheless duplicate history.

### Direct branch merge — FAIL

A direct:

```text
git merge-tree --write-tree --messages refs/qa/pr-347 795fdadd
```

exits 1. Synthetic conflict tree: `ce8f1b42b511729fe65dbe300e97ad8191c91d34`.

Exact conflicted paths and hunks:

- `apps/server/src/server.ts`
  1. Bootstrap JSDoc: PR #347's closing comment versus F6's appended poll-clamp documentation.
  2. Bootstrap body: `intervalMs` passthrough versus `effectiveIntervalMs` clamp.
  3. Post-bootstrap insertion: empty PR side versus the new clamp helper, process flag, and warning logger.
- `apps/server/src/server.test.ts`
  1. Imports: PR #347 imports versus F6's added logger/provider/clamp imports.
  2. End of `bootstrapMinimaxUsagePolling` tests: empty PR side versus the entire F6 test block and standalone clamp-helper suite.

The provider files auto-merge cleanly:

- `packages/providers/src/minimax-usage-fetcher.ts`
- `packages/providers/src/__tests__/minimax-usage-fetcher.test.ts`

The direct conflict is caused by the parallel, patch-equivalent PR lineage: Git selects `upstream/main` as the merge base rather than recognizing `42dd946f` as an ancestor of the differently-hashed cherry-picks. Applying only `795fdadd` is clean and exact, but merging the full branches is not.

## 5. Scope audit — PASS

Target commit `795fdadd` changes exactly five files:

```text
M apps/server/src/server.ts
M apps/server/src/server.test.ts
M packages/providers/src/minimax-usage-fetcher.ts
M packages/providers/src/__tests__/minimax-usage-fetcher.test.ts
A orchestrator/reports/review-findings-fixes-task-B.md
```

Stats: 677 insertions, 6 deletions.

The production/test changes match the stated F5/F6 intent. The added orchestrator report is explicitly referenced by the commit message and documents the negative controls, so it is intentional rather than a stray generated file. There are no unrelated deletions, `.claude/` changes, build outputs, dependency-lock changes, or broad formatting edits.

PR #347's own production changes add MiniMax polling bootstrap wiring and logging for an unexpected `model_name`. The hardening commit adds status-code classification (F5) and interval clamping (F6). There is no duplicate F5/F6 implementation in PR #347. PR #347's interval-forwarding assertion uses `12_345ms`; because that is above the new `5000ms` floor, it remains unchanged and passes.

## Additional correctness finding — F6 premise contradicted by scheduler

**Verdict: FAIL (Medium)**

F6 says a poll interval shorter than the 5000ms request timeout allows the next request to start before the previous one finishes, stacking in-flight calls. The actual scheduler does not behave that way:

1. `UsageCache.startPolling` starts the immediate `fetchAndCache` and calls `scheduleNextPoll` only inside the promise's completion handler (`packages/providers/src/usage-fetcher.ts:739-755`).
2. Each scheduled timeout callback awaits `fetchAndCache` and schedules the following timeout only after that await completes (`packages/providers/src/usage-fetcher.ts:639-668`).
3. `fetchAndCache` independently deduplicates concurrent fetches per account by returning the existing in-flight promise (`packages/providers/src/usage-fetcher.ts:815-841`).

Therefore `intervalMs` is a delay **after** the prior fetch completes, not a fixed period measured from request start. A 1000ms interval cannot overlap a 5000ms request through this polling path; even another concurrent trigger reuses the in-flight promise.

The new tests do not exercise `UsageCache`. They inject a mock registrar and only prove that the bootstrap forwards `5000` instead of `1000` (`apps/server/src/server.test.ts:367-386`). The test comments claim this proves non-overlap (`apps/server/src/server.test.ts:294-303`), but no request or scheduler runs in the test.

The clamp therefore changes operator-configured polling cadence and emits an overlap-prevention warning for a risk already prevented structurally. This was reported only; no code was changed.

## Minor documentation inconsistency

`packages/providers/src/minimax-usage-fetcher.ts:221-222` describes an unrecognized status as being "in the success allowlist or the known failure set," while the enclosing condition and branch mean it is in neither set. Runtime behavior and tests use the correct neither-set logic; the comment is inverted. No fix was applied.

## Actions not taken

- Did not modify any PR #347 commit.
- Did not fix lint or correctness findings.
- Did not change load-balancing behavior.
- Did not touch any live service.
- Did not push or open a PR.
