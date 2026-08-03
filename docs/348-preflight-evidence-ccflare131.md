# tombii/better-ccflare #348 — companion to ccflare-129 runbook

Authored for the operator's upgrade of `ccmax` then `ccproxy2` from
`v3.5.44+zp6` to `v3.5.46`, the upstream release that ships PR #360's
three commits:

- `fd389fd2` — `fix: abort the upstream fetch when the client disconnects`
  (`packages/proxy/src/handlers/request-handler.ts` — `AbortSignal.any([callerSignal, timeoutController.signal])`, `signal: req.signal` threaded everywhere in `proxy-operations.ts`).
- `cec5b5b9` — `fix: end the request on client disconnect instead of failing over`
  (`packages/proxy/src/handlers/proxy-operations.ts` `proxyWithAccount` catch — `if (req.signal.aborted) return new Response(null, { status: 499 })`).
- `23cf0cea` — `feat: expose the stream terminal state through the API`
  (`packages/http-api/src/handlers/requests.ts:135 / :363` surfaces
  `streamTerminalState`; `packages/types/src/request.ts:181` adds it to
  `RequestResponse`; persistence via `stream_terminal_state` column in
  both `migrations.ts:160` and `migrations-pg.ts:124`).

`v3.5.46` is reachable from all three commit hashes (`git tag --contains fd389fd2/cec5b5b9/23cf0cea` → `v3.5.45`, `v3.5.46`). All three live in the
shipped tag.

Authoring only — egress to `ccmax` / `ccproxy2` is permanently closed from
this session. The operator runs the commands.

---

## PART 1 — PRE-FLIGHT (BEFORE the operator starts)

Each item is "what must be true / what to capture" so an unsafe upgrade is
stopped at the gate instead of mid-rollout. Checks are from the repo at the
target release.

### 1.1 Identity of the target build

- `version` MUST equal `3.5.46` and `git_sha` MUST lie on `v3.5.46`
  (`git tag --contains <git_sha>` returns `v3.5.46`). Pulled from
  `/health` on a freshly started container, NOT from the registry tag
  name — the registry tag is mutable.
- The image carries `org.opencontainers.image.revision`,
  `…image.version=3.5.46`, `…image.created`, `…image.base.digest`. Verify
  via `docker inspect --format '{{index .Config.Labels …}}' <container>`.

### 1.2 Database backend expectation (the one that bit us last time)

- Production backend is **PostgreSQL** via `DATABASE_URL=postgres://…`
  (`docs/configuration.md:122` / `docs/deployment.md:803-911`,
  `packages/database/src/database-operations.ts:282-330`).
- The PG-specific bug class from the previous break was invisible on
  SQLite (different adapter, different pool, different SQLSTATE paths —
  `ERR_POSTGRES_UNSUPPORTED_INTEGER_SIZE`, `ERR_POSTGRES_IDLE_TIMEOUT`,
  the `BETTER_CCFLARE_DB_PG_PREPARE=false` default for `oven-sh/bun#16774`).
  An SQLite rehearsal against the same migration is **not** evidence the
  PG path is safe.
