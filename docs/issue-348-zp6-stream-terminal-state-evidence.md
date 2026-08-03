# SQL Evidence Bundle — stream_terminal_state (tombii/better-ccflare #348)

**Target:** Production PostgreSQL running the `deploy/zp6` build (commit `11bf4f36`).
**Operate with:** `psql`, `pgcli`, DBeaver, pgAdmin, or any PostgreSQL client — these queries have **no client-specific syntax**.
**Read-only:** every query is a `SELECT`; no DDL, no DML, no temp tables, no background jobs.
**Window:** last 7 days, bounded by `timestamp` (BIGINT epoch **milliseconds**). All queries use `INTERVAL '7 days'` — change to `'1 day'`, `'24 hours'`, `'30 days'` as needed.

> **WHY THIS WINDOW FORM:** The schema (PostgreSQL on zp6) stores `timestamp` as `BIGINT NOT NULL` in **milliseconds**, not seconds — verified from `packages/database/src/repositories/request.repository.ts:196` which writes `Date.now()`, and from `migrations-pg.ts:94` which types the column `BIGINT`. A query that compares against `EXTRACT(EPOCH FROM NOW())` (seconds) will silently return zero rows; the operator will conclude "no data" when in reality the column is fine. All comparisons here go through `(EXTRACT(EPOCH FROM (NOW() - INTERVAL '…')) * 1000)::BIGINT` so the result is in the same units as the stored column.

> **WHY THIS COLUMN EXISTS:** `stream_terminal_state TEXT` was added on top of the original `requests` schema by `ALTER TABLE` in `packages/database/src/migrations-pg.ts:786-787`. The fresh-install `CREATE TABLE` at `migrations-pg.ts:124` also includes it. The `ON CONFLICT (id) DO UPDATE` clause uses `COALESCE(EXCLUDED.stream_terminal_state, requests.stream_terminal_state)` (`request.repository.ts:167`) — once a non-null value is written, it is **never overwritten by NULL**.

> **NON-STREAMING ROWS HAVE `NULL`:** The wrapper that records `stream_terminal_state` is only attached to `POST /v1/messages` responses that are `200 OK` with `text/event-stream` (`response-handler.ts` `isAnthropicMessagesSseResponse` gate). Every other request — non-streaming, OpenAI-compatible paths, non-Anthropic endpoints — has `stream_terminal_state = NULL`. This is by design and is the expected state for the majority of rows.

---

## 1. Pre-check — confirm the columns exist before running anything else

Run this **first**. It returns one row per *expected* column; any column that doesn't exist on the production `requests` table shows up as `status = MISSING`. Stop and report if anything is missing — the queries below will error mid-execution otherwise, and the error will not point at the missing column.

```sql
-- Strictly read-only. Uses a hardcoded list so missing columns are visible (not silently absent).
WITH expected(column_name, expected_type) AS (
    VALUES
        ('stream_terminal_state', 'text'),
        ('timestamp',             'bigint'),
        ('response_time_ms',      'integer'),
        ('status_code',           'integer'),
        ('success',               'boolean'),
        ('output_tokens',         'integer'),
        ('input_tokens',          'integer'),
        ('model',                 'text'),
        ('account_used',          'text'),
        ('agent_used',            'text'),
        ('project',               'text'),
        ('error_message',         'text'),
        ('failover_attempts',     'integer'),
        ('billing_type',          'text'),
        ('method',                'text'),
        ('path',                  'text')
)
SELECT
    e.column_name,
    e.expected_type,
    c.data_type                                                       AS actual_type,
    c.is_nullable,
    CASE
        WHEN c.column_name IS NULL                        THEN 'MISSING'
        WHEN c.data_type  <> e.expected_type              THEN 'TYPE_MISMATCH'
        ELSE 'OK'
    END                                                              AS status
FROM expected e
LEFT JOIN information_schema.columns c
       ON c.table_schema = current_schema()
      AND c.table_name   = 'requests'
      AND c.column_name  = e.column_name
ORDER BY status DESC, e.column_name;
```

