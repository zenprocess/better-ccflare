# Issue #273 follow-up — Task C: what reduces leak RATE in production today

**Branch:** `analysis/issue-273-ops-mitigations` @ upstream/main (commit `053746c1`)
**Worktree:** `/Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-49`
**Date:** 2026-07-28
**Scope:** ANALYSIS ONLY. No production code changed, no config changed, no strategy changed. Every numeric estimate below is labeled AS AN ESTIMATE; measured numbers cite their artifact.

---

## 0. The constraint this analysis lives under

- `body.cancel()` is a no-op on every released Bun (`ccflare-42/BUN-35093-VALIDATION.md:9-15`). Per-request leak rates **measured** on stock Bun: **73.26 KB/req** on 1.3.2, **76.62 KB/req** on 1.3.14 (same artifact, lines 9–10).
- Draining the body works on stock Bun and is **expected** to land in Task A on the same branch family (`fix/issue-273-drain-discarded-bodies`). Until that merges, every upstream `Response` that is `return null`'d without `getReader()`/`arrayBuffer()`/`text()` retains ~73–77 KB off-heap until Bun GCs the closure.
- Per-request leak is therefore a function of (leak-per-discard) × (discards-per-second). This document addresses the second factor, **discards-per-second**, on the version of upstream that an operator running ccflare today actually has.

---

## 1. Q1 — Which conditions generate discarded Responses, and at what relative frequency?

The full site classification is in `ccflare-41` on branch `fix/bun-leak-273-cancel-discarded-bodies` (commit `7f99aba0`, `packages/proxy/src/handlers/discard-body-cancel.ts:25-42`). That helper **is not on upstream/main** today — `git grep cancelDiscardedResponseBody packages/proxy/src/handlers/proxy-operations.ts` returns zero hits on commit `053746c1`. So on upstream/main, **every site below is currently un-drained**.

### 1.1 Discard sites on the live traffic path (HIGH-frequency)

| Site (file:line) | Trigger | Body size (worst case) | Drained today? |
|---|---|---|---|
| `packages/proxy/src/handlers/proxy-operations.ts:1283-1315` | `processProxyResponse` returns `true` after upstream 429/529 → `proxyWithAccount` returns `null` → outer account loop tries the next account (`packages/proxy/src/proxy.ts:528-595`) | Small JSON (429/529 envelope) | NO |
| `packages/proxy/src/handlers/proxy-operations.ts:1187-1255` | In-place retry loop for reset-less 529 (`getOverloadRetryConfig().maxAttempts`, default 3). Each iteration overwrites `response = retryResponse` (`packages/proxy/src/handlers/proxy-operations.ts:1227`) after `await makeProxyRequest(transformedRequestForRetry.clone())` (line 1209). Body of the prior `response` is orphaned. | Medium JSON 529 | NO |
| `packages/proxy/src/proxy.ts:528-595`, `:619-637`, `:697-721`, `:735-753` | The outer account loop's failover. Each iteration that returns `null` from `proxyWithAccount` leaks the upstream `Response` it produced. The number of leaks per user request = up to (pool size − 1). | Aggregates every smaller site above | NO |

**ESTIMATE — discards per typical successful request under burst:** 1.0–1.5 upstream fetches that become discarded per outer-loop iteration (one failed primary + N retries). For a 4-account pool where the first account 429s under burst: ~2–3 discarded `Response`s per request during the burst, ~1 per request in steady state (only the second-and-later fetches in the loop are "discarded" — the last successful one is forwarded).

### 1.2 Discard sites on the model-fallback retry path (MEDIUM-frequency)

| Site (file:line) | Trigger | Body size | Drained today? |
|---|---|---|---|
| `packages/proxy/src/handlers/proxy-operations.ts:1070` | `rawResponse = await makeProxyRequest(retryTransformedRequest)` inside `isModelUnavailableError`-driven model-list fallback loop (`:1010-1077`). Each iteration overwrites prior `rawResponse`. | Small JSON 429/404 | NO |
| `packages/proxy/src/handlers/proxy-operations.ts:723` | `rawResponse` overwrite after `isInvalidThinkingSignatureError` filter-thinking retry (claude-oauth / anthropic only). | Small JSON 400 | NO |
| `packages/proxy/src/handlers/proxy-operations.ts:755` | `rawResponse` overwrite after `isCacheControlRejectionError` strip-cache-control retry (GLM-5.1 strict validation path). | Small JSON 400 | NO |