- Capture before the upgrade:
  - `pg_dump --schema-only --no-owner $DATABASE_URL > schema-pre.db` (the operator runs; we don't have the URL).
  - `requests` table must already carry `stream_terminal_state TEXT`
    (column name) on the production DB, OR the upgrade will `ALTER TABLE`
    it via `runMigrationsPg()` at first start. Confirm by
    `\d requests | grep stream_terminal_state` (operator).
- `BETTER_CCFLARE_DB_STATEMENT_TIMEOUT` defaults to `7000` ms (clamped
  below the 8000 ms client race — `docs/configuration.md:221`). Do not
  silently raise it; the timeout is what stops a runaway query from
  poisoning the pool.

### 1.3 Env vars that MUST survive the upgrade (i.e. do not re-default)

These are deliberate operator choices on `ccmax` / `ccproxy2`. Their
absence post-upgrade is a regression even if the build is otherwise
healthy.

| Var | Required on ccmax | Required on ccproxy2 | Reason it must survive |
|---|---|---|---|
| `ALERT_ANOMALY_ENABLED=0` | **YES** (deliberate; operator explicitly disabled) | verify before/after | Per-deploy rolling threshold is too noisy on our alert path; ccmax kept it off on purpose. Do not flip to `1` from the new build's defaults. Parse via `parseEnabledEnvFlag` (`packages/config/src/index.ts:652`). |
| `DATABASE_URL=postgresql://…` | YES | YES | Toggles the adapter (`docs/configuration.md:189-194`); the PG bugs above are off this code path on SQLite. |
| `BETTER_CCFLARE_DB_PG_PREPARE=false` | YES | YES | Default. Explicitly opt in only after validating `oven-sh/bun#16774`. |
| `BETTER_CCFLARE_DB_POOL_MAX` | capture before/after | capture before/after | Default 10 — must not silently change. |
| `LB_STRATEGY=session` (or `session-drain-soonest`) | YES | YES | Per-request spreading strategies are banned (account-ban risk). |
| `PORT` / `BETTER_CCFLARE_HOST` | capture | capture | Default `8080` / `0.0.0.0` — must match the existing ingress / firewall rules. |
| `CCFLARE_*` provenance envs | optional | optional | If we set `CCFLARE_GIT_REF`/`GIT_SHA`/`BUILD_DATE` in our deploy recipe, the new build must continue to surface them on `/health?detail=1`. |

How to check (operator-side): `systemctl show <unit> --property=Environment` or
`docker inspect --format '{{range .Config.Env}}{{println .}}{{end}} <container>`
to capture the running env vars; compare byte-for-byte against the table
before declaring pre-flight green.

### 1.4 Ports / ingress / supervisor

- The supervisor is the surrounding orchestrator (systemd unit
  `docs/systemd.md:7-54`, or compose with `restart: unless-stopped` and
  the `HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3`
  probe, or k8s `livenessProbe`/`readinessProbe` on `/health` —
  `docs/deployment.md:878-911`). Whatever form runs on ccmax must:
  - `ExecStartPre=/opt/better-ccflare/scripts/preflight-env.sh` (Bun
    crash-loop defence; unsets unknown `BUN_JSC_*` — see
    `scripts/preflight-env.sh:1-89`). Bun 1.3.11 ships on the new image;
    if our unit sets `BUN_JSC_smallHeap=1` historically, that bakes a C++
    crash before JS runs and burns the 5 `StartLimitBurst` attempts in
    ~25s.
  - Health probe must match `curl -fsS http://127.0.0.1:8080/health`
    (note `fsS`; a 503 must NOT parse as OK — `docs/reviews/verify-live-build.adversarial.md`
    documents this footgun).
- Ingress: the production port is `8082` (per `CLAUDE.md:129`); ensure no
  firewall / LB rule change.

### 1.5 Accounts / providers (no config churn from the upgrade)

- `ccproxy2`'s account list must round-trip through
  `bun run cli --list` with identical priorities and providers. PR #360
  does not touch account management.
- Provider flag settings (Anthropic-Messages-shaped wire format =
  `path==/v1/messages && content-type: text/event-stream`,
  `packages/proxy/src/response-handler.ts:359-368`) are unchanged. The
  wrapper still applies to Anthropic and to every anthropic-compatible
  provider (zai, minimax, anthropic-compatible) because the gate is on
  wire format, not provider name.

### 1.6 Disk and image-pull prerequisites

- ~1.5 GB free on the volume `/data` (DB + logs + an extra migration
  workspace). The PG `stream_terminal_state` ALTER is online; no
  vacuum/lock expected.
- Registry pull must succeed — verify `docker pull
  ghcr.io/zenprocess/better-ccflare:v3.5.46` returns the same digest as
  recorded in the deploy manifest. If the digest drifts, halt.
- Bun version on the new image (per the recipe's
  `CCFLARE_BUN_IMAGE` label) must still be `1.3.11` — the upstream fix
  relies on the `reader.cancel()`-doesn't-close-the-socket property of
  Bun ≥1.3.11. A silent Bun bump is not a non-event.

### 1.7 Things that would make the upgrade UNSAFE to start

- `git_sha` doesn't resolve through `v3.5.46`. Abort; this is not the
  build the runbook was written for.
- `stream_terminal_state` column missing from `requests` AND the new
  schema not reachable (i.e. fresh DB without `ensureSchemaPg`
  completing) — would force a fallback write path with no terminal
  state, exactly the silent gap PR #360 closes.
- Running watchdog reap rate above ~0/min at the moment of upgrade —
  we'll be capturing actual disconnect evidence on the new build, and
  the natural client-disconnect source (our watchdog reaping workers)
  needs to actually be producing disconnects in the window we measure.
- `ALERT_ANOMALY_ENABLED` on `ccmax` is `1` post-upgrade but was `0`
  pre-upgrade. That's a config regression; revert.

---

## PART 2 — POST-UPGRADE EVIDENCE FOR UPSTREAM

tombii has held issue #348 open specifically waiting on this production
observation. The reply he owes ("either a focused follow-up if symptom
recurs, or an update here if it's closed") is the deliverable this
section enables. We already posted the code-review position on
2026-08-01 (see issue #348, comment ID 5152810656). This part is the
**evidence** half — what to capture on the live build to resolve the
remaining question.

A successful demo of PR #360 on our fleet means: a real client
disconnect mid-stream is no longer an opaque 30-minute orphan, and we
can prove it.

### 2.1 Prove a real client disconnect ENDS the request, doesn't cascade

What the three commits predict:

- The proxy returns **499** to the client log and writes ONE end message,
  not the historical cascade ("account failed → walk remaining
  candidates → all accounts failed"). The catch in `proxyWithAccount`
  returns `new Response(null, { status: 499 })` once `req.signal.aborted`
  is set (`packages/proxy/src/handlers/proxy-operations.ts:1511-1523`).
- The upstream fetch is actually aborted (`AbortSignal.any` in
  `request-handler.ts:116`); the upstream socket closes (this is the
  part the Bun 1.3.11 measurement pins).

How to capture:

```
# In server log (operator, on ccmax then ccproxy2):
journalctl -u better-ccflare --since "5 minutes ago" | \
  grep -E "(Client disconnected during request|All accounts failed|HTTP/.* 499)"
```

**PASS shape** — single line per disconnect:

```
[info] Client disconnected during request to <account> — ending instead of failing over
HTTP/1.1 499
```

**FAIL shape** — what the OLD code produced (must NOT appear
post-upgrade):

```
[error] All accounts failed: <accumulated reasons>
… repeated for the cascade as the proxy walks the remaining accounts …
```

> Soft check: the same disconnect event must NOT generate N
> `upstream_429_with_reset` cooldown writes on the remaining accounts.
> If it does, the catch in #360 is not actually guarding.

### 2.2 Distribution of `streamTerminalState` on /api/requests

`v3.5.46` exposes `streamTerminalState` per row on `GET /api/requests`
(handlers/requests.ts:135 / types/request.ts:181) and on the SSE live
stream `/api/requests/stream` (router.ts:351 → usage-collector
side-publish).

```
curl -fsS http://<host>:8082/api/requests?limit=1000 | \
  jq -r '.[].streamTerminalState' | sort | uniq -c | sort -nr
```

Expected distribution on a healthy fleet with normal traffic:

| Value | Cardinality expectation |
|---|---|
| `complete` | dominant — every clean Anthropic-Messages-shaped SSE that ended on a `message_stop`. |
| `recovered` | rare — a provider shipped a malformed end we recovered within `ANTHROPIC_TERMINAL_RECOVERY_GRACE_MS` (10 s, `anthropic-terminal-recovery.ts:4`). Non-zero is fine; spikes are not. |
| `client_cancelled` | non-zero and **continuous** on ccmax while our watchdog reaps workers — this is the witness stream for #348. It must NEVER be missing on `ccmax` over any multi-minute window. |
| `truncated` | rare, bounded. A sustained nonzero rate here is the proxy canary for a 30-minute-orphan pattern that the live-tail bug could resurrect under load — flag for review. |
| `error` | rare, bounded. Provider in-band error (4xx/5xx via SSE). Same caveat as `truncated`. |
| field absent / `null` | expected for non-streaming responses and non-wrapped streams; `null` is not a failure, it is "no observation". |

**PASS** for #360 specifically: a window with ≥1 disconnect source
(watchdog reap) shows `client_cancelled` ≥ 1 AND zero entries with
`status_code=200` AND `streamTerminalState=null` AND `error_message=null`
(those rows are the post-#360 equivalent of the stalls the
investigation of 2026-07-30 read as healthy for a day).

**FAIL** for #360 specifically: a clean Anthropic-Messages-shaped SSE
returns `streamTerminalState=null` on `/api/requests` despite the
response ending cleanly. That would mean 23cf0cea's read-path lost the
column at the TypeScript mapping. Re-check `packages/types/src/request.ts:325`
(reading `row.stream_terminal_state`) before reporting — this is the
silent-drop bug the commit message names.

### 2.3 Abandoned-request / connection-leak pattern is gone

This is the direct test of the mechanism described in #348. Bake this
into a one-liner and run it 5 minutes after each host comes up on
`v3.5.46`, then again at +1h and +24h:

```
ts=$(date -u -d '30 minutes ago' +%s)
```

(PG equivalent; operator runs against the live DATABASE_URL):

```sql
SELECT count(*) AS orphans_30m
FROM requests
WHERE timestamp > $ts
  AND method = 'POST'
  AND path   = '/v1/messages'
  AND status_code = 200
  AND response_time_ms > 30 * 60 * 1000
  AND error_message IS NULL
  AND stream_terminal_state IS NULL;
```

**PASS**: zero rows (the empty result is the result).

**FAIL**: any row. Each one is a stream that opened, never recorded a
terminal state, and survived past `PROXY_REQUEST_TIMEOUT_MS=30min` —
exactly the orphan pattern from #348. Note this is the pattern PR #360
was designed to leave behind for the *client-disconnect* path; for
provider-stalls during body streaming with the client still connected
the same orphan pattern can recur (see §2.5 — not a regression, a
known follow-up).

### 2.4 What a NEGATIVE result looks like (so we can tell him it didn't work)

Tell tombii it didn't work, in concrete terms, if any of these are
true on the new build with a non-empty client-disconnect source:

1. A client disconnect mid-stream produces a cascade of
   `All accounts failed` log lines on a single disconnect (one for each
   remaining candidate) — the `req.signal.aborted` discriminator in
   `proxy-operations.ts:1511-1523` is not running.
2. An orphan row appears in §2.3 on the new build while a client-disconnect
   source is running — the abort signal is not actually wired to the
   upstream fetch (`AbortSignal.any` in `request-handler.ts:116` missing
   or replaced).
3. `GET /api/requests` returns rows where the SSE stream ended cleanly
   but `streamTerminalState` is `null` AND `error_message` is `null` —
   23cf0cea's read path lost the column.
4. `client_cancelled` count is exactly zero over a multi-hour window
   while workers are actively being reaped by our watchdog — the
   upstream is being aborted but `onCancelError` is not classifying the
   cancel; pre-#360-equivalent silent path.
5. Bun upgrade on the image: if `/health` shows a Bun revision newer
   than `1.3.11` (or the `org.opencontainers.image.base.containment`
   label changes), the `reader.cancel()` socket-close property the
   upstream measurement assumes must be re-tested — flag without
   claiming fix or regression until that one-liner is run.

If (1) or (2) fires: open a focused follow-up issue citing §2.1 and
§2.3. Don't close #348.

### 2.5 Known follow-ups (NOT regressions; flag, don't re-file)

Per the code review already posted to #348:

- `PROXY_REQUEST_TIMEOUT_MS` is still **not configurable** (`packages/core/src/constants.ts:32`,
  hardcoded to 30 min). Long-silent providers with a still-connected
  client produce the same orphan pattern (separate ticket, not a
  regression introduced by PR #360).
- **No preliminary INSERT at stream start**. An abandoned stream that
  never reaches `_handleEndInternal` still leaves no `requests` row.
  PR #360 closes the abort path on disconnects but does not insert at
  stream-open.
- **No body-stream timer**. The header-phase
  AbortController is cleared in the `finally` of `makeProxyRequest`
  (`request-handler.ts`), and `teeStream` carries no timer of its own.
  Same orphan pattern can recur for a client that stays connected
  through provider stall.

None of these is what #348 was about, and none regresses on the new
build. Don't conflate them when reporting back.

### 2.6 One-shot capture checklist (operator)

Run on each of `ccmax` and `ccproxy2` 5 min after the new container is
up, then again at +24h:

```
# 1. Identity
curl -fsS http://<host>:8082/health?detail=1 \
  | jq '{version, git_sha, git_ref, build_date}'
# expect version=3.5.46, git_sha reachable through v3.5.46, build_date recent

# 2. /api/requests terminal-state distribution
curl -fsS "http://<host>:8082/api/requests?limit=1000" \
  | jq -r '.[].streamTerminalState // "null"' | sort | uniq -c | sort -nr

# 3. Orphan scan (PG)
DATABASE_URL=… bash -c "psql -At -c \"
  SELECT count(*) FROM requests
  WHERE timestamp > now() - interval '30 minutes'
    AND method='POST' AND path='/v1/messages'
    AND status_code=200 AND response_time_ms > 1800000
    AND error_message IS NULL
    AND stream_terminal_state IS NULL;\"" 

# 4. Disconnect evidence on ccmax (watchdog reap active)
journalctl -u better-ccflare --since "5 minutes ago" \
  | grep -E "(Client disconnected during request|All accounts failed|HTTP/.* 499)" \
  | head -50
```

Send (1)-(4) plus the analysis of §2.1–§2.4 back as the reply on #348.
Distinguish pass / fail for each of the three PR #360 commits; the
reply shape is per-commit ("commit X passed because <evidence>,
verdict closed" / "commit X failed because <concrete observation>,
verdict focused follow-up").

---

## Provenance (what this doc was derived from)

- `git show fd389fd2`, `cec5b5b9`, `23cf0cea` — the three PR #360
  commits, all reachable from `v3.5.46`.
- `git show v3.5.46:packages/proxy/src/handlers/{request-handler,proxy-operations}.ts`
  — confirms `signal: req.signal` threaded through and 499 discriminator.
- `git show v3.5.46:packages/{http-api/src/handlers/requests.ts,types/src/request.ts}`
  — confirms `streamTerminalState` is on the summary response.
- `git show v3.5.46:packages/database/src/{migrations,migrations-pg}.ts`
  — confirms the column on both backends.
- `docs/configuration.md:122, 178, 189-222` — DB backend triggers and
  known operator-tunable knobs.
- `packages/proxy/src/response-handler.ts:300-368` — taxonomy of
  `streamTerminalState` consumer-side.
- `packages/proxy/src/anthropic-terminal-recovery.ts:1-583` — producer
  of `AnthropicTerminalState`.
- `docs/348-reply-pr360.md` (sibling doc, on the ccflare-129 worktree;
  not present on this branch at authoring time) — code-review position
  already posted to #348 on 2026-08-01.

This doc was authored without host access. The operator runs the
captures; the orchestrator reviews the captures.
