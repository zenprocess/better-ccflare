# Follow-up for tombii/better-ccflare#383 — status of #383 + chain fix on upstream/main

Prepared for the orchestrator to post as a follow-up comment on
tombii/better-ccflare#383 after review. Do **not** auto-post.

## Context

- tombii merged PR #389 ("fix(database): widen instance_heartbeats
  timestamps to bigint on PostgreSQL", commit `cd4abcff`) on
  2026-08-06. The merge body says `Fixes #383`, which auto-closed the
  issue at 21:20:43Z.
- tombii reopened #383 sixteen seconds later at 21:20:59Z with no
  accompanying comment.
- tombii then referenced commit `1f8084938c7ce4ba11b6c9ab990a01b20f757bae`
  on the issue — the refuse-path heartbeat-cleanup retry from the
  reporting deployment's companion fix, merged upstream as PR #387
  (merge `dbe16cc5`) at 23:23:49Z the same day.
- The reporting deployment's earlier comment on #383
  (2026-08-06T14:21:57Z) identified the #383 × #376 bug chain
  explicitly and told tombii the schema fix alone was insufficient.

## Fixed / not-fixed evidence (read against upstream/main HEAD)

| Reported symptom | Status | Evidence on upstream/main |
| --- | --- | --- |
| `integer out of range` crash loop on first PG heartbeat | Fixed | `packages/database/src/migrations-pg.ts:348-358` declares `started_at BIGINT NOT NULL, last_heartbeat BIGINT NOT NULL` in `ensureSchemaPg` (new installs) |
| `ALTER COLUMN ... TYPE bigint` migration for existing PG deployments | Fixed | `packages/database/src/migrations-pg.ts:1196-1240` runs an idempotent `ALTER TABLE instance_heartbeats ALTER COLUMN ... TYPE bigint`, gated on `columnDataType(...) === "integer"`, errors propagated (no silent swallowing) |
| Orphan rows from crash-looping pre-fix incarnations | Fixed (scoped, not blanket) | `packages/database/src/migrations-pg.ts:1233-1238` purges only rows with `started_at < 946684800000 OR last_heartbeat < 946684800000` (year-2000 cutoff). int4 overflow wraps epoch-ms (~1.79e12) to negative values, so garbage rows are caught and any peer-written `Date.now()` is preserved. Documented in the inline comment as the reason for the scoping. |
| Secondary `RangeError: Invalid Date` in peer listing | Fixed | `packages/database/src/multi-instance-guard.ts:370-378` — `formatGuardMessage` now wraps `new Date(p.last_heartbeat).toISOString()` in `Number.isFinite(...)`, falling back to `String(p.last_heartbeat)` for non-finite values |
| Chain bug: refuse-path cleanup leaves phantom heartbeat (PR #376 Greptile P1) | Fixed | `packages/database/src/multi-instance-guard.ts:247-281` introduces `clearHeartbeatWithRetry` (3 attempts, 25/50/100ms exponential backoff). Used at `multi-instance-guard.ts:351` in the refuse-path cleanup. If all retries fail the original `MultiInstanceRefusedError` is still surfaced and the orphan expires naturally on the next `purgeStaleHeartbeats` sweep. |
| "Worth grepping for the same INTEGER-vs-epoch-ms mismatch on any other PG table that stores `Date.now()`" | Verified clean | `git grep -n INTEGER` over `packages/database/src/migrations-pg.ts` returns only counters (request_count, status_code, response_time_ms, token counts, etc.). No second timestamp-storage instance of this bug class exists in the PG migration. |

From the diff read, every symptom the reporting deployment raised
directly on #383 — primary crash loop, secondary `Invalid Date`,
migration path, orphan-row cleanup, and the chain fix surfaced in the
later comment — is resolved on upstream/main. No new defect surfaced
during the read that the two PRs leave on the table.

## Reopen hypothesis

Candidates considered:

1. **Hold-for-release.** Weak support. The release system typically
   auto-closes on merge of a "Fixes" PR. Tombii has not re-closed
   after PR #387, but there is no public release-tag pointer to
   confirm a version-gated hold.
2. **Accidental reopen (button misclick).** Very weak. The reopen
   happened 16 seconds after the auto-close and the same actor then
   explicitly referenced commit `1f808493` on the issue. An accidental
   reopen does not normally come with a targeted commit reference on
   the very next action.
3. **Known remaining sub-issue — the chain fix.** Strong support.
   The reporting deployment's earlier comment on #383 explicitly
   stated that PR #389 alone was not enough and pointed to the
   refuse-path cleanup retry as the companion fix. Tombii's reopen
   landed almost immediately, then tombii bookmarked `1f808493`
   (the chain-fix commit) on the issue. PR #387 later merged the
   exact same commit. The reopen therefore reads as "keep #383 open
   until both halves of the chain are in main."

Best-supported hypothesis: **(3) — tombii reopened because the chain
analysis comment told them the schema fix alone was insufficient,
and tombii was tracking the refuse-path cleanup retry as the
companion landing.** Now that PR #387 has shipped, the original
intent of the reopen has been satisfied, but the issue has not been
re-closed.

Evidence does not distinguish with certainty between (3) and a
combined (3)+(1) (hold until a tagged release ships both fixes).
The follow-up asks tombii rather than guess.

## Public-repo hygiene

This document and the fenced draft below contain no internal
identifiers. Verified by:

```
git grep -nE "zp\.digital|ccmax|ccproxy|/Users/|\.ao/data|worktrees/ccflare|ccflare-[0-9]{2,4}" -- docs/reviews/issue-383-followup-draft.md
```

returns no matches. The reporting deployment is referred to only as
"the reporting deployment".

## Draft comment (to be posted by the orchestrator after review)

```text
Quick follow-up — read the current state of upstream/main and
wanted to flag what we see so we don't burn your time.

Verified fixed on main (read against the merged diffs of #389 and
#387, plus the files as they stand):

- New PG installs create `instance_heartbeats.{started_at,last_heartbeat}` as
  BIGINT (`packages/database/src/migrations-pg.ts` in `ensureSchemaPg`).
- The widening migration for existing PG deployments is idempotent,
  error-propagating, and gated on the column still being `integer`.
- Orphan cleanup is scoped to garbage rows (epoch-ms values outside
  any plausible range), not a blanket delete, so it can't wipe a
  peer's freshly-written row.
- `formatGuardMessage` is guarded against non-finite timestamps, so
  stale garbage rows no longer throw `RangeError: Invalid Date`.
- The refuse-path cleanup from the earlier chain analysis uses the
  retry helper with bounded backoff; if all retries fail the
  original refusal is still surfaced and the orphan expires on the
  next purge sweep.

I also re-grepped `migrations-pg.ts` for the same INTEGER-vs-epoch-ms
pattern on any other timestamp column — no second instance of this
class on the PG side.

So from this end everything in #383 and the #383 × #376 chain
comment is covered. Given you reopened at the moment the chain fix
became the only open piece, and that fix has since landed: is there
something specific still keeping #383 open on your side (e.g.
waiting on a tagged release that ships both PRs), or is it good to
close? Happy to take any follow-up you flag.
```