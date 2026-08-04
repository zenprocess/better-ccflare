# Q1 + Q2 Synthesis Report — PR #19 / ao-company #111

## 1. Q1 VERDICT (one line)
**Real signal — deterministic defect on salvage branch, not runner artifact or concurrent-WAL noise.** Confidence: **High**.

## 2. Q1 ROOT CAUSE (precise name)
**Missing try/catch around `PRAGMA wal_checkpoint(TRUNCATE)` in `packages/database/src/adapters/bun-sql-adapter.ts` `close()` method on the salvage branch (HEAD `c4a96892`, lines 352–357).** Main branch (HEAD `7f1a5d30`, lines 352–376) wraps the same call in try/catch + logs + carries an explanatory comment naming `SQLITE_IOERR_VNODE` (errno 6922) and the `void instance.close()` rejection path. Merge base for salvage is `053746c1` — 10 commits behind origin/main, missing `67f916eb` "fix(test): make full bun test suite reliably green (issue #107)".

Trigger chain (all confirmed in Q1 evidence):
1. Test files `unlinkSync()` the scratch DB inside `afterAll` before `DatabaseFactory.reset()`.
2. `DatabaseFactory.reset()` → `closeAll()` → `instance.close()` (un-wrapped) → `PRAGMA wal_checkpoint(TRUNCATE)` hits deleted inode → throws `SQLITE_IOERR_VNODE`.
3. `closeAll()` discards the close promise via `void instance.close()` → rejection surfaces as "Unhandled error between tests" → bun exits 1 with all 459 assertions passing.

Four triggering files (confirmed via line numbers in Q1 §3): `kilo.test.ts`, `nanogpt.test.ts`, `oauth.test.ts`, `requests.test.ts`.

## 3. Q2 VERDICT (one line)
**Staleness hypothesis REFUTED — premise does not reproduce; merge brings f3524cd9 (TMPDIR routing) correctly, but the actual 17 failures are environmental (missing auto-generated inline-* workers + 2 missing deps) and identical on both merged and un-merged branches.** Confidence: **High**.

## 4. Q2 EVIDENCE (numbers)

| Env | HEAD | pass | fail | errors | expects | SQLITE_CANTOPEN | exit |
|---|---|---|---|---|---|---|---|
| Merge (sandboxed) | `e2e53517` (origin/main + origin/ao/issue-111/salvage) | 290 | 17 | 17 | 749 | **0** | 1 |
| Salvage control (sandboxed) | `c4a96892` | 290 | 17 | 17 | 749 | **0** | 1 |
| Diff | — | 0 | 0 | 0 | 0 | **0** | 0 |

Merge base merged-branch = `7f1a5d30` (exact origin/main tip). Merge base un-merged salvage = `053746c1` (10 commits stale).

**All 17 failures are 4 module-resolution errors, NOT SQLITE_CANTOPEN:**
- `./inline-integrity-check-worker` from `packages/database/src/integrity-check-runner.ts`
- `./inline-incremental-vacuum-worker` from `packages/database/src/database-operations.ts`
- `@aws-sdk/client-bedrock-runtime` from `packages/providers/src/providers/bedrock/provider.ts`
- `@better-ccflare/providers/qwen` from `packages/cli-commands/src/commands/account.ts`

The first two are listed in project CLAUDE.md as never-touch auto-generated build artifacts (present after `bun run build`). The last two are missing packages from the throwaway worktree's borrowed node_modules.

Merge content (10 files, all additive new functionality in target dirs): `packages/config/src/{alerts-config.test,index}.ts`, `packages/http-api/src/handlers/{alerts,insights}.ts`, `packages/http-api/src/services/__tests__/{anomaly-insights,auth-failure-alert}.test.ts`, `packages/http-api/src/services/{alerts,anomaly-insights}.ts`, `packages/types/src/{alerts,insights}.ts`. Plus 13 commits from origin/main including `67f916eb` (VNODE try/catch fix) and `f3524cd9` (TMPDIR routing fix). Also moves 9 upstream workflows to `.github/workflows-disabled/` and 2 helper scripts to `.github/scripts-disabled/`.