**Expected:** all 16 rows with `status = 'OK'`. Any row with `status = 'MISSING'` or `'TYPE_MISMATCH'` means the prod schema is older than `zp6` — **stop and report**, the bundle below is not safe to run.

> Note: `provider`, `request_type`, `rate_limited`, and `prompt_cache_hit_tokens` are **not** columns on `requests` (verified against `migrations-pg.ts` on zp6). The cache-token column is named `cache_read_input_tokens`.

---

## 2. Control — total request rows in the window

Establishes the denominator. If this returns 0 the bundle truly had no traffic; if it returns >0 but the distribution query below returns 0 rows, the distribution query is broken.

```sql
-- Read-only; uses idx_requests_timestamp DESC.
SELECT
    COUNT(*)                                                          AS total_requests,
    MIN(to_timestamp(timestamp / 1000.0) AT TIME ZONE 'UTC')          AS earliest_in_window,
    MAX(to_timestamp(timestamp / 1000.0) AT TIME ZONE 'UTC')          AS latest_in_window,
    ((EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT)                       AS now_ms,
    ((EXTRACT(EPOCH FROM (NOW() - INTERVAL '7 days')) * 1000)::BIGINT) AS window_start_ms
FROM requests
WHERE timestamp >= ((EXTRACT(EPOCH FROM (NOW() - INTERVAL '7 days')) * 1000)::BIGINT);
```

> **Interpretation:** if `total_requests > 0` but no later query returns rows, the later query has a bug. If `total_requests = 0` and `latest_in_window` is recent, the index is fine but the window is empty. If `latest_in_window` is older than now, the proxy is not writing.

---

## 3. Distribution — counts per `stream_terminal_state` value

This is the headline query. The set of values is the closed enumeration from `packages/proxy/src/anthropic-terminal-recovery.ts:21-34` and the `saveRequest` signature in `packages/database/src/database-operations.ts:981`. `NULL` is a legitimate state (non-streaming requests, or rows written before the column existed).

```sql
-- Read-only. NULL is rendered as the literal '(unset)' for readability.
SELECT
    COALESCE(stream_terminal_state, '(unset)')  AS terminal_state,
    COUNT(*)                                    AS row_count,
    ROUND(
        100.0 * COUNT(*) / NULLIF(SUM(COUNT(*)) OVER (), 0),
        2
    )                                           AS pct_of_window
FROM requests
WHERE timestamp >= ((EXTRACT(EPOCH FROM (NOW() - INTERVAL '7 days')) * 1000)::BIGINT)
GROUP BY stream_terminal_state
ORDER BY row_count DESC;
```

**Expected categories** (per `anthropic-terminal-recovery.ts:21-34` and `database-operations.ts:981`):

| terminal_state      | meaning                                                                                  |
|---------------------|------------------------------------------------------------------------------------------|
| `complete`          | Normal SSE termination with `message_stop` received.                                     |
| `recovered`         | `message_stop` missing but a terminal delta was seen; the wrapper recovered the stream.  |
| `error`             | An explicit `error` event or upstream HTTP failure.                                      |
| `truncated`         | Mid-content TCP close without any terminal SSE event.                                     |
| `client_cancelled`  | Client aborted the request (TCP RST / ReadableStream cancel).                             |
| `(unset)` (NULL)    | Row predates the column, or path is non-streaming (most rows).                            |

> **Closure:** The TypeScript union `AnthropicTerminalState` in `anthropic-terminal-recovery.ts:21-34` is a sealed 5-value enum + `null`. There are no other string values that can ever appear in this column. The closed set is exactly the 6 rows above (including `(unset)`).

---

## 4. Detail — `client_cancelled` rows, longest first

Issue #348 specifically references `client_cancelled`. `response_time_ms` is the proxy for "how long the stream ran before the client gave up" — higher = longer-lived streams that the client killed mid-flight.

