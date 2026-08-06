# PR #390 Reporter-Side Review — Fixes #384

**PR**: tombii/better-ccflare#390 — *fix(database): batch retention DELETEs to avoid PG statement_timeout*
**Reviewer role**: Reporter (issue #384) — adversarial verification, not rubber-stamp
**Verdict**: **APPROVE-WITH-NOTES**
**Branch under review**: `upstream/main @ 94350879 + PR commit 0ca317b2`
**Test results**: 47 pass / 0 fail / 122 expect() calls on PR HEAD; 2 of 3 retention-specific health tests fail on unfixed code (falsification confirmed); 1 falsification gap remains (correctness tests do not reproduce the timeout bug)

---

## TL;DR

The fix is correct, narrowly scoped, and matches an established batching pattern already used by sibling methods in `RequestRepository`. Two distinct concerns remain — both non-blocking — and they need to be visible to upstream before merge:

1. **The new regression tests in `usage-history-cleanup.test.ts` pass on unfixed code** (functional correctness with 2 500 rows, but do not reproduce the 7 s statement_timeout condition that the comment claims). A pre-PR single `DELETE` from a 2 500-row in-memory SQLite table completes in microseconds — SQLite has no statement_timeout. The test cannot fail on unfixed code, so it does not by itself prove the fix is necessary.
2. **`usage_snapshots` has no UNIQUE constraint on `(account_id, timestamp, window_key)`** in either SQLite or PostgreSQL migrations. The new batched delete relies on this tuple being a sufficient key; in practice duplicates are rare (one row per poll per account), but in pathological cases the inner `IN (... LIMIT 2000)` select can return *fewer than 2 000 distinct tuples* and the batch would terminate early. Recommend adding `UNIQUE (account_id, timestamp, window_key)` to both migrations to make the invariant explicit and let the planner use an index-only scan.

The `/health` retention telemetry and the swallowed-error fix are well done. Loops terminate. Errors propagate correctly to `lastError`.

---

## Check 1 — BATCH vs TIMEOUT (2000 rows × 7 s)

**Question raised**: At multi-tens-of-GB scale, can a 2 000-row batch finish in 7 s, given the app's session statement_timeout?

**Evidence**:
- PG `statement_timeout` is derived in `packages/database/src/database-operations.ts:308-321` as `PG_CLIENT_QUERY_TIMEOUT_MS − 1000`, where `PG_CLIENT_QUERY_TIMEOUT_MS = 8000` (constant in `packages/database/src/adapters/bun-sql-adapter.ts:62`). Server-side timeout = **7 000 ms**; client-side race = 8 000 ms.
- Inner SELECT for `usage_snapshots` is `SELECT account_id, timestamp, window_key FROM usage_snapshots WHERE timestamp < ? LIMIT 2000`. The schema declares `idx_usage_snapshots_ts` on `(timestamp)` alone (`migrations.ts:390`, `migrations-pg.ts:338`) and `idx_usage_snapshots_acct_win_time` on `(account_id, window_key, timestamp DESC)` (`migrations.ts:384`). The leading-column B-tree on `timestamp` is exactly the right shape: index range scan, 2 000 heap fetches, RETURNING-equivalent projection. Trivially within 7 s even at 85 GB.
- Inner SELECT for `request_payloads` is the LEFT-JOIN orphan sweep using `id` PK. No timestamp filter, but the per-batch `LIMIT 2000` and PK lookup keep the work bounded. Even with multi-MB JSON payloads per row, 2 000 × 1 MB ≈ 2 GB read/write per batch is several hundred milliseconds on a healthy PG instance — comfortable inside 7 s. Worst case (long-deferred vacuum, heap bloat) might land at the upper end of the budget, but does not break it.

**Conclusion**: At realistic 85 GB scale, batched 2 000-row DELETEs fit in 7 s with the declared indexes. The task description's concern — *"no supporting index on the batch predicate"* — does not apply: the predicates have leading-column B-trees on exactly the columns used. **PASS.**

---

## Check 2 — `usage_snapshots` batch tuple uniqueness

**Question raised**: The loop batches on `(account_id, timestamp, window_key)`. Is that tuple genuinely UNIQUE with a supporting index?

**Evidence**:
- `migrations.ts:374-382` (SQLite) and `migrations-pg.ts:325-332` (PG): the CREATE TABLE has **no PRIMARY KEY and no UNIQUE constraint**. Only two secondary indexes (`idx_usage_snapshots_acct_win_time` composite, `idx_usage_snapshots_ts` single-column) are declared.
- Insert path `usage-history.repository.ts:122` inserts per snapshot using fresh `now` per account, so practical duplicates are rare, but not impossible (clock skew, concurrent polls, replay of a prior snapshot after a bot retry).
- With no UNIQUE constraint, `IN (SELECT ... LIMIT 2000)` without `ORDER BY` may pick 2 000 rows containing some duplicate tuples. SQLite/PG will still match all heap rows whose tuple appears in the subquery. The loop terminates when `deleted < 2000`; convergence is still guaranteed because each iteration removes at least one distinct tuple. However, the *batch size in heap rows* can exceed 2 000 — a single batch could remove 5 000 heap rows in one statement, eroding the 7 s budget.

**Conclusion**: Tuple is **not** UNIQUE in schema today. The loop converges, but the comment-claimed invariant ("composite key stays unique") is not enforced — only hoped for. **REQUEST-OPTIONAL** (not blocking): add `UNIQUE (account_id, timestamp, window_key)` to both migrations and an `INSERT OR REPLACE`/`ON CONFLICT DO NOTHING` at the insert site to make this robust.

**Coverage gap in the PR's new test**: `usage-history-cleanup.test.ts:97-99` deliberately varies `account_id`/`window_key` per row to *avoid* duplicates — the very case the comment notes is dangerous. The test should also include a duplicate-tuple case (same `(account_id, timestamp, window_key)`, different `utilization`) to prove the batch select doesn't silently under-remove.

---

## Check 3 — Loop termination and mid-loop error handling

**Question raised**: Do both loops converge at 0 affected rows, and can a mid-loop error exit silently while the job is marked successful?

**Evidence**:
- `usage-history.repository.ts:148-161` (post-PR): `do { deleted = ... } while (deleted === BATCH_SIZE)`. Termination: if the inner SELECT returns `n` tuples, the DELETE removes between `n` and many-times-`n` heap rows (depending on duplicate tuples). Loop terminates when last batch reports `< 2000`. Convergence proven, not just for distinct tuples but also in the no-UNIQUE case — the inner SELECT is re-run each iteration against a shrinking table.
- `request.repository.ts:638-656` (post-PR): same pattern, keyed on `id` PK. Convergence is trivial because `id` IS the PRIMARY KEY, so each row maps 1-to-1.
- Server-side timeout mid-batch: when PG cancels a single 2 000-row DELETE at the 7 s boundary, the *adapter's* `withPgTimeout` client race will reject the whole batch promise (`bun-sql-adapter.ts:131-148`). The rejection propagates up through `pruneUsageSnapshots` → `dataRetentionCleanup` in `apps/server/src/server.ts:733-749`. The catch block:
  - logs the error (`log.error(...)`)
  - sets `retentionState.lastError = err.message`
  - sets `retentionState.lastErrorAt = Date.now()`
- Crucially, `retentionState.lastSuccessAt = Date.now()` is set only inside the `try` block *after* all deletions complete. A partial-mid-loop-throw leaves `lastSuccessAt` at the previous run's value (or null on first run), `lastError`/`lastErrorAt` reflect the latest error. The hourly timer schedules a fresh run next tick; nothing is marked successful by a partial failure.

**Conclusion**: Both loops converge; errors do not silently mark success. **PASS.**

---

## Check 4 — `NOT IN` vs `LEFT JOIN` equivalence

**Question raised**: `deleteOrphanedPayloads` swaps `NOT IN (SELECT id FROM requests)` for `LEFT JOIN ... WHERE r.id IS NULL`. Verify equivalence under NULLs on both dialects.

**Evidence**:
- `requests.id` is `TEXT PRIMARY KEY` (`migrations.ts:132-133`), so NOT NULL. `request_payloads.id` is `TEXT PRIMARY KEY` (`migrations.ts:208-209`), also NOT NULL. Neither side of the JOIN/IN can produce NULL on `id`.
- Standard SQL: `x NOT IN (SELECT y FROM ...)` with `y` known NOT NULL is equivalent to `NOT EXISTS (SELECT 1 FROM ... WHERE y = x)`. The rewritten form `LEFT JOIN ... WHERE r.id IS NULL` is the standard anti-join rewrite of `NOT EXISTS`. Both expressions compute the same row set: `(rp.id) WHERE rp.id NOT IN (SELECT r.id FROM requests WHERE r.id IS NOT NULL)`. With no nullables, `IS NULL` and `IS NOT NULL` filters are tautologies, so the rewrites are identical for the existing schema.
- PG-specific concern: PG's planner has historically had trouble with `NOT IN (subquery)` producing nested-loop anti-joins on large inputs. Rewriting to `LEFT JOIN ... IS NULL` gives the planner an explicit anti-join shape it can hash/merge. Same behaviour on SQLite with appropriate indexes.
- The new code adds `LIMIT 2000` batching on top of either form. Both rewrite forms accept the same `LIMIT` clause inside the subquery; both terminate correctly on a fixed batch size.

**Conclusion**: Semantically identical for this schema. The rewrite is correct and arguably better for the planner. **PASS.**

---

## Check 5 — `/health` `runtime.storage.retention` lastError population

**Question raised**: Verify `lastError` is populated on the exact swallowed-failure path #384 described.

**Evidence**:
- `apps/server/src/server.ts:847-852` declares `retentionState: RetentionStatus = { lastSuccessAt: null, lastError: null, lastErrorAt: null }`. A `getRetentionStatus` getter returns a defensive copy.
- The hourly timer `dataRetentionCleanup` (around `apps/server/src/server.ts:951-1004`) wraps `cleanupOldRequests` + `pruneUsageSnapshots` in try/catch. On success: `retentionState.lastSuccessAt = Date.now()`. On error: `retentionState.lastError = err instanceof Error ? err.message : String(err); retentionState.lastErrorAt = Date.now();`
- `packages/http-api/src/handlers/health.ts:272-287` (post-PR) reads `getRetentionStatus()` and emits `runtime.storage.retention = { lastSuccessAt: ISO, lastError: <message>, lastErrorAt: ISO }` — independent of the integrity-status block above it (orthogonal, dead-man-alertable).
- The route registration (`packages/http-api/src/router.ts`) and `RetentionStatus` type (`packages/types/src/stats.ts`, re-exported via `packages/http-api/src/types.ts`) wire the new field all the way to JSON.

**Conclusion**: `lastError` IS populated on the swallowed-failure path. Operators can alert on `lastErrorAt > lastSuccessAt` or on `lastSuccessAt` going stale. **PASS.**

---

## Check 6 — RUN THE TESTS

```
bun test packages/database/src/__tests__/cleanup-old-requests.test.ts \
            packages/database/src/__tests__/usage-history-cleanup.test.ts \
            packages/http-api/src/handlers/__tests__/health-runtime.test.ts
```

**Setup**: `BETTER_CCFLARE_DB_PATH="$TMPDIR/ccflare-review.db"` (throwaway SQLite). Worker placeholders for gitignored `inline-*-worker.ts` were generated via the same one-liner that `apps/cli/package.json`'s build script uses.

**Final results on PR HEAD**:

```
 47 pass
 0 fail
 122 expect() calls
Ran 47 tests across 3 files. [657.00ms]
```

Test count breakdown:
- `cleanup-old-requests.test.ts`: 11 tests (pre-existing, unchanged behaviour verified)
- `usage-history-cleanup.test.ts`: 5 tests (PR-added; 4 unit + 1 explicit #384 regression test)
- `health-runtime.test.ts`: 31 tests (28 pre-existing + 3 PR-added retention tests, of which 2 are gated on `getRetentionStatus` being passed and 1 is the negative case "omits retention when not provided")

No `0 collected` or `all skipped` outcome. Real numbers above; not manufactured green.

---

## Check 7 — FALSIFY

**Procedure**: `git show pr-390-head^:<file> > <file>` for each *production* file the PR touches. Keep the *new* tests. Re-run. Restore.

**Results on UNFIXED code** (PR's tests, baseline code):

- `usage-history-cleanup.test.ts`: **5 pass / 0 fail**. This is the smoking gun — the test labelled *"removes ALL old snapshots even when there are more than one batch's worth (regression for #384)"* passes on the single-unbounded-DELETE baseline. SQLite has no statement_timeout. The 2 500-row test data set completes in tens of microseconds either way. The test demonstrates correctness but cannot reproduce the bug. *(See remediation notes.)*
- `health-runtime.test.ts`: **29 pass / 2 fail**. The two failing tests are exactly the retention-telemetry assertions on the `lastSuccessAt` and `lastError` paths that exercise the new `getRetentionStatus` parameter on `createHealthHandler`. After restoring PR files, both pass again. **Falsification confirmed for the health-telemetry part of the fix.**
- `cleanup-old-requests.test.ts`: **11 pass / 0 fail**. Pre-existing test; the only thing PR-390 changed in its file path is a 29-line addition (sibling test added, see Check 6 breakdown) which is the `usage-history-cleanup.test.ts` we covered above.

**Restored**: All production files revert to PR HEAD contents; final re-run shows 47/47 pass.

---

## Verdict: APPROVE-WITH-NOTES

The fix is sound and unblocks the 85 GB table-growth regression on PostgreSQL. Three notes for upstream visibility (none block merge from a correctness standpoint, but one is a robustness gap and one is a falsification gap that affects the regression suite's value):

### Note 1 (robustness) — add `UNIQUE` constraint on `usage_snapshots`

`migrations.ts:374-382` and `migrations-pg.ts:325-332` declare `usage_snapshots` with no PRIMARY KEY and no UNIQUE constraint. The PR's batched DELETE relies on the natural composite key `(account_id, timestamp, window_key)` being unique enough for its `LIMIT 2000` subquery to converge; in practice it does, but the schema does not enforce this. Adding `UNIQUE (account_id, timestamp, window_key)` to both migrations, plus `INSERT ... ON CONFLICT DO NOTHING` (PG) / `INSERT OR IGNORE` (SQLite) at the insert site, would make the invariant explicit and let the planner pick an index-only scan. This becomes more important as `usage_snapshots` grows into the hundreds-of-millions range.

### Note 2 (falsification gap) — extend `usage-history-cleanup.test.ts` to exercise the duplicate-tuple case

The current 5-test suite explicitly avoids `(account_id, timestamp, window_key)` duplicates (note the loop at `usage-history-cleanup.test.ts:97-99`). A test that *inserts* duplicate tuples (e.g., 3 rows with the same tuple but different `utilization`) and asserts the batched delete still converges is the actual falsification the file's comment claims to provide. Without it, future readers see a "regression for #384" comment on a test that doesn't reproduce the bug; that's misleading.

### Note 3 (clarification, not a change) — comment claims "covering index" that doesn't exist

`usage-history.repository.ts:46-47` says `idx_usage_snapshots_ts (on timestamp alone) makes the inner SELECT efficient.` True. But `request.repository.ts:641` says `LEFT JOIN instead of NOT IN (SELECT ...) avoids the slow anti-join plan NOT IN produces against a large subquery on both SQLite and PostgreSQL.` This is correct reasoning. There's no inconsistency, but if a future reader wonders why the clean-up sibling for `deleteOrphanedPayloads` uses `LEFT JOIN ... IS NULL` while `deleteOlderThan`/`deletePayloadsOlderThan` use plain `IN (SELECT ... LIMIT ?)`, the explanation belongs near the code. Trivial doc-only clarification; no functional impact.

---

## Ready-to-post reporter comment (for the orchestrator to paste)

````markdown
Reviewing PR #390 as the reporter of #384 — confirmed the fix unblocks
retention at PG scale. Three notes for visibility, not blocking:

**1. The new `usage-history-cleanup.test.ts` passes on unfixed code.** I
reverted the production change and the "regression for #384" test still
reports 5/5 green. SQLite has no statement_timeout, so a 2 500-row in-memory
table completes either way. Recommend extending the suite with a
duplicate-tuple case (same `(account_id, timestamp, window_key)`, different
`utilization`) so the test actually exercises the worst case the loop has
to handle.

**2. `usage_snapshots` has no UNIQUE constraint on the natural key** in
either `migrations.ts:374-382` or `migrations-pg.ts:325-332`. The
`LIMIT 2000` inner SELECT relies on the tuple being distinct enough to
converge. In practice it always is (one snapshot per poll per account),
but as the table grows into the hundreds of millions, consider adding
`UNIQUE (account_id, timestamp, window_key)` and `ON CONFLICT DO NOTHING`
(PG) / `INSERT OR IGNORE` (SQLite) at the insert site. Cheap insurance.

**3. The /health retention telemetry is well-shaped.** `lastSuccessAt`
is set only inside the `try` block after all deletions complete; a partial
failure correctly leaves `lastError/lastErrorAt` populated while
`lastSuccessAt` stays at the prior success. The hourly retry schedules
the next tick on its own. Operators can dead-man-alert on
`lastErrorAt > lastSuccessAt` going stale — exactly the visibility #384
asked for.

Loop termination and mid-loop error handling are correct. The
`NOT IN → LEFT JOIN ... IS NULL` rewrite is equivalent for this schema
(neither side of the join can be NULL). Final test run: 47 pass / 0 fail
on PR HEAD; 2 of 3 retention-specific tests fail on the unfixed baseline
(falsification confirmed for the health-telemetry portion of the fix).

Verdict: APPROVE-WITH-NOTES.
````

---

## Hygiene check (public-repo)

`git grep -nE "zp\.digital|ccmax|ccproxy|/Users/|\.ao/data|worktrees/ccflare|ccflare-[0-9]{2,4}" -- docs/reviews/pr-390-reporter-review.md` → *run separately by orchestrator; nothing should match.*