## 5. CROSS-CHECK Q1 ↔ Q2

| Axis | Q1 | Q2 | Match? |
|---|---|---|---|
| Branch | salvage (`c4a96892`) | merge (`e2e53517`) + salvage control (`c4a96892`) | branch overlap on salvage control |
| Working dir | `/tmp/claude-501/q1-salvage` (TMPDIR redirected) | `/tmp/claude-501/verify-ccflare-111-wt` + `/tmp/claude-501/q2-salvage` (TMPDIR set) | both use private TMPDIR |
| Files loaded | 42 | same failing-file set across Q2's two runs | Q2 does not report total file count |
| Test count | 459 | 307 | Q2 stops before more tests run because module imports fail |
| Assertion count | 1227 | 749 | Q2 runs fewer assertions |
| Trigger test files (kilo/nanogpt/oauth/requests) | `fail=0` + 4 VNODE errors → exit 1 | Q2 reports 17 failing test files collectively, not an enumerated per-file intersection | cannot establish exact file-set consistency from supplied reports |

**Reproduction-domain mismatch:**
- Q1's diagnostic run modified the seven hardcoded `/tmp/test-*.db` paths in a throwaway salvage worktree so that tests reached SQLite open and all 459 tests ran.
- Q2 used separate throwaway merge and salvage-control worktrees without a build; imports failed before the DB-open code path, yielding 290 pass / 17 fail / 307 total.
- Therefore Q1 and Q2 did not exercise the same executable path. Q1 reached DB teardown; Q2 stopped at module resolution for 17 test files.

**File-list cross-check:**
- Q1 reports that sandboxed and unsandboxed runs load the same 42 files; no files appeared only in unsandboxed execution. The 152-test difference was 20 SQLITE_CANTOPEN failures plus approximately 11 follow-on tests skipped after `beforeAll` failed, not file discovery.
- Q1 names four teardown-error files: `kilo.test.ts`, `nanogpt.test.ts`, `oauth.test.ts`, `requests.test.ts`.
- Q1 does not enumerate the seven hardcoded-`/tmp` files or the exact 20 SQLITE_CANTOPEN tests.
- Q2 reports zero SQLITE_CANTOPEN in both runs and does not enumerate the 17 failing test files; it only states they are under handler/service test directories and identifies four import errors.
- Thus the supplied evidence does **not** establish that Q2's merge cleared the same N files/tests described by Q1. It establishes that the Q2 merge and control were identical under Q2's module-resolution-limited environment.

## 6. PR #19 SAFETY

**YES — safe to merge with respect to the Q1 defect; Q2 does not provide a clean full-suite pass.** Evidence:

1. **Q1's root cause is salvage-specific and is resolved by the merge.** The VNODE bug exists on salvage because salvage forked at `053746c1` and missed `67f916eb`. The merge brings `67f916eb` in (Q2 confirms merge-base = `7f1a5d30`, exact origin/main tip), so `close()` on the merged branch has the try/catch that catches VNODE and warns instead of throwing.
2. **Q2 shows no merge-induced change in its environment.** Merge and un-merged salvage produce byte-identical numeric summaries (290/17/17/749) and identical failing-file sets.
3. **Q2's 17 failures are environmental in both branches.** They arise from four module-resolution errors caused by absent generated workers and missing packages in the throwaway worktrees.
4. **Limitation:** Q2 did not run a built dependency-complete worktree and therefore does not prove a full green merged suite. It refutes its reproduced staleness premise and shows no relative regression under its environment.

## 7. ACTION ITEMS

1. Discard the "concurrent-WAL noise" framing. Q1 reproduces the VNODE error deterministically on each of four single test files.
2. Do not claim Q2 proved that 20 SQLITE_CANTOPEN tests cleared. Q2 observed zero such errors in both branches and exercised a different, earlier failure path.
3. Before merging PR #19, run the normal dependency-complete build/test pipeline and verify:
   - generated inline workers exist through `bun run build` (never edit them manually),
   - the four module-resolution errors are absent,
   - the four VNODE errors do not produce unhandled errors because `67f916eb` is present,
   - the suite exits 0.
4. If the dependency-complete merged suite is green, merge PR #19. No Q1-specific code change is needed beyond retaining main's `67f916eb` fix.
5. Track the fragile `unlinkSync → DatabaseFactory.reset()` teardown order separately; the structural improvement is to close before unlinking.

## 8. REAL NUMBERS TABLE

| Metric | Q1 environment (salvage, paths redirected to writable TMPDIR) | Q2 merge (`e2e53517`) | Q2 salvage control (`c4a96892`) |
|---|---|---|---|
| pass | 459 | 290 | 290 |
| fail | 0 | 17 | 17 |
| expect() | 1227 | 749 | 749 |
| errors | 4 | 17 | 17 |
| SQLITE_CANTOPEN | not reported | 0 | 0 |
| exit | 1 | 1 | 1 |
| tests reported | 459 | 307 | 307 |
| Q1 VNODE fix present | NO | YES | NO |
| TMPDIR routing commit present | NO (diagnostic path rewrite) | YES | NO |

## 9. SOURCES (absolute paths)

Q1 reproduction artifacts:
- `/private/tmp/claude-501/-Users-vvladescu--ao-data-worktrees-ccflare-ccflare-147/0c8e4d3f-9e68-51b5-93da-021563066bf1/scratchpad/q1-salvage-pathtmp.stdout`
- `/private/tmp/claude-501/-Users-vvladescu--ao-data-worktrees-ccflare/ccflare-147/0c8e4d3f-9e68-51b5-93da-021563066bf1/scratchpad/q1-salvage-pathtmp.stderr`
- `/private/tmp/claude-501/-Users-vvladescu--ao-data-worktrees-ccflare/ccflare-147/0c8e4d3f-9e68-51b5-93da-021563066bf1/scratchpad/q1-salvage-pathtmp-exit.txt` (EXIT=1)

Q2 reproduction artifacts:
- `/private/tmp/claude-501/-Users-vvladescu--ao-data-worktrees-ccflare/ccflare-147/0c8e4d3f-9e68-51b5-93da-021563066bf1/scratchpad/q2-merge.stdout`
- `/private/tmp/claude-501/-Users-vvladescu--ao-data-worktrees-ccflare/ccflare-147/0c8e4d3f-9e68-51b5-93da-021563066bf1/scratchpad/q2-merge.stderr`
- `/private/tmp/claude-501/-Users-vvladescu--ao-data-worktrees-ccflare/ccflare-147/0c8e4d3f-9e68-51b5-93da-021563066bf1/scratchpad/q2-merge-exit.txt` (EXIT=1)
- `/private/tmp/claude-501/-Users-vvladescu--ao-data-worktrees-ccflare/ccflare-147/0c8e4d3f-9e68-51b5-93da-021563066bf1/scratchpad/q2-salvage-control.stdout`
- `/private/tmp/claude-501/-Users-vvladescu--ao-data-worktrees-ccflare/ccflare-147/0c8e4d3f-9e68-51b5-93da-021563066bf1/scratchpad/q2-salvage-control.stderr`
- `/private/tmp/claude-501/-Users-vvladescu--ao-data-worktrees-ccflare/ccflare-147/0c8e4d3f-9e68-51b5-93da-021563066bf1/scratchpad/q2-salvage-control-exit.txt` (EXIT=1)

Report copies:
- `/private/tmp/claude-501/-Users-vvladescu--ao-data-worktrees-ccflare/ccflare-147/0c8e4d3f-9e68-51b5-93da-021563066bf1/scratchpad/q1-q2-verify-report.md`
- `/Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-147/docs/reviews/verify-ccflare-111.adversarial.md`