```sql
-- Read-only. LIMIT 200 keeps the result set bounded.
SELECT
    id,
    to_timestamp(timestamp / 1000.0) AT TIME ZONE 'UTC'  AS at_utc,
    response_time_ms                                    AS duration_ms,
    status_code,
    success,
    model,
    account_used,
    agent_used,
    project,
    substr(path, 1, 80)                                 AS path,
    substr(COALESCE(error_message, ''), 1, 200)         AS error_message_excerpt,
    method,
    failover_attempts
FROM requests
WHERE stream_terminal_state = 'client_cancelled'
  AND timestamp >= ((EXTRACT(EPOCH FROM (NOW() - INTERVAL '7 days')) * 1000)::BIGINT)
ORDER BY response_time_ms DESC NULLS LAST
LIMIT 200;
```

> **Note:** for `client_cancelled` rows, `success = true` is **expected** (the closure in `response-handler.ts:onClose` sets `success = state === "complete" || state === "recovered" || state === "client_cancelled"` to preserve the prior header-based success bit). Companion #7 below checks for any unusual co-occurrences.

---

## 5. Companion — distribution of `response_time_ms` for `client_cancelled`

If the detail rows are dominated by very short durations, the cancellations are coming from clients that bail immediately (e.g. wrong model, 401, user back-button). If they are long, the client is killing a slow streaming response. The shape is often the smoking gun for issue #348.

```sql
-- Read-only.
SELECT
    CASE
        WHEN response_time_ms <     1000 THEN '< 1s'
        WHEN response_time_ms <    10000 THEN '1s – 10s'
        WHEN response_time_ms <    30000 THEN '10s – 30s'
        WHEN response_time_ms <    60000 THEN '30s – 1m'
        WHEN response_time_ms <   300000 THEN '1m – 5m'
        WHEN response_time_ms <  1800000 THEN '5m – 30m'
        ELSE                                 '> 30m'
    END                                            AS duration_bucket,
    COUNT(*)                                       AS row_count,
    ROUND(AVG(response_time_ms)::numeric, 1)       AS avg_duration_ms,
    MIN(response_time_ms)                          AS min_ms,
    MAX(response_time_ms)                          AS max_ms
FROM requests
WHERE stream_terminal_state = 'client_cancelled'
  AND timestamp >= ((EXTRACT(EPOCH FROM (NOW() - INTERVAL '7 days')) * 1000)::BIGINT)
GROUP BY 1
ORDER BY MIN(response_time_ms);
```

---

## 6. Companion — `client_cancelled` count trend by hour

Bucket the cancellations by hour so the operator can see whether the rate is steady, bursting, or recently changed.

```sql
-- Read-only. Uses idx_requests_timestamp.
SELECT
    date_trunc('hour', to_timestamp(timestamp / 1000.0) AT TIME ZONE 'UTC')  AS hour_utc,
    COUNT(*)                                                                AS cancellations,
    COUNT(*) FILTER (WHERE response_time_ms > 30000)                        AS long_running_cancellations,
    COUNT(DISTINCT account_used)                                            AS distinct_accounts
FROM requests
WHERE stream_terminal_state = 'client_cancelled'
  AND timestamp >= ((EXTRACT(EPOCH FROM (NOW() - INTERVAL '7 days')) * 1000)::BIGINT)
GROUP BY 1
ORDER BY 1;
```

---

## 7. Companion — cross-tab with `success` and `status_code`

The migration's `success` column is `BOOLEAN` (verified at `migrations-pg.ts:103`). Most rows with `stream_terminal_state = 'client_cancelled'` are expected to have `success = true`, but a non-zero `success = true` count on `truncated` rows is itself evidence — the bug fixed in PR #344 was that these were being recorded as successful.