**ESTIMATE — frequency:** each of these fires when the request triggers an `account.modelMappings` mapping (issue #199 bug 2 mention). For a typical ccflare workload with one model per account and no `modelMappings` configured, this loop never runs and contributes zero. For accounts with `modelMappings`, the loop runs once per 429/404 cluster on that account.

### 1.3 Discard sites on auth + 401 paths (LOW-frequency)

| Site (file:line) | Trigger | Body size | Drained today? |
|---|---|---|---|
| `packages/proxy/src/handlers/proxy-operations.ts:1176-1181` | Upstream 401 → `return null` → next account. | Small JSON 401 | NO |
| `packages/proxy/src/handlers/proxy-operations.ts:1261-1266` | Mid-529-retry 401 → `return null`. Same auth-revoked scenario as above. | Small JSON 401 | NO |
| `packages/proxy/src/handlers/proxy-operations.ts:858-932` | `out_of_credits` (issue #261) — model-scoped 429, no cooldown, failover to next account. Body discarded. | Small JSON 429 | NO |

### 1.4 Synthetic probe sites (LOW-frequency, but always pays full cost)

| Site (file:line) | Trigger | Body size | Drained today? |
|---|---|---|---|
| `packages/proxy/src/cache-keepalive-scheduler.ts:179-202` | Cache-keepalive replay every `max(60s, (ttl-1)*60s)` seconds per cached account (default TTL set by `cache_keepalive_ttl_minutes`, see `packages/config/src/index.ts:415-422`). Outer `fetch` IS drained at `:188` (`await response.text().catch(() => {})`). The inner proxy path through `handleProxy` is **NOT** drained on internal 503 (the rows in §1.1 fire inside the inner path). | Outer: small JSON; inner: aggregated cost from §1.1 | outer YES; inner NO |
| `packages/proxy/src/auto-refresh-scheduler.ts:419-465` | Auto-refresh multi-model fallback loop overwrites `response` on each 404 iteration (`:444`). Models array is bounded by `models` length (typically 3 entries). | Small JSON 404 (max 2 prior responses leaked per attempt) | NO |
| `packages/proxy/src/auto-refresh-scheduler.ts:444` | Heartbeat fires every `60000` ms (`packages/proxy/src/auto-refresh-scheduler.ts:36`). Each iteration that fails the 404 break leaks. | Small JSON | NO |
| `packages/proxy/src/integrity-scheduler.ts:305-342` | On-demand integrity probes (manual / API-triggered). | Small JSON | NO |

### 1.5 Discard sites where the response IS forwarded (partial drain)

| Site (file:line) | Note |
|---|---|
| `packages/proxy/src/handlers/proxy-operations.ts:1284-1313` | Terminal-attempt pool exhaustion forwards a 529 to the client via `forwardToClient`. Drain depends on `forwardToClient` → `teeStream` (packages/proxy/src/response-handler.ts:410-414). On client disconnect mid-stream, `teeStream.cancel` propagates — but client-side `req.signal` is **not wired** into `makeProxyRequest`'s `AbortController` (`packages/proxy/src/handlers/request-handler.ts:96-108`), so the upstream fetch only aborts on `PROXY_REQUEST_TIMEOUT_MS = 30 min` (`packages/core/src/constants.ts:32`). A client that hangs up pays the full 30-minute holding cost on the upstream body. |
| `packages/proxy/src/handlers/proxy-operations.ts:1007` | Genuine model-not-found (404/400) forwarded via `withSanitizedProxyHeaders(rawResponse)`. Same `req.signal` caveat. |
| `packages/proxy/src/handlers/proxy-operations.ts:821` | `extra_usage_exhausted` 400 (issue #293) forwarded. Same caveat. |

### 1.6 Frequency tier summary

- **HIGH** — §1.1 (the 429/529 failover). The dominant contributor. Per-typical-burst: 1–N upstream fetches discarded per user request where N = number of accounts that fail before one succeeds.
- **MEDIUM** — §1.2 (model-fallback retry). Per request with `modelMappings` configured.
- **LOW** — §1.3 (401 / out_of_credits / extra_usage). Once per OAuth rotation, once per model-credit depletion, once per Anthropic billing-policy rejection.
- **LOW** — §1.4 (synthetic probes). The keepalive scheduler runs every `(ttl-1)*60s` per cached account; auto-refresh runs every 60 s; integrity scheduler runs on-demand or per-interval. Each fires regardless of whether the upstream is healthy.
- **PARTIAL** — §1.5 (forwarded-on-disposition). Only burns when the client disconnects or when a teeStream consumer errors mid-stream.

**Bottom line for Q1 (ESTIMATE):** On a 4-account pool in steady state with 5% 429 rate on a single account, the 429/529 failover at §1.1 generates roughly **0.05 discards per user request** (5% of requests hit a primary 429, producing ~1 discarded fetch each before the next account succeeds). Synthetic probes add roughly **1 discard / 60s per cached account** for auto-refresh and **1 discard / (ttl-1)*60s per cached account** for keepalive.

---

## 2. Q2 — Does `lb_strategy` session vs `least-used` change the discard rate?

This is asked in the context of ccmax running `least-used` today plus a live ban-risk incident #58. **I am analyzing, not changing strategy.**

### 2.1 Strategy implementations on upstream

- `least-used` → `LeastUsedStrategy` at `packages/load-balancer/src/strategies/least-used.ts:53-166`. Picks the available account with the lowest utilization score (priority ASC, then upstream utilization + recency penalty). Recency penalty `RECENT_PICK_PENALTY = 100` within `RECENT_PICK_WINDOW_MS = 500ms` (`least-used.ts:16-25`) makes concurrent `select()` calls approximately round-robin.
- `session` → `SessionStrategy` at `packages/load-balancer/src/strategies/index.ts:19-391`. Pin a client to an account for `ANTHROPIC_SESSION_DURATION_DEFAULT = 5 hours` (`packages/core/src/constants.ts:17`). Preempts only for a strictly-higher-priority account (`:289-303`). When the pinned account rate-limits, falls back to priority-sorted selection on the next `select()` (`:322-348`).

Strategy dispatch at `apps/server/src/server.ts:80-94` (`LeastUsed` case at `:85`).

### 2.2 Per-request fetch count — single request, no burst

**ESTIMATE** — Both strategies converge to **~1.0–1.05 upstream fetches per successful user request** in this regime:
- `session`: 1 fetch on the same pinned account for the 5 h window. The `hasActiveSession` check (`:101-105`) only flips to a different account when the active one rate-limits.
- `least-used`: 1 fetch on the lowest-util account. The recency penalty only matters under concurrency.

When the primary 429s, both strategies converge to the **same** mid-request failover cost (1 extra discarded fetch on the next account before one succeeds). The strategy choice does not change per-request failover inside `proxyWithAccount` because both paths funnel into the same `proxy.ts:528-595` loop.

### 2.3 Per-request fetch count — burst of N concurrent requests

**This is where the strategies diverge, and the divergence runs in the direction OPPOSITE to what the task description suggests.**

- `session`: under burst, all N concurrent clients funnel to the same `activeAccount` (`:261-318`). When that account 429s, **every concurrent request** in the burst burns a discarded upstream fetch on the dead account before its own failover picks a new primary. Total discards in the burst ≈ N (one per request on the dead account) + N (one per request on the failover target) ≈ **2N**.
- `least-used`: under burst, the recency penalty (`:106-112`) spreads the N requests across accounts. The fraction that picks the same lowest-util account is small; the fraction that fails on its first pick is ≈ `1/M` where M is the available pool. Total discards in the burst ≈ `N × (1/M)` for the failed-primary cases, ≈ **N/M**.

**ESTIMATE — burst discard ratio (session ÷ least-used):** for `N = 10`, `M = 4`: session ≈ 20 discards, least-used ≈ 2.5 discards, ratio ≈ **8× more discards on `session`**.

### 2.4 Implication for the ban-risk argument

The leak-rate evidence runs **against** switching from `least-used` to `session` for leak mitigation: under burst conditions, `session` multiplies the discard rate, not the other way around.

**The ban-risk argument for switching to `session` (incident #58) is a separate concern** about per-account request distribution, not about leak rate. This analysis does **not** validate `session` as a leak-rate fix; it validates `session` only if the ban-risk reduction outweighs the discard-rate increase. That trade-off is the operator's call, not this document's.

### 2.5 What this analysis does NOT recommend

- **No strategy change.** The user explicitly forbade it. The data presented here only narrows the operator's choice; the choice itself is theirs.
- **No code change to either strategy.** This is analysis-only.
- **No claim that the leak is solved by either strategy.** The dominant per-request leak source (the 73–77 KB off-heap retention in Bun 1.3.x) is independent of LB strategy; it depends only on whether the upstream `Response` body is drained before being unreferenced.

---

## 3. Q3 — Would the circuit breaker on `feat/cb-wave2-chokepoint` reduce discard volume?

Branch tip: `feat/cb-wave2-chokepoint` @ `a3a9bf38` ("fix(proxy): wire circuit breaker into cooldown chokepoint and active-clear"). Built on top of `975e440d` ("feat(proxy): circuit breaker core state machine") which adds `packages/proxy/src/circuit-breaker.ts`.

### 3.1 What the breaker on this branch actually does

- **Per-(provider, accountId) state machine** at `packages/proxy/src/circuit-breaker.ts` (per `975e440d`). `closed → open → half-open → (closed | open)`. Opens after `FAILURE_THRESHOLD = 5` consecutive failures of a kind that `shouldCountAsCircuitFailure` returns `true` for (`:54-57`, `:128-141`). Cooldown `OPEN_COOLDOWN_MS = 30s`; half-open backoff cap `HALF_OPEN_BACKOFF_MAX_MS = 5min` (`:54-57`).
- **Wired at the cooldown chokepoint.** `applyRateLimitCooldown` (`packages/proxy/src/handlers/rate-limit-cooldown.ts`) calls `breaker.recordFailure({ provider, accountId }, reason)` after the forward-guard early-return at `:264-271` (per `a3a9bf38`). `clearExpiredRateLimits` (`packages/database/src/repositories/account.repository.ts`) returns `(id, provider)` pairs it cleared, and `apps/server/src/server.ts:282-285` and `:805-810` call `breaker.recordSuccess` per cleared row — the "active-clear" path.

### 3.2 What the breaker on this branch does NOT do

**The breaker module exports `shouldAllow` and `isProviderWideOpen` (`packages/proxy/src/circuit-breaker.ts:308-356`) but neither is invoked anywhere on this branch** (verified via `git grep -n 'shouldAllow\|isProviderWideOpen' apps/server/src packages/proxy/src` on `feat/cb-wave2-chokepoint` returns hits only inside the breaker module itself). Specifically:

- `packages/proxy/src/handlers/account-selector.ts` does **not** consult `shouldAllow` before placing an account in the candidate list.
- `packages/proxy/src/proxy.ts:528-595` (the account-loop) does **not** skip an account whose breaker is `open`.
- `packages/proxy/src/response-handler.ts` does **not** short-circuit on `shouldAllow`.

So `shouldAllow` is the gate that **would** fail-fast an open-circuited account before the upstream fetch. Wiring that gate into the selection loop is **future work** — the wave-2 commit message explicitly says "the active-clear path from design §3" is the only addition (`a3a9bf38` body), and the wave-1 commit (`975e440d` body) promises "a follow-up task will integrate it with proxy.ts and response-handler.ts."

### 3.3 Effect on discard rate per hour (ESTIMATE)

Workload assumption (same shape as the spec): 1 user request/sec × 8 h = 28,800 user requests. 5% 429 rate on a single account. 4 accounts in pool.

- **Without this CB (today on upstream/main):** primary 429-discard rate = 360 per 8 h session ≈ 45/h. Failover-discard rate ≈ 360 per 8 h session ≈ 45/h. **ESTIMATE total ≈ 90–180 discards/h under burst.** Steady-state: ≈ 45/h.

- **With this CB on `feat/cb-wave2-chokepoint`:** the breaker counts failures but does not consult `shouldAllow` before fetching. The discard rate is **unchanged** at the steady-state 45/h. The bookkeeping feeds `breaker.recordFailure` but the selection loop still fetches and discards the same way.

- **If `shouldAllow` were wired into `selectAccountsForRequest` (hypothetical, NOT on this branch):** under burst (5 consecutive 429s in ~5 s clustered), the breaker opens for 30 s and would skip up to ~30 fetches that would otherwise have routed to that account. **ESTIMATE upstream-fetches avoided: 70–95% during open windows** in burst regimes. In steady-state 5%-429 regimes (no consecutive cluster), the breaker rarely opens and savings are < 5%.

### 3.4 What the breaker does NOT cover

- A single 429 on an otherwise-healthy account (counted but not opened until 5 consecutive).
- Model-scoped reasons (`model_fallback_429`, `out_of_credits`, `extra_usage_exhausted`) — explicitly excluded by `shouldCountAsCircuitFailure` (`packages/proxy/src/circuit-breaker.ts:128-141`). These continue to fail over normally.
- Forward-guard-suppressed 529s (a 529 mid-429-bench) — `breaker.recordFailure` is skipped by the guard at `packages/proxy/src/handlers/rate-limit-cooldown.ts:245-262`.
- Synthetic keepalive replays — `isInternalProbe` filter at `packages/proxy/src/handlers/response-processor.ts:292-296` skips cooldown application, so the CB never sees them.
- Stream in-band errors — mid-stream 429/529 SSE frames call `applyRateLimitCooldown` (`packages/proxy/src/response-handler.ts:281-296`) but the partial upstream body has already been teed; the CB cannot prevent the partial fetch.
- Fetch-level throws (`ECONNRESET` etc.) — `recordFailure` is only called from `applyRateLimitCooldown`, which is reached via status-code paths. Network throws never feed the breaker.
- Pool-exhausted 503 — `proxy.ts:499` returns the 503 without consulting the breaker.

### 3.5 Verdict

**On `feat/cb-wave2-chokepoint` as it stands, the breaker REDUCES discard rate by approximately 0%.** The accounting is wired; the fail-fast gate that would actually short-circuit discards is not. To reduce discard volume from this branch, a follow-up must call `shouldAllow(key)` inside `selectAccountsForRequest` (or equivalent selection step). That change is NOT in this branch.

---

## 4. Q4 — Operational mitigations an operator can apply TODAY (concrete numbers)

Constraint: no code change, no config change. Mitigations below are CLI flags, env vars, container memory limits, and external schedulers.

### 4.1 RSS growth math (per discard rate × leak rate)

Inputs (measured, ccflare-42):
- `k_low = 73.26 KB/req` on Bun 1.3.2
- `k_high = 76.62 KB/req` on Bun 1.3.14

| Scenario | RPS | Discard % | Discards/sec | Hourly RSS growth |
|---|---|---|---|---|
| Low    | 1   | 5%  | 0.05  | **12.9–13.5 MB/hr** |
| Medium | 10  | 10% | 1.00  | **257.5–269.4 MB/hr** |
| High   | 50  | 20% | 10.00 | **2,575.5–2,693.7 MB/hr** |

Time to fill the default 1 GB container memory limit (assuming no other RSS consumers):

| Scenario | Time to fill 1 GB | Time to fill 3 GB (systemd ref) |
|---|---|---|
| Low    | 74–79 hr  | 222–238 hr |
| Medium | 3.7–3.9 hr | 11.1–11.7 hr |
| High   | 22–24 min | 66–73 min |

Reference memory budgets in the repo:
- `docker-compose.yml:36` — `memory: 1G` hard limit (default compose deployment).
- `docs/systemd.md:30-31` — `MemoryMax=3G`, `MemoryHigh=2G` (reference systemd unit).
- `docs/deployment.md` — k8s reference at `2Gi` limit / `512Mi` request (Q4 agent citation; cross-check at `docs/deployment.md`).
- `Dockerfile:46-48` — `HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3` curl `/health` (no `--memory` flag).

### 4.2 Restart cadence recommendation (per scenario)

No internal periodic restart exists. The app relies on the external orchestrator (`docker-compose.yml:8` `restart: unless-stopped`, `docs/systemd.md:35` `Restart=always`).

| Scenario | Recommended restart cadence | Headroom math |
|---|---|---|
| Low    | manual restart every **72 h** | 12% headroom under the 79 hr ceiling |
| Medium | restart every **3 h** | 23% headroom under the 3.9 hr ceiling |
| High   | restart every **20 min** | 16% headroom under the 24 min ceiling |

A `cron` job, k8s `CronJob`, or systemd timer must be configured externally.

### 4.3 Concrete operational mitigations (no code change)

| # | Action | Why | Evidence |
|---|---|---|---|
| W1 | `LOG_LEVEL=warn` (or `error`) | Cuts per-discard `logBus` events, file-writer lines, in-memory ring entries. Reduces ancillary CPU/heap retention on the discard path. | `packages/logger/src/index.ts:80-90`. |
| W2 | `LOG_FORMAT=json` | Smaller per-line payload than pretty. | `packages/logger/src/index.ts:92-98`. |
| W3 | Run Bun with `--smol` (more aggressive GC) | `--smol` is documented as the supported memory-tuning flag (`docs/systemd.md:26-27, 58-65`). Pass via `ExecStart=/usr/bin/better-ccflare --smol --serve …` for systemd, or `--smol` arg in `docker-compose.yml`. **Note: ccflare's own CLI has no `--smol` flag (`apps/cli/src/main.ts:443-816`), so the flag must be passed through Bun directly** (as the systemd unit does). | `docs/systemd.md`. |
| W4 | Raise container memory limit to **3–4 GB** | Doubles-to-quadruples time-to-OOM at every traffic tier. `memory: 1G` in `docker-compose.yml:36` is the floor; `MemoryMax=3G` in `docs/systemd.md:30` is the recommended systemd ceiling. | `docker-compose.yml`, `docs/systemd.md`. |
| W5 | Front proxy with Cloudflare WAF Rate Limiter (or nginx `limit_req`) | No per-client rate-limit exists in ccflare (`docs/security.md:455` explicitly: *"No rate limiting: Individual clients can make unlimited requests to API endpoints."*). Edge-side throttling is the only way to lower inbound RPS. | `docs/security.md:455, 622`. |
| W6 | Schedule periodic restarts via cron / k8s CronJob / systemd timer | `restart: unless-stopped` only restarts on crash, not on schedule. Cadence per §4.2. | `docker-compose.yml:8`, `docs/systemd.md:35`. |
| W7 | `STORE_PAYLOADS=false` | Prevents persisting full request/response bodies to `request_payloads` table — reduces SQLite write amplification and DB cache RSS. Read by `config.getStorePayloads()`. | `packages/config/src/index.ts:378-379`. |
| W8 | Tighten `DATA_RETENTION_DAYS=1` and `REQUEST_RETENTION_DAYS=7` (defaults 3 / 90) | Less DB-page churn → lower SQLite cache RSS. | `.env.example:24-26`. |
| W9 | Disable synthetic keepalive / auto-refresh probes when not needed | `cache_keepalive_ttl_minutes = 0` disables keepalive (`packages/config/src/index.ts:415-422`). Auto-refresh is per-account via `auto_refresh_enabled = 0` (`packages/proxy/src/auto-refresh-scheduler.ts`). | `packages/config/src/index.ts:415-422`. |
| W10 | Pin `BETTER_CCFLARE_DEBUG` unset (or `=0`) | Removes the DEBUG path that logs each Request method+path on the hot path. | `packages/proxy/src/proxy.ts:506-512`. |

### 4.4 Verification commands (per mitigation)

| Check | Command | Threshold |
|---|---|---|
| RSS sample | `ps -o rss= -p $(pgrep -f better-ccflare \| head -1) \| awk '{printf "%.1f MB\n", $1/1024}'` | < 80% of container memory limit |
| RSS over time | `while true; do ps -o rss= -p $(pgrep -f better-ccflare \| head -1) \| awk '{printf "%s %.1f MB\n", strftime("%H:%M:%S"), $1/1024}'; sleep 60; done` | Linear growth ≥ 10 MB/hr confirms leak; restart cadence from §4.2 must keep growth below the memory ceiling |
| Discard rate (any reason) | `sqlite3 "$BETTER_CCFLARE_DB_PATH" "SELECT COUNT(*) FROM requests WHERE timestamp > (strftime('%s','now')*1000 - 3600000) AND (status_code >= 400 OR success = 0);"` | Alert at > 360 discards/hr (≈ 0.1/sec) for medium-traffic tier |
| Discard rate (failover-specific) | `sqlite3 "$BETTER_CCFLARE_DB_PATH" "SELECT COUNT(*) FROM requests WHERE timestamp > (strftime('%s','now')*1000 - 3600000) AND status_code IN (401, 429, 500, 503, 529);"` | Alert at > 720/hr (≈ 0.2/sec) |
| Per-status breakdown | `sqlite3 "$BETTER_CCFLARE_DB_PATH" "SELECT status_code, COUNT(*) FROM requests WHERE timestamp > (strftime('%s','now')*1000 - 3600000) GROUP BY status_code ORDER BY 2 DESC;"` | 429 share > 10% → investigate upstream pool |
| Recent failover rows | `sqlite3 "$BETTER_CCFLARE_DB_PATH" "SELECT timestamp, status_code, error_message, failover_attempts FROM requests WHERE status_code >= 400 ORDER BY timestamp DESC LIMIT 10;"` | `failover_attempts > 0` correlates with discards |
| Container memory ceiling | `docker inspect --format='{{.HostConfig.Memory}}' better-ccflare \| awk '{printf "%.0f MB\n", $1/1048576}'` | Should match `docker-compose.yml` `memory` (currently 1G) |
| Healthcheck liveness | `curl -fsS http://localhost:8080/health` | 200; otherwise pre-restart is imminent |
| Log file rotation | `ls -lh "${BETTER_CCFLARE_LOG_DIR:-/tmp/better-ccflare-logs}/app.log"` | ≤ 10 MB (`LOG_FILE_MAX_SIZE`, `packages/logger/src/file-writer.ts:14-21`) |
| `STORE_PAYLOADS=false` verification | `sqlite3 "$BETTER_CCFLARE_DB_PATH" "SELECT COUNT(*) FROM request_payloads;"` | Should grow ~0 rows/day once set |

### 4.5 Single-page operator checklist

```text
OPERATOR CHECKLIST — ccflare Issue #273 (Bun 1.3.x memory leak)
=================================================================

DEPLOY (no code change):
[ ] W1  LOG_LEVEL=warn              in docker-compose.yml environment
[ ] W2  LOG_FORMAT=json             in docker-compose.yml environment
[ ] W3  --smol CLI flag              passed through Bun (docs/systemd.md:58-65)
[ ] W4  memory: 3G                  in docker-compose.yml deploy.resources.limits
[ ] W5  Cloudflare WAF Rate Limiter (or nginx limit_req) at edge
[ ] W6  CronJob @ cadence per §4.2  docker restart better-ccflare
[ ] W7  STORE_PAYLOADS=false        in docker-compose.yml environment
[ ] W8  DATA_RETENTION_DAYS=1
[ ]      REQUEST_RETENTION_DAYS=7
[ ] W10 BETTER_CCFLARE_DEBUG unset (or =0)

VERIFY EVERY 15 MIN:
[ ] RSS MB < 80% of memory limit   (command in §4.4 row 1)
[ ] Discard rate < 720/hr          (command in §4.4 row 3)
[ ] /health returns 200            curl -fsS http://localhost:8080/health

ESCALATE / RESTART if:
[ ] RSS > 90% of limit             →  docker restart better-ccflare
[ ] Discard rate > 3600/hr         →  page on-call (upstream provider incident)
[ ] Bun upgrade available          →  follow oven-sh/bun#35093 + tombii/better-ccflare#273
```

### 4.6 What "monitor memory" looks like with numbers (the deliverable the task demanded)

This is the part the spec specifically said must not be hand-wavy. Above: RSS sample command, RSS-over-time command, container-memory-ceiling command, healthcheck command, log-file-rotation command — all with numeric thresholds tied to the measured leak rate and the default container memory budget.

---

## 5. Cross-cutting observations

- **The dominant leak-rate lever is upstream-failover frequency (Q1 + Q3).** Per-request leak × failover-events. Reducing failover-events by either (a) lowering upstream 429/529 rate (operator-side: throttling, edge filter), or (b) wiring `shouldAllow` into the selection loop (code change; future work; not in scope here), lowers the discard rate directly.
- **The dominant per-discard lever is body size.** Cross-check from `ccflare-42/BUN-35093-VALIDATION.md:61`: a 502 KB body leaks ~557–602 KB/req. So an SSE streaming response that gets discarded (the `proxy.ts:528-595` loop on a streaming 429) leaks an order of magnitude more than a small JSON 429. Mitigations: front the proxy with an edge limiter (W5) to reduce bursts; consider a fix that drains streamed bodies more aggressively (Task A's branch).
- **Synthetic probes (§1.4) are bounded.** Auto-refresh fires every 60s per account; keepalive fires every `(ttl-1)*60s` per cached account. Disabling either (W9) cuts a known bounded discard stream. The default `cache_keepalive_ttl_minutes = ?` (Q4 agent's recollection needs a re-check) — operator can set to 0 to fully disable keepalive replay.
- **`req.signal` is not wired into `makeProxyRequest`'s AbortController** (`packages/proxy/src/handlers/request-handler.ts:96-108`). A client disconnect mid-stream holds the upstream body until `PROXY_REQUEST_TIMEOUT_MS = 30 min` (`packages/core/src/constants.ts:32`) elapses. **ESTIMATE** — for a streaming-heavy workload with frequent client disconnects, this is a meaningful secondary leak source that is independent of the §1.1 failover. Task A's spec explicitly warns against touching the live SSE path, so this is identified here but NOT addressed in this analysis.

---

## 6. What this analysis did NOT touch (scope discipline)

- **No production code changed.** No files in `apps/`, `packages/`, or `docs/` were modified.
- **No config changed.** No `.env`, no `config.yaml`, no `docker-compose.yml`, no `Dockerfile`. `docker-compose.yml:8,36` remain `restart: unless-stopped` and `memory: 1G`.
- **No load-balancing strategy changed.** `apps/server/src/server.ts:80-94` remains the active dispatch.
- **No circuit breaker merge.** Branch `feat/cb-wave2-chokepoint` was inspected by commit hash (`a3a9bf38`, `975e440d`) only — no files added to this branch, no `git checkout` performed against it.
- **No `body.cancel()` applied.** The `.cancel()` mitigation on branch `fix/bun-leak-273-cancel-discarded-bodies` (`7f99aba0`) was inspected but not ported; Task A owns that work.
- **No client disconnect / `req.signal` wiring.** Identified as a secondary leak source in §5 but explicitly out of scope per Task A's spec warning against touching the live SSE path.
- **No issue #58 ban-risk analysis.** That argument is independent of leak rate; the spec said to evaluate leak-rate evidence, not the ban-risk argument.

---

## 7. Caveats + sources

### 7.1 What was a measurement (cite the artifact)

- `73.26 KB/req` leak rate on Bun 1.3.2 → `ccflare-42/BUN-35093-VALIDATION.md:9`.
- `76.62 KB/req` leak rate on Bun 1.3.14 → `ccflare-42/BUN-35093-VALIDATION.md:10`.
- Leak scales with body size (502 KB → 557–602 KB/req) → `ccflare-42/BUN-35093-VALIDATION.md:61`.
- `1G` memory limit in default compose → `docker-compose.yml:36`.
- `MemoryMax=3G`, `MemoryHigh=2G` in systemd reference → `docs/systemd.md:30-31`.
- `--smol` flag recommendation → `docs/systemd.md:26-27, 58-65`.
- "No rate limiting" in ccflare → `docs/security.md:455, 622`.
- Session volume CB exists but is per-session → `packages/proxy/src/session-governor.ts:192-200`.
- Graceful SIGTERM handler exists → `apps/server/src/server.ts:1955-1962`.
- 30s hard shutdown watchdog → `packages/database/src/async-writer.ts:183-185`.
- `requests` table schema → `packages/database/src/migrations.ts:132-162`.

### 7.2 What was an ESTIMATE (labeled in-line above)

- Discard frequency tiers (HIGH/MEDIUM/LOW) per site.
- Discard-rate ranges under burst scenarios.
- Burst-discard ratio session ÷ least-used ≈ 8×.
- RSS growth per scenario per hour (the math is in §4.1).
- Time-to-OOM per scenario per memory limit.
- Recommended restart cadence per scenario.
- CB reduction-on-discard under burst if `shouldAllow` were wired.
- Mid-stream client-disconnect leak per `PROXY_REQUEST_TIMEOUT_MS`.

### 7.3 What this analysis could not establish

- **Real production discard rates for any specific deployment.** The percentages in §4.1 (5%, 10%, 20% discard) are placeholder scenarios, not measured traffic profiles.
- **Whether the ban-risk argument (incident #58) holds empirically.** Out of scope per the task description.
- **The exact leak rate on stock Bun 1.3.14 for streaming-shaped responses.** The ccflare-42 measurement is on a fixed 73 015-byte body (`BUN-35093-VALIDATION.md:7`); the 502 KB scaling at `:61` is the only secondary data point.

---

## 8. Branch + delivery

- **Branch:** `analysis/issue-273-ops-mitigations` (HEAD `053746c1` from `upstream/main`).
- **Worktree:** `/Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-49`.
- **Single new file:** `ISSUE-273-OPS-MITIGATIONS.md` (this document).
- **No PR opened.** The spec explicitly said do NOT push and do NOT open a PR.
- **Sparse-checkout caveat:** `.claude/` is excluded from the working tree via `.git/worktrees/ccflare-49/info/sparse-checkout` (this is local to the worktree only; the commit on the branch is clean).