```sql
-- Read-only.
SELECT
    stream_terminal_state,
    success,
    status_code,
    COUNT(*)                                                        AS row_count
FROM requests
WHERE timestamp >= ((EXTRACT(EPOCH FROM (NOW() - INTERVAL '7 days')) * 1000)::BIGINT)
  AND stream_terminal_state IS NOT NULL
GROUP BY stream_terminal_state, success, status_code
ORDER BY stream_terminal_state, row_count DESC;
```

---

## 8. Freshness — is the proxy still writing rows?

```sql
-- Read-only. If this returns a timestamp older than ~5 minutes, the proxy
-- is not writing (or the operator is reading a stand-in / read replica).
SELECT
    MAX(to_timestamp(timestamp / 1000.0) AT TIME ZONE 'UTC')               AS last_write_utc,
    EXTRACT(EPOCH FROM (NOW() - MAX(to_timestamp(timestamp / 1000.0))))    AS seconds_since_last_write
FROM requests;
```

---

## Acceptance checklist for the operator

Before reporting results back to the issue, the operator should confirm:

- [ ] **Pre-check returned 16 rows** (all of `stream_terminal_state`, `timestamp`, `response_time_ms`, `status_code`, `success`, `output_tokens`, `input_tokens`, `model`, `account_used`, `agent_used`, `project`, `error_message`, `failover_attempts`, `billing_type`, `method`, `path`).
- [ ] **Control query** `total_requests > 0` (i.e. there is traffic in the 7-day window).
- [ ] **Distribution query** shows rows for each of the 5 known values **plus** `(unset)` if the deployment has rows from before the column existed.
- [ ] If `stream_terminal_state = 'client_cancelled'` returns 0 in the window, the issue may have been resolved already — capture the distribution CSV anyway so the trend is on record.
- [ ] **Companion #7** shows whether `client_cancelled` and `success = true` co-occur (expected) and whether `truncated` and `success = true` co-occur (this is the PR #344 regression surface).
- [ ] **Companion #5** duration buckets: if `client_cancelled` rows cluster in `< 1s`, the issue is likely client-side early-abort, not a slow-stream bug.

## Verification trail (for the record)

| Claim                                                   | Source                                                                                                                                |
|---------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------|
| `stream_terminal_state` is `TEXT`, nullable              | `migrations-pg.ts:124` (CREATE), `migrations-pg.ts:786-787` (ALTER)                                                                   |
| Closed enum: `complete / recovered / error / truncated / client_cancelled / NULL` | `anthropic-terminal-recovery.ts:21-34`, `database-operations.ts:981`, `worker-messages.ts:99-110`, `request.repository.ts:95-100`       |
| Producer is `determineTerminalState()`                  | `anthropic-terminal-recovery.ts:155-176`                                                                                             |
| `timestamp` is `BIGINT NOT NULL` in **milliseconds**    | `migrations-pg.ts:94`; written as `Date.now()` at `request.repository.ts:196`                                                        |
| Comparisons use ms arithmetic                           | `database-operations.ts:675` (`Date.now() - TIME_CONSTANTS.DAY`); `analytics.ts:91-92` (`24*60*60*1000`); `request.repository.ts:452` |
| `success` is `BOOLEAN`                                  | `migrations-pg.ts:103`                                                                                                               |
| `response_time_ms` is `INTEGER`                         | `migrations-pg.ts:104`                                                                                                               |
| Preserve-first semantics on conflict                    | `request.repository.ts:167` (`COALESCE(EXCLUDED.stream_terminal_state, requests.stream_terminal_state)`)                              |
| Index on `timestamp` for window scans                   | `idx_requests_timestamp ON requests(timestamp DESC)` from `migrations-pg.ts:138-141`                                                 |
| Wrapper only attached for `POST /v1/messages` 2xx SSE   | `isAnthropicMessagesSseResponse` gate in `response-handler.ts`                                                                       |
| `client_cancelled` → `success = true` by design         | `response-handler.ts` `onClose` closure: `success = state === "complete" || state === "recovered" || state === "client_cancelled"`   |
| PR #344 closed the regression                           | README acknowledgements, line 800                                                                                                    |