# CCMAX 502 ANALYSIS

> Investigation target: `ccmax.zp.digital` — production ccflare deployment that flapped to
> HTTP 502 and self-recovered with no operator intervention. This document is the code-side
> half of the investigation: every path in `ccflare` (`better-ccflare`) that can produce or
> propagate a 502 response, the condition each path depends on, and the exact on-host
> evidence that confirms or refutes it.
>
> **Source of truth**: `upstream/main` (`https://github.com/tombii/better-ccflare`,
> `053746c1` at fetch time). Read with `git show upstream/main:<path>` and
> `git grep` — the local worktree cannot materialize `.claude/agents/` on disk
> (sandbox boundary), so every file:line below is against the upstream tree.
>
> **Secondary reference**: `origin/zenprocess-deploy` (`b2c8688e`, dated 2026-05-06)
> — three months behind upstream/main and a plausible match for what ccmax is actually
> running (see §10 for the build-identification evidence the operator must collect to
> confirm or refute this). Where a path I cite differs between the two branches, both
> file:line references are given. **Do not grep for an upstream line that this build
> cannot emit.**
>
> Speculation is labeled. Read-only investigation: no code was modified, no
> commits pushed, no PR opened, no config changed.

---

## 0. Status and scope

**The pool_exhausted 503s the orchestrator surfaced are historical signal, not a live
incident.** The current sample showed 6 such events in a 5-hour window plus
historical `no_account=234` rows, but no ongoing misbehavior — they were a local
artifact of the live-deployment analysis pass. **Do not treat them as evidence of
an active 502 flap.** They are useful only as a *fingerprint* of how the upstream /
load balancer / ccflare stack has misbehaved in the past, and as a positive control
for the queries in §4. They are NOT the same root cause as the 502 flap.

**pool_exhausted 503 ≠ 502 flap.** They are operationally distinct failures. See §6
for the explicit distinction. **No code path in ccflare surfaces a 503 as a 502**, and
no documented nginx / HAProxy / Cloudflare default translates a 503 from the ccflare
backend into a 502 to the client — `proxy_next_upstream` in nginx retries on
`http_502 http_503 http_504` but does NOT rewrite the response code. If the operator
is reading a 502 in client logs and expecting to find `service_unavailable_error` /
`pool_exhausted` bodies in the ccflare DB, they will not.

---

## 1. Every code path that emits or propagates a 502

There are exactly **three** places in the ccflare codebase where an HTTP 502
ever appears in a response. Two are ccflare-generated; one is a passthrough.
All other 5xx codes (500/503/529/429) are handled differently.

For each path below, the presence in `upstream/main` AND `origin/zenprocess-deploy`
is noted. See §10 for why this matters operationally.

### 1a. ccflare-generated 502s

#### Path A1 — `proxyUnauthenticated` catch (the **only** place ccflare itself decides "502 Bad Gateway")

| | upstream/main | origin/zenprocess-deploy |
|---|---|---|
| Exists? | YES, `packages/proxy/src/handlers/proxy-operations.ts:497-517` | YES, `packages/proxy/src/handlers/proxy-operations.ts:~440-460` |

Both branches have the same throw shape:

```
catch (error) {
  logError(error, log);
  throw new ProviderError(
    ERROR_MESSAGES.UNAUTHENTICATED_FAILED,
    ctx.provider.name,
    502,
    { originalError: error instanceof Error ? error.message : String(error) },
  );
}
```

`ProviderError` is defined at `packages/core/src/errors.ts:88-96` with default
`statusCode = 502` in **both** branches. The thrown error then bubbles to the proxy
catch-all:

| | upstream/main | origin/zenprocess-deploy |
|---|---|---|
| Catch-all location | `apps/server/src/server.ts:1284-1306` | `apps/server/src/server.ts` (same shape, earlier branch — exact lines drift slightly) |

The catch-all translates `proxyError.statusCode` directly to the HTTP response status,
so `ProviderError.statusCode === 502` becomes a 502 response with `Content-Type:
application/json` and body `{"type":"error","error":{"type":"proxy_error","message":"Proxy request failed"}}`.
(The `isServiceUnavailable` branch is only `statusCode === 503`, so a ProviderError
does NOT take that branch.)

**Trigger**: `proxyUnauthenticated` is invoked from `packages/proxy/src/proxy.ts` in
the no-accounts-available fallback path (`CCFLARE_PASSTHROUGH_ON_EMPTY_POOL === "1"`).
The `makeProxyRequest` call inside it fails with any thrown error — fetch network
failure, abort, DNS error, ECONNREFUSED, TLS error, response-build error,
body-stream read error. The throw site is a broad `catch (error)`, so the underlying
cause is whatever `globalThis.fetch` (Bun) rejects with, plus any error thrown
between `makeProxyRequest` and `forwardToClient`.

**Transient-or-persistent**: Transient in essentially every realistic cause. Self-recovers
on the next request unless the upstream is persistently unreachable.

**Distinguishing signature in logs**: `ProviderError: ${ERROR_MESSAGES.UNAUTHENTICATED_FAILED}`
= `"Failed to forward unauthenticated request"` with `code: PROVIDER_ERROR`,
`statusCode: 502`, `context: { provider, originalError: <upstream fetch error message> }`.
Then the server.ts catch emits `"Proxy request failed"` at ERROR level.

**Grep that works in BOTH builds**:
```bash
grep -E '"UNAUTHENTICATED_FAILED"|"ProviderError: Failed to forward' "$LOGDIR/app.log"
```

#### Path A2 — Codex SSE error-frame default → 502 fallback

| | upstream/main | origin/zenprocess-deploy |
|---|---|---|
| Exists? | YES, `packages/providers/src/providers/codex/provider.ts:1388` (call site) and `:1768-1806` (definition) | **NO** — `packages/openai-responses-adapter/` does not exist; the Codex SSE→JSON error mapping is absent in this branch |

In upstream/main, `httpStatusForAnthropicErrorPayload` maps:

```
- context_length_exceeded          -> 400
- invalid_request_error            -> 400
- authentication_error             -> 401
- permission_error                 -> 403
- rate_limit_error / rate_limited  -> 429
- overloaded_error                 -> 529
- **everything else**              -> 502 Bad Gateway
```

The fallback **502** fires for any Codex SSE error frame whose `error.type` is none of
the explicitly mapped ones. The Codex provider's `transformSseResponseToJson`
(provider.ts:1281-1395 in upstream/main) rebuilds the entire response as JSON with the
mapped status once the error frame is parsed.

**Trigger**: An Anthropic-shaped SSE upstream returns 200 with an `event: error`
frame whose `error.type` is unmapped. Anthropic's SSE contract normally only emits the
mapped types, but upstream changes / new error variants land here. Self-recovery is a
function of upstream behaviour.

**Distinguishing signature**: `error.type` field is non-null and not in the mapped set
(`/^your input exceeds the context window\b/i` is the only message-pattern fallback to
`invalid_request_error`). Distinguishable in `request_payloads.json`.

**Operator note**: If the deployed build is zenprocess-deploy, **this path cannot fire**.
Grepping for A2 signatures on that build is wasted time.

#### Path A3 — OpenAI Responses adapter JSON-parse fallback (502 in adapter)

| | upstream/main | origin/zenprocess-deploy |
|---|---|---|
| Exists? | YES, `packages/openai-responses-adapter/src/handler.ts:220-230` | **NO** — package does not exist in zenprocess-deploy |

```
} catch {
  return new Response(
    JSON.stringify({
      error: {
        message: "Failed to parse upstream response",
        type: "api_error",
        code: "api_error",
      },
    }),
    { status: 502, headers: { "Content-Type": "application/json" } },
  );
}
```

**Trigger**: Codex CLI sent `/v1/responses` (non-stream). `handleProxy` (via the
adapter) returned a 2xx, but `await anthropicResp.json()` threw — truncated body,
content-type mismatch, malformed JSON.

**Transient-or-persistent**: Transient unless upstream changed wire format.

**Distinguishing signature**: Response body is exactly `{"error":{"message":"Failed to parse upstream response","type":"api_error","code":"api_error"}}`. Affects Codex CLI traffic only.

**Operator note**: If the deployed build is zenprocess-deploy, **this path cannot fire**.

### 1b. ccflare-generated 503/529 (NOT 502, but operationally adjacent)

For completeness when triaging — these produce self-recovering flaps too and are easy
to misread as 502 if the operator only saw an opaque error page. They are **NOT 502**
in the response status. **None of them produce a 502** — see §6 for the explicit
"no 503→502 translation" claim with evidence.

| Path | Status | upstream/main | origin/zenprocess-deploy |
|---|---|---|---|
| `pool_exhausted` 503 | `packages/proxy/src/handlers/proxy-operations.ts` `createPoolExhaustedResponse` | YES | YES |
| `model_family_exhausted` 429 | `packages/proxy/src/handlers/model-capacity.ts` | YES (commit `291b3a82` on upstream/main) | **NO** — package absent |
| `usage_throttled` 529 | `packages/proxy/src/handlers/usage-throttling.ts` | YES | YES (different shape) |
| `Codex overloaded_error` 529 | `packages/providers/src/providers/codex/provider.ts:1801-1803` | YES | **NO** — codex provider shape differs |
| `session_budget exceeded` 429 | `packages/proxy/src/session-governor.ts` | YES | **NO** — file absent |
| `All accounts failed` 503 (`ServiceUnavailableError` → 503) | `packages/proxy/src/proxy.ts` (around line 789 in upstream) | YES | YES (different line — earlier branch) |
| `combo_session_fallback_disabled` 503 | `packages/proxy/src/proxy.ts:60-74` | YES | YES |

### 1c. Upstream-502 passthroughs (NOT generated by ccflare)

These are by far the most likely root cause of the observed flap. ccflare's design is
explicit: it copies the upstream status code through to the client without modification.

#### Path B1 — generic provider pass-through (every non-Codex request)

In BOTH branches, `proxyWithAccount` builds:

```
const taggedRawResponse = new Response(rawResponse.body, {
  status: rawResponse.status,
  statusText: rawResponse.statusText,
  headers: responseHeaders,
});

let response = await provider.processResponse(taggedRawResponse, account, req.headers);
```

Then `forwardToClient` preserves `response.status` on every `new Response(...)` it
emits. The base provider `processResponse` is a no-op pass-through. The Anthropic
provider's `processResponse` (upstream/main: `anthropic/provider.ts:588-601`;
zenprocess-deploy: same shape) preserves status. Both branches also preserve status in
Bedrock, Vertex AI, OpenAI providers.

**Trigger**: Upstream (Anthropic API, OpenAI-compat, Bedrock, Vertex AI, etc.)
itself returns 502 to ccflare. ccflare forwards it transparently.

**Transient-or-persistent**: TRANSIENT in essentially every Anthropic-emitted case.
Anthropic's typical 502 from `api.anthropic.com` is a Cloudflare-fronted 5xx during a
brief regional blip; resolves within seconds-to-minutes without operator action. Matches
the observed self-recovery.

#### Path B2 — Codex SSE stream passthrough (upstream/main only)

| | upstream/main | origin/zenprocess-deploy |
|---|---|---|
| `processResponse` preserves status | YES, `packages/providers/src/providers/codex/provider.ts:601-654` | YES (in its own codex implementation) |

Both Codex implementations preserve status on the rebuilt Response. If the Codex upstream
itself returns a non-2xx (including 502) in its HTTP response (not as a streamed
error frame), it is preserved verbatim through `forwardToClient`. Operationally
indistinguishable from B1 unless the operator correlates request source (Codex CLI vs
Claude Code).

#### Path B3 — OpenAI Responses adapter passthrough (upstream/main only)

| | upstream/main | origin/zenprocess-deploy |
|---|---|---|
| Exists? | YES, `packages/openai-responses-adapter/src/handler.ts:200-218` | **NO** — package absent |

In upstream/main, the adapter preserves `anthropicResp.status` when non-200, so if the
underlying Anthropic upstream returned 502 (Path B1), the adapter forwards it wrapped
in the OpenAI error envelope. Operationally indistinguishable from B1 unless the
operator correlates request source.

**Operator note**: If the deployed build is zenprocess-deploy, **this path cannot fire**.

#### Path B4 — tracker wrapper `trackStreamForShutdown` (upstream/main only)

| | upstream/main | origin/zenprocess-deploy |
|---|---|---|
| Exists? | YES, `apps/server/src/server.ts:1676-1734` | **NO** — wrapper does not exist |

`trackStreamForShutdown` in upstream/main wraps every streaming proxy response in a
passthrough that preserves `status`, `statusText`, `headers`. It exists so shutdown can
error the body mid-stream. **It does NOT rewrite status**; any upstream 502 delivered
via a streaming body arrives at the client with status 502.

**Operator note**: zenprocess-deploy doesn't have this wrapper, but also doesn't need
it — it predates the requirement. Status passthrough happens earlier in the chain
anyway.

#### Path B5 — load-balancer / nginx 502 (NOT a ccflare code path)

This is in **both** branches because the LB is in front of ccflare, not in it.

If ccmax is fronted by nginx / HAProxy / Cloudflare (likely for a `.zp.digital`
host), those proxies emit their own 502 when:
- The ccflare backend is briefly unreachable (TCP refused or timed out from the LB).
- The backend sent an invalid response.
- Upstream-of-upstream (Anthropic, in ccflare's case) timed out and the LB upgraded
  the failure to 502.

This 502 is OBSERVED at the client but NEVER recorded by ccflare — ccflare never saw
the request. The request never reaches the `requests` table. This is critical for
forensics: a load-balancer 502 leaves **no** ccflare-side evidence.

---

## 2. Transient-vs-persistent classification per path

| Path | Source | Transient? | Self-recover? | Plausibility for observed symptom |
|---|---|---|---|---|
| A1 | ccflare (proxyUnauthenticated catch) — present in **both** builds | Almost always | Yes, on next request | LOW — requires `CCFLARE_PASSTHROUGH_ON_EMPTY_POOL=1` AND zero configured accounts AND upstream fetch error simultaneously. |
| A2 | ccflare (Codex SSE error-frame default) — **upstream/main only** | Often | Yes, on next request | LOW–MEDIUM — only fires for Codex traffic; requires an unmapped error type. **Cannot fire on zenprocess-deploy.** |
| A3 | ccflare (Responses adapter JSON parse) — **upstream/main only** | Always | Yes, on next request | LOW — only fires for Codex CLI non-stream requests. **Cannot fire on zenprocess-deploy.** |
| B1 | upstream passthrough — present in **both** builds | Yes (Cloudflare-fronted blips) | Yes within seconds-to-minutes | **HIGH** — matches the symptom exactly. |
| B2 | upstream passthrough (Codex) — present in **both** builds | Yes | Yes | MEDIUM — same mechanism as B1 but for Codex traffic. |
| B3 | adapter passthrough — **upstream/main only** | Yes | Yes | MEDIUM — same mechanism for Codex-CLI clients. |
| B4 | ccflare wrapper — **upstream/main only** | n/a | n/a | n/a — wraps any of B1/B2/B3. |
| B5 | load balancer — external to ccflare, applies in **both** builds | Yes | Yes | **HIGH** — if the LB briefly couldn't reach ccflare, the LB emits its own 502. Indistinguishable from B1 from the client. |

The two highest-plausibility sources are **B1 (Anthropic emitted 502; ccflare
forwarded) and B5 (the LB fronting ccmax emitted 502 during a brief reachability
blip)**. They are distinguishable only by what is visible to ccflare.

---

## 3. Ranked hypotheses with concrete falsifiers

Each hypothesis is ordered by consistency with the symptom (transient 502 that
self-resolves with no operator action, no `requests`-table entries against the affected
window if the LB ate it, no persistent account-state change). Each is paired with the
specific on-host evidence that would CONFIRM or REFUTE it.

Where the hypothesis depends on which build is deployed, that is noted explicitly so
the operator does not waste time grepping for log lines the deployed build cannot emit.

---

### H1 — Anthropic upstream emitted 502; ccflare forwarded it (Path B1)

**Mechanism**: Anthropic's `api.anthropic.com` (or its Cloudflare edge) returned a
502 to ccflare during a brief blip. ccflare wrapped the body in `taggedRawResponse`,
called `provider.processResponse` (no-op), and `forwardToClient` returned it to the
client with status 502. The next request a few seconds later returned 200.

**Confidence level**: HIGH. Anthropic's 502 emission rate is non-zero in production;
the symptom matches exactly.

**Confirm** (build-independent greps):
- The `requests` table contains rows with `status_code = 502` and `account_used = '<some-anthropic-account-id>'` and `error_message` either NULL or containing a Cloudflare error string (`cloudflare`, `error 502`, `Bad gateway`, etc.).
- `error_message` does NOT contain `"UNAUTHENTICATED_FAILED"`, `"Failed to parse upstream response"`, or `"proxy_error"`-type strings (those would point to A1/A3).
- `response_time_ms` is short (<5s) for the 502 rows; the failure was an HTTP-level 502, not a timeout.
- The affected `account_used` rows show no pause, no `paused=1`, no `consecutive_rate_limits` increment.

**Refute**:
- `requests.status_code` shows 503/500 instead of 502 during the flap window.
- The `requests` table has NO rows with `status_code=502` during the flap (then it's not B1 — possibly H5 LB-layer 502).
- `accounts.paused` flips to 1 on any account during the flap (then ccflare reached a different code path).

---

### H2 — Load balancer fronting ccmax emitted 502; ccflare never saw the request (Path B5)

**Mechanism**: nginx / HAProxy / Cloudflare in front of ccmax could not reach the Bun
process during the flap (brief socket exhaustion, a single-second process recycle, a
Bun hot-reload pause, a TCP connection race). The LB returned its own 502 to the
client. ccflare saw no traffic for that request — the `requests` table has no row.

**Confidence level**: HIGH. Many `.zp.digital` hosts sit behind Cloudflare or nginx
with short upstream timeouts; a single missing row in ccflare's DB during a 502 burst
is the smoking gun.

**Confirm**:
- The `requests` table has NO rows with `status_code = 502` during the flap window
  (the LB ate them before ccflare logged them).
- The ccflare process was NOT restarted during the flap.
- The LB's own access log shows 502s with the ccflare backend's IP, possibly with
  `(connect() failed (111: Connection refused))` or `(104: Connection reset)` in
  the LB error log.

**Refute**:
- `requests.status_code = 502` rows exist for the window — then it was H1, not H2.
- The ccflare process DID crash/restart during the window.

---

### H3 — ProviderError(502) from `proxyUnauthenticated` (Path A1)

**Mechanism**: The ccflare pool was empty (no accounts for the requested provider) AND
`CCFLARE_PASSTHROUGH_ON_EMPTY_POOL=1` is set, AND the unauthenticated upstream fetch
failed. Throws `ProviderError(..., 502)`. Server catch returns 502 with body
`{"type":"error","error":{"type":"proxy_error","message":"Proxy request failed"}}`.

**Confidence level**: LOW. This requires three independent conditions simultaneously.
For a production ccmax with active accounts, the empty-pool branch typically isn't
reached — `handleProxy` returns `pool_exhausted` (503) instead.

**Confirm**:
- `requests.status_code = 502` rows exist with `error_message` containing
  `"UNAUTHENTICATED_FAILED"` and the body shape matches Path A1.
- All accounts were paused/filtered at the time of the request.
- `CCFLARE_PASSTHROUGH_ON_EMPTY_POOL=1` in the environment.

**Refute**:
- Any active account was available at the time (then the pool-exhausted 503 branch
  fired, not the 502 branch).
- `CCFLARE_PASSTHROUGH_ON_EMPTY_POOL` is unset / `0`.

**Build dependency**: present in BOTH `upstream/main` (line 497-517) and `origin/zenprocess-deploy`
(roughly line 440-460). Grep is the same for both.

---

### H4 — Codex SSE error-frame default 502 (Path A2)

**Mechanism**: Anthropic returned an SSE stream with an `event: error` frame whose
`error.type` was not in the mapped set. The Codex provider rebuilt the response as
JSON with `status: 502`.

**Confidence level**: LOW–MEDIUM. Only fires for Codex CLI traffic on the upstream/main
build. **Cannot fire on origin/zenprocess-deploy** — that build's codex provider does
not have `httpStatusForAnthropicErrorPayload`.

**Confirm (only meaningful if upstream/main build is deployed)**:
- `requests.status_code = 502` rows exist with `path` in `/v1/messages` AND
  `agent_used` set to a codex-like value AND `request_payloads.json` shows an
  `event: error` SSE body.
- The 502 rows are clustered around Codex CLI activity.

**Refute**:
- 502 rows show `path = /v1/messages` from non-Codex agents.
- Deployed build is `origin/zenprocess-deploy` (then this path cannot exist).

---

### H5 — OpenAI Responses adapter JSON-parse 502 (Path A3)

**Mechanism**: Codex CLI sent a `/v1/responses` POST. The upstream Anthropic response
was 2xx but its body was malformed. The adapter's `await anthropicResp.json()`
threw; the catch returned 502.

**Confidence level**: LOW. **Cannot fire on origin/zenprocess-deploy** — the
`@better-ccflare/openai-responses-adapter` package does not exist there.

**Confirm (only meaningful if upstream/main build is deployed)**:
- `requests.status_code = 502` rows with `path = /v1/responses` AND `error_message`
  containing `"Failed to parse upstream response"`.

**Refute**:
- 502s occur on `/v1/messages` paths.
- Deployed build is `origin/zenprocess-deploy`.

---

### H6 — ccflare process restart / crash; LB returns 502 (Path B5 + restart)

**Mechanism**: The Bun process serving ccmax crashed or restarted (memory pressure,
Bun bug, signal from operator). During the restart window, the LB's upstream timeout
fires and the LB returns 502 to clients. When ccflare comes back, the flap resolves.

**Confidence level**: MEDIUM. The upstream/main build explicitly handles a
postgres-pool error (`ERR_POSTGRES_IDLE_TIMEOUT`) at
`packages/database/src/database-operations.ts:333` with the comment:
`// ERR_POSTGRES_IDLE_TIMEOUT is a normal pool lifecycle event (idle connection
// reaped). Without this handler it bubbles as an unhandled error and crashes the
// process, causing 502s behind a load balancer.`

**CRITICAL BUILD-ASYMMETRY — read this carefully.**

| Build | Postgres pool error handler present? | Behaviour on `ERR_POSTGRES_IDLE_TIMEOUT` |
|---|---|---|
| `upstream/main` | YES — `sqlClient.on?.("error", ...)` filters on `code === "ERR_POSTGRES_IDLE_TIMEOUT"` | Pool error is swallowed; process does NOT crash. |
| `origin/zenprocess-deploy` | **NO** — `packages/database/src/database-operations.ts:225-237` constructs `new SQL({...})` with no `.on("error", ...)` handler | **Any `ERR_POSTGRES_*` event crashes the Bun process.** Idle reaps become process crashes. LB-emits-502. |

If ccmax uses Postgres AND runs `origin/zenprocess-deploy`, every idle connection
reap is a candidate crash. This is the exact scenario the upstream comment warns
about. If ccmax uses SQLite, this build-asymmetry does not apply.

**Confirm**:
- ccmax uses Postgres (`echo $DATABASE_URL | grep -q '^postgres'` returns 0).
- The Bun process exited during the flap window — `journalctl -u better-ccflare`
  shows `Main process exited` or equivalent, followed by a restart within seconds.
- `request_payloads.json` shows no row for the affected request (ccflare died mid-handler).
- The pg log shows an `ERR_POSTGRES_*` error near the flap time.

**Refute**:
- The Bun process was continuous throughout the flap.
- ccmax uses SQLite (then the `ERR_POSTGRES_IDLE_TIMEOUT` path is not in play, but
  any other uncaught error could still crash).

---

### H7 — Auth pool exhaustion under burst; first request after restart races (race window)

**Mechanism**: A burst of concurrent requests arrives just after ccflare comes back
from a brief pause. `getValidAccessToken` throws `ServiceUnavailableError` —
returned as **503**, NOT 502.

**Confidence level**: n/a (doesn't produce 502; refutation of the symptom, not a
confirmation).

---

### H8 — DB lock / write contention; account-availability check failed

**Mechanism**: The `requests` table INSERT blocked behind a long-running WAL
checkpoint. Async write failures are silent — they don't reach the proxy response
path. **Does NOT produce 502.**

**Confidence level**: n/a (refutation).

---

## 4. Operator evidence-collection playbook

> All commands assume a Linux host running ccflare as a systemd unit (or Docker
> container). If ccmax uses a different supervisor, replace `journalctl` /
> `systemctl` with the equivalent (e.g. `docker logs`, `kubectl logs`, `pm2 logs`).
> `<flap_start_epoch_ms>` / `<flap_end_epoch_ms>` are the wall-clock window when
> 502s were observed, converted to Unix milliseconds.

### 4.0 **FIRST — identify which build is deployed**

Single most important step. Resolves all of §10's branch ambiguity and makes every
other query actionable. Do this before anything else.

```bash
# (1) Startup banner — contains the version. Either of:
journalctl -u better-ccflare -n 200 | grep -E '🎯|Server v|LB Strategy|Current strategy'
# or
journalctl -u better-ccflare --since "30 days ago" | grep -m1 -E '🎯 better-ccflare Server v'

# (2) Live API: /api/system/info (present in upstream/main as of commit 053746c1),
# and a `/api/version/check` endpoint that returns the npm-registry latest version.
# NOT a build SHA — but combined with the startup banner version it's strong signal.
curl -s https://ccmax.zp.digital/api/system/info | head -50
curl -s https://ccmax.zp.digital/api/version/check | head -20

# (3) Look for LeastUsed support (zenprocess-deploy has it; upstream/main does NOT
# until further backporting). ccmax returning this means it's at least zenprocess-deploy:
curl -s https://ccmax.zp.digital/api/accounts | jq '.[] | .rateLimitStatus' | head -5
# zenprocess-deploy shape: rateLimitStatus is a STRING ("OK", "Paused", etc.)
# upstream/main shape: rateLimitStatus is an OBJECT with structured fields.
# A string return = evidence for old build.

# (4) /api/accounts deep shape probe (build discrimination):
curl -s https://ccmax.zp.digital/api/accounts | jq '.[0] | keys'
# Compare to zenprocess-deploy's runner.ts:132 and accounts.ts:1545-1570 — which
# expose `rateLimitStatus` (string) and `sessionInfo` (string).
# upstream/main's http-api/src/handlers/accounts.ts exposes structured objects.

# (5) Inspect the on-host source tree or binary if accessible:
ls -la /opt/better-ccflare/ 2>/dev/null
strings $(which better-ccflare 2>/dev/null) 2>/dev/null | grep -E 'better-ccflare Server v|UNAUTHENTICATED_FAILED|httpStatusForAnthropicErrorPayload|@better-ccflare/openai-responses-adapter' | head -10

# (6) /health shape (compare response body to known-good):
curl -s https://ccmax.zp.digital/health | head -50
# upstream/main's health.ts exposes pool.usage_exhausted (commit 053746c1).
# zenprocess-deploy's health.ts does not.

# (7) On-host package.json or version stamp (if ccflare was installed from source):
find /opt/better-ccflare /srv/ccflare /home/*/better-ccflare \
  -name 'package.json' -maxdepth 6 2>/dev/null \
  | head -5 | xargs -I{} sh -c 'echo "==={}==="; jq -r '"'"'.name + " " + .version + " " + (.gitRevision // "no .gitRevision")'"'"' "{}" 2>/dev/null'

# (8) If a Docker image is running:
docker inspect <ccmax_container> --format '{{.Config.Image}}' 2>/dev/null
docker history <ccmax_container> --no-trunc 2>/dev/null | head
```

Expected outputs that pin the build:

| Observation | Suggests |
|---|---|
| Startup banner says `Server v2.x.x` with `Current strategy: least-used` (a string token) | `origin/zenprocess-deploy` (LeastUsedStrategy was added before the upstream split) |
| `/api/accounts` returns `rateLimitStatus` as a string | `origin/zenprocess-deploy`-era build |
| `/api/accounts` returns `rateLimitStatus` as an object | `upstream/main`-era build |
| `/health` response includes `pool.usage_exhausted` (numeric) | `upstream/main` (added 2026-07-09) |
| Process binary contains the string `"UNAUTHENTICATED_FAILED"` | Either build (same in both) — not discriminating |
| Process binary contains the string `"httpStatusForAnthropicErrorPayload"` | `upstream/main` only |
| Process binary contains the string `@better-ccflare/openai-responses-adapter` | `upstream/main` only |
| `/api/version/check` returns version `>= 2026.x` with `usage_exhausted` etc. | `upstream/main` |

The orchestrator's hypothesis is that ccmax runs **something close to**
`origin/zenprocess-deploy` b2c8688e (2026-05-06) based on circumstantial evidence
(`lb_strategy=least-used` available, string-shaped `rateLimitStatus`). These
queries either confirm or refute that hypothesis in 30 seconds.

### 4.1 Locate the running ccflare process

```bash
pgrep -fa 'better-ccflare|ccflare.*serve|bun.*server' || true
ls -la /opt/better-ccflare/ 2>/dev/null
which better-ccflare || command -v ccflare || true

echo "DB path: ${BETTER_CCFLARE_DB_PATH:-$(getent passwd $(id -un) | cut -d: -f6)/.config/better-ccflare/better-ccflare.db}"
echo "Log dir: ${BETTER_CCFLARE_LOG_DIR:-/tmp/better-ccflare-logs}"

ls -la "${XDG_CONFIG_HOME:-$HOME/.config}/better-ccflare/"
```

### 4.2 Inspect the DB (SQLite — the default)

```bash
DB="${BETTER_CCFLARE_DB_PATH:-${XDG_CONFIG_HOME:-$HOME/.config}/better-ccflare/better-ccflare.db}"
sqlite3 -readonly "$DB" <<'SQL'
.headers on
.mode column
-- 1) 502s in the flap window (build-independent)
SELECT timestamp, path, account_used, status_code, error_message,
       response_time_ms, failover_attempts
FROM requests
WHERE status_code = 502
  AND timestamp BETWEEN <flap_start_epoch_ms> AND <flap_end_epoch_ms>
ORDER BY timestamp;

-- 2) ALL requests in the flap window (sample 200)
SELECT timestamp, path, account_used, status_code, success, error_message,
       response_time_ms, failover_attempts
FROM requests
WHERE timestamp BETWEEN <flap_start_epoch_ms> AND <flap_end_epoch_ms>
ORDER BY timestamp
LIMIT 200;

-- 3) Historical pool_exhausted fingerprint (orchestrator-supplied positive control)
-- Confirms greps work against THIS install before relying on absence.
SELECT timestamp, path, account_used, status_code, error_message
FROM requests
WHERE status_code = 503 AND error_message LIKE '%pool_exhausted%'
ORDER BY timestamp DESC LIMIT 50;

-- 4) Account state during the flap
SELECT id, name, provider, paused, pause_reason, rate_limited_until,
       requires_reauth, last_used
FROM accounts;

-- 5) Alerts emitted during the flap
SELECT timestamp, level, type, message, acknowledged
FROM alerts
WHERE timestamp BETWEEN <flap_start_epoch_ms> AND <flap_end_epoch_ms>
ORDER BY timestamp;
SQL
```

### 4.3 Inspect the DB (Postgres)

```bash
if [ "$(echo "$DATABASE_URL" | grep -c '^postgres')" = 1 ]; then
  psql "$DATABASE_URL" <<'SQL'
\copy (SELECT timestamp, path, account_used, status_code, error_message, response_time_ms, failover_attempts FROM requests WHERE status_code = 502 AND timestamp BETWEEN <flap_start_epoch_ms> AND <flap_end_epoch_ms> ORDER BY timestamp) TO '/tmp/ccmax-502s.csv' WITH CSV HEADER
\copy (SELECT timestamp, path, account_used, status_code, success, error_message FROM requests WHERE timestamp BETWEEN <flap_start_epoch_ms> AND <flap_end_epoch_ms> ORDER BY timestamp LIMIT 500) TO '/tmp/ccmax-flap-window.csv' WITH CSV HEADER
\copy (SELECT id, name, provider, paused, pause_reason, rate_limited_until, requires_reauth FROM accounts) TO '/tmp/ccmax-accounts.csv' WITH CSV HEADER
SQL
fi
```

### 4.4 Inspect log files

```bash
LOGDIR="${BETTER_CCFLARE_LOG_DIR:-/tmp/better-ccflare-logs}"
ls -la "$LOGDIR"

# Build-independent: catch the ProviderError 502 (works on both branches)
grep -nE '"UNAUTHENTICATED_FAILED"|"ProviderError: Failed to forward|"status_code":502|"PROVIDER_ERROR"|"502 Bad Gateway"' \
  "$LOGDIR"/app.log | head -200

# Build-specific paths (grep only if upstream/main is confirmed deployed):
# - Codex SSE error-frame default 502   → grep '"overloaded_error"' (the *mapped* types;
#                                          absence of mapped type implies A2 default)
# - Responses adapter JSON-parse 502    → grep '"Failed to parse upstream response"'

ls -t "$LOGDIR"/app*.log | head -5 \
  | xargs grep -hnE '"status_code":502|"PROVIDER_ERROR"|"UNAUTHENTICATED_FAILED"|"level":"ERROR"' \
  | head -200
```

### 4.5 Inspect process state / supervisor

```bash
# systemd:
systemctl status better-ccflare --no-pager -l
journalctl -u better-ccflare --since "<flap_start_iso>" --until "<flap_end_iso>" \
  --no-pager -o short-full \
  | grep -iE "exit|restart|panic|fatal|crashed|unhandled|error|warn" | head -200

# Detect restart in window:
journalctl -u better-ccflare --since "<flap_start_iso>" --until "<flap_end_iso>" \
  | grep -iE "Started better-ccflare|Main process exited|deactivated|stopped"

# Docker:
docker logs <ccmax_container> --since "<flap_start_iso>" --until "<flap_end_iso>" 2>&1 \
  | grep -iE "panic|fatal|unhandled|exit|restart|error|warn|502" | head -200

# k8s:
kubectl logs -n <ns> <pod> --since-time="<flap_start_iso>" --until-time="<flap_end_iso>" \
  | grep -iE "panic|fatal|unhandled|exit|restart|error|warn|502" | head -200
```

### 4.6 Detect Postgres pool errors (build-asymmetric — H6 discriminator)

```bash
# Identify backend:
echo "$DATABASE_URL" | grep -q '^postgres' && echo "PG" || echo "SQLite"

# On the PG host (or RDS / managed-PG console) — search the postgres log for
# ERR_POSTGRES_* codes near the flap time:
grep -E "ERR_POSTGRES_|FATAL|connection|terminating" /var/log/postgresql/*.log \
  | awk -v start="<flap_start_iso>" -v end="<flap_end_iso>" \
    '$1" "$2 >= start && $1" "$2 <= end' | head -100

grep -E "ERR_POSTGRES_IDLE_TIMEOUT|ERR_POSTGRES_UNSUPPORTED_INTEGER_SIZE|ERR_POSTGRES_" \
  /var/log/postgresql/*.log | tail -50
```

### 4.7 Inspect LB / reverse proxy

```bash
# nginx:
grep -E '"[^"]* HTTP/[0-9.]+" 502' /var/log/nginx/ccmax-access.log* \
  | awk -v start="<flap_start_iso>" -v end="<flap_end_iso>" \
    'substr($4,2) >= start && substr($4,2) <= end' | head -100

grep -E 'connect\(\) failed|Connection refused|upstream prematurely closed|504|502' \
  /var/log/nginx/ccmax-error.log | tail -200

# Caddy:
grep -E 'status_code=502|upstream.*error' /var/log/caddy/*.log | tail -200

# Cloudflare (if ccmax is CF-fronted):
# Dashboard → Analytics → Status codes 502 per minute during the flap window.
# Cloudflare-emitted 502s have no `cf-cache-status` and `cf-ray` headers showing
# they originated from the CF edge, not the ccflare origin.
```

### 4.8 Live triage (if flapping right now)

```bash
# Live 502 watcher:
watch -n 1 'sqlite3 -readonly "$DB" \
  "SELECT timestamp, path, account_used, status_code, error_message \
   FROM requests WHERE timestamp >= strftime(\"%s\",\"now\")*1000 - 60000 \
   AND status_code = 502 ORDER BY timestamp DESC LIMIT 20;"'

# Live log tail:
tail -F /tmp/better-ccflare-logs/app.log \
  | grep --line-buffered -E '"status_code":502|"PROVIDER_ERROR"|"level":"ERROR"|"UNAUTHENTICATED_FAILED"|"502 Bad Gateway"'

# Live /health:
while true; do curl -s -o /dev/null -w '%{http_code}\n' \
  https://ccmax.zp.digital/health; sleep 1; done

# Live build-discrimination:
while true; do curl -s https://ccmax.zp.digital/api/accounts \
  | jq -r '.[0] | to_entries | .[] | select(.key | test("rateLimitStatus|sessionInfo")) | "\(.key): \(.value | type)"' \
  | head -5; sleep 30; done
```

---

## 5. Forensic recoverability after self-recovery

What survives the flap, ranked by durability:

| Evidence | Source | Retention | Survives restart? | Survives flap? |
|---|---|---|---|---|
| Request rows with `status_code=502` | `requests` table | **Default 90 days** (`REQUEST_RETENTION_DAYS`); payloads **3 days** (`DATA_RETENTION_DAYS`) | YES (DB-backed) | YES — but only if the request actually reached ccflare (paths A1/A2/A3/B1/B2/B3). **NOT captured for LB-layer 502s (H2).** |
| Request payloads (`request_payloads.json`) | DB | 3 days default | YES | YES (subject to retention). Captures the raw response body — primary tool for distinguishing B1 vs A2 vs A3. |
| Account pause / rate-limit state | `accounts` table | Permanent | YES | YES — gives post-flap state of every account. |
| Alerts (`alerts` table) | DB | Permanent (until acknowledged/deleted) | YES | YES — the proxy emits alerts for several flapping conditions. |
| `app.log` (JSON-formatted) | `${BETTER_CCFLARE_LOG_DIR}/app.log` or `/tmp/better-ccflare-logs/app.log` | **10MB rotating** (`LOG_FILE_MAX_SIZE = 10 * 1024 * 1024` at `packages/logger/src/file-writer.ts:11`); truncated on rotation. Same in **both** branches. | NO (overwritten on rotation) | YES — but only if retention hasn't cycled the file. Snapshot before any cleanup. |
| stdout / journald | systemd / container runtime | Depends on host journald config | NO (journal rotates) | YES — usually. Use `journalctl -u <service> --since <flap_start>` immediately. |
| Postgres pool errors | `/var/log/postgresql/*.log` (or managed-PG console) | Depends on `log_rotation_*` | NO | YES (subject to rotation). |
| LB access log | `/var/log/nginx/*` (or Caddy / Cloudflare) | Depends on `logrotate` config | NO | YES (subject to rotation). **Only evidence for H2/H6 (LB-emitted 502).** |
| Process restart record | systemd / docker / k8s | systemd: indefinite in journal; docker: until log driver rotates; k8s: depends | YES (in journal) | YES — but only if the supervisor journal covers the flap window. |
| **Build identifier** | startup banner / binary strings / `/api/system/info` | Permanent (in journal) | YES | YES — do not lose this. |

**Bottom line**: yes, the flap is forensically recoverable — **provided** the flap was
captured by ccflare's DB and logs. If the LB ate the request before ccflare saw it
(H2 / H6), the only evidence is in the LB's own logs and the systemd journal.

### 5.1 Critical pre-investigation steps (do these BEFORE waiting for retention to roll)

```bash
# 1. Snapshot the DB immediately:
DB="${BETTER_CCFLARE_DB_PATH:-${XDG_CONFIG_HOME:-$HOME/.config}/better-ccflare/better-ccflare.db}"
sqlite3 "$DB" ".backup /tmp/ccmax-db-snapshot-$(date +%Y%m%d-%H%M%S).db"

# 2. Snapshot the log directory:
LOGDIR="${BETTER_CCFLARE_LOG_DIR:-/tmp/better-ccflare-logs}"
tar czf /tmp/ccmax-logs-$(date +%Y%m%d-%H%M%S).tgz "$LOGDIR"

# 3. Snapshot the journal (30 days minimum):
journalctl -u better-ccflare --since "30 days ago" \
  > /tmp/ccmax-journal-$(date +%Y%m%d-%H%M%S).log

# 4. Snapshot nginx (or other LB) logs:
sudo tar czf /tmp/ccmax-lb-logs-$(date +%Y%m%d-%H%M%S).tgz \
  /var/log/nginx/ /var/log/caddy/ 2>/dev/null

# 5. Process state right now:
ps -fp $(pgrep -f better-ccflare) > /tmp/ccmax-ps-$(date +%Y%m%d-%H%M%S).txt
cat /proc/$(pgrep -f better-ccflare)/environ | tr '\0' '\n' \
  > /tmp/ccmax-env-$(date +%Y%m%d-%H%M%S).txt

# 6. Build identifiers (snapshot before any change to /opt or the container):
journalctl -u better-ccflare --since "60 days ago" | grep -m1 '🎯 better-ccflare Server v' \
  > /tmp/ccmax-build-version-$(date +%Y%m%d-%H%M%S).txt

curl -s https://ccmax.zp.digital/api/system/info \
  > /tmp/ccmax-api-system-info-$(date +%Y%m%d-%H%M%S).json 2>/dev/null
curl -s https://ccmax.zp.digital/api/version/check \
  > /tmp/ccmax-api-version-$(date +%Y%m%d-%H%M%S).json 2>/dev/null
```

If `cleanupOldRequests` runs on a daily cadence, the 502 rows could be aged out within
`REQUEST_RETENTION_DAYS` (default 90). The `request_payloads` rows are aged out in
3 days. **Pull the snapshot within 72 hours of the flap to preserve payload-level evidence.**

---

## 6. Why pool_exhausted 503 and 502 flap do NOT conflate

The orchestrator's explicit question: could any code path surface a 503 as a 502
(e.g. a proxy in front translating upstream 503 into 502)?

**Answer: NO, in this codebase, in this deployment topology.**

### 6.1 ccflare-side: distinct throws → distinct status codes

The proxy catch-all in `apps/server/src/server.ts` (upstream/main:1284-1306;
zenprocess-deploy: same shape) maps `proxyError.statusCode` **directly** to the HTTP
response status. There is no mapping:

| Thrown | `statusCode` field | HTTP response status returned |
|---|---|---|
| `ProviderError` | **502** (default in both branches) | **502** |
| `ServiceUnavailableError` | **503** (constant) | **503** |
| `ValidationError` | **400** (constant) | **400** |
| `RateLimitError` | **429** (constant) | **429** |
| `AuthError` | **401** (constant) | **401** |
| A bare `Error` | not present | falls back to `HTTP_STATUS.INTERNAL_SERVER_ERROR = 500` |
| A `pool_exhausted` Response directly (no throw) | n/a | **503** (built into `createPoolExhaustedResponse`) |
| A `usage_throttled` Response directly | n/a | **529** |
| A `session_budget` Response directly | upstream/main only | **429** |

There is **no code path that emits a 502 from a 503** in ccflare, in either branch.

### 6.2 LB-side: nginx / HAProxy / Cloudflare default behaviour

| Behaviour | nginx default | HAProxy default | Cloudflare |
|---|---|---|---|
| Translate response code | NO | NO | NO (apart from CF-specific 5xx generation) |
| Retry on upstream `http_502 http_503 http_504` and re-send to client | YES (configurable via `proxy_next_upstream`) — but the response code is whatever the upstream eventually responded with | YES — same logic | similar |
| Generate own 5xx when upstream unreachable | YES — emits its own 502 | YES — emits its own 502/503/504 depending on cause | YES — emits 502/520/521/522/523/524 |

**Conclusion**: a 503 from ccflare's backend would be forwarded to the client as a
503 (with `proxy_next_upstream` retrying once if enabled). The LB only emits its own
502 when ccflare itself is unreachable. So the operator can rely on:

- Client saw 502 with body containing `"pool_exhausted"` or `"service_unavailable_error"`
  → IMPOSSIBLE — no ccflare code path produces that body shape with a 502 status.
- Client saw 502 with body `{"type":"error","error":{"type":"proxy_error","message":"Proxy request failed"}}`
  → ccflare-synthesized (Path A1 only) or LB-emitted (Path B5).
- Client saw 502 with body containing upstream's original error body
  → upstream 502 forwarded (Path B1 / B2 / B3).
- Client saw 502 with body `{"error":{"message":"Failed to parse upstream response",...}}`
  → Path A3 (only if upstream/main is deployed).
- Client saw 503 with body containing `"pool_exhausted"`
  → Path 1b's first entry — this is the historical fingerprint the orchestrator surfaced,
  orthogonal to and **distinct from** the 502 flap.

**Therefore the operator should grep for these distinct signatures and not expect them to overlap.**

---

## 7. Quick triage decision tree

```
ccmax returns 502
  │
  ├── Step 0: WHICH BUILD IS DEPLOYED?
  │   see §4.0 commands — fixes the rest of the decision tree
  │
  ├── Step 1: Does the requests table have rows with status_code=502 in the flap window?
  │   │
  │   ├── NO  → H2 (LB 502, ccflare never saw the request) or H6 (process restart +
  │   │         LB 502, esp. if PostgreSQL backend + zenprocess-deploy which lacks
  │   │         the ERR_POSTGRES_IDLE_TIMEOUT filter)
  │   │         Check: nginx error log, systemd journal, process continuity,
  │   │                pg log for ERR_POSTGRES_* events.
  │   │
  │   └── YES → 502 came from ccflare itself or a forwarded upstream
  │       │
  │       ├── error_message contains "UNAUTHENTICATED_FAILED" → H3 (Path A1, both builds)
  │       │
  │       ├── path = /v1/responses AND error contains "Failed to parse" → H5 (Path A3,
  │       │   UPSTREAM/MAIN ONLY — package absent on zenprocess-deploy)
  │       │
  │       ├── path = /v1/messages AND request_payloads.json shows an "event: error"
  │       │   SSE body with unmapped error.type → H4 (Path A2, UPSTREAM/MAIN ONLY)
  │       │
  │       ├── error_message is NULL or Cloudflare-shaped, response_time_ms < 5s
  │       │   → H1 (Path B1, both builds)
  │       │
  │       └── (none of the above, and build is zenprocess-deploy)
  │           → re-examine all possible upstream 502 sources and LB; ensure
  │             you've ruled out H2/H6.
  │
  └── For H1 specifically: was there any account state change (pause, rate-limit,
      requires_reauth) coincident with the flap? If NO → pure upstream flapped.
      If YES → correlate: did the upstream flap CAUSE the state change, or did a
      separate rate-limit burst CAUSE the 502 to surface?
```

---

## 8. What the upstream comment trail tells us

`packages/database/src/database-operations.ts:333` (upstream/main only — `zenprocess-deploy`
does NOT have this handler):

```
// ERR_POSTGRES_IDLE_TIMEOUT is a normal pool lifecycle event (idle connection
// reaped). Without this handler it bubbles as an unhandled error and crashes the
// process, causing 502s behind a load balancer.
sqlClient.on?.("error", (err) => {
  if (err?.code === "ERR_POSTGRES_IDLE_TIMEOUT") return;
  console.error("[postgres] pool error:", err);
});
```

This is from the ccflare maintainers and documents that **process-crash → 502-behind-LB
is a real, observed failure mode**. The fix is the filter on `ERR_POSTGRES_IDLE_TIMEOUT`.
**`origin/zenprocess-deploy` does not have this filter** — see the build-asymmetry
note in H6.

`packages/proxy/src/__tests__/incident-2026-07-09-health-flap.test.ts` documents a
**prior** flap incident (2026-07-09):

> Characterization tests for the 2026-07-09 incident: upstream 429s on every
> unpaused account (no model fallbacks configured) benched the whole pool via
> account-wide cooldowns, so NEW sessions received 503 pool_exhausted while
> /health flipped back to `routable: N` as soon as each short backoff lapsed —
> even though nothing upstream had changed.

That incident produced **503s, not 502s** — but the "flip back to routable on its own"
mechanism is the same shape as the observed symptom. Worth reading the test file
for clues if the flap repeats.

---

## 9. Files referenced (every file:line in this document)

Upstream/main ref → origin/zenprocess-deploy ref, with build-absence flagged where
applicable.

| Concept | upstream/main | origin/zenprocess-deploy |
|---|---|---|
| `ProviderError` class with default 502 | `packages/core/src/errors.ts:88-96` | same shape |
| `ServiceUnavailableError` 503 | `packages/core/src/errors.ts:111-119` | same shape |
| `HTTP_STATUS` constants (no 502 entry) | `packages/core/src/constants.ts:290-297` | same shape (different set) |
| `BadGateway()` factory — not actually invoked in proxy | `packages/errors/src/index.ts:60-61` | same shape |
| Postgres pool error handler | `packages/database/src/database-operations.ts:333` | **ABSENT** — `database-operations.ts:225-237` only constructs `new SQL({...})` |
| `requests` table schema | `packages/database/src/migrations.ts:130-167` | same shape, possibly older column set |
| `saveRequest` / `saveRequestPayload` | `packages/database/src/database-operations.ts:950-1033` | same shape |
| `cleanupOldRequests` (retention) | `packages/database/src/database-operations.ts:1175-1211` | same shape |
| Log writer + rotation 10MB | `packages/logger/src/file-writer.ts:11, 57-63` | same shape |
| **Path A1** — `ProviderError(502)` in `proxyUnauthenticated` | `packages/proxy/src/handlers/proxy-operations.ts:497-517` | `~440-460` (same shape) |
| **Path B1** — upstream status passthrough | `packages/proxy/src/handlers/proxy-operations.ts:1156-1173` and `response-handler.ts` preserves status | same shape |
| 503 `createPoolExhaustedResponse` | `packages/proxy/src/handlers/proxy-operations.ts:~1419-1471` | ~959-... |
| Proxy catch-all (statusCode translation) | `apps/server/src/server.ts:1284-1306` | same shape, earlier commit |
| **Path B4** — `trackStreamForShutdown` wrapper | `apps/server/src/server.ts:1676-1734` | **ABSENT** |
| **Path A2** — Codex SSE error-frame default 502 | `packages/providers/src/providers/codex/provider.ts:1388, 1768-1806` | **ABSENT** — codex provider shape differs |
| Codex stream transform preserving status (B2) | `packages/providers/src/providers/codex/provider.ts:601-654` | present, slightly different shape |
| **Path A3** — Responses adapter JSON parse 502 | `packages/openai-responses-adapter/src/handler.ts:220-230` | **ABSENT** — package does not exist |
| Path B3 — Responses adapter passthrough | `packages/openai-responses-adapter/src/handler.ts:200-218` | **ABSENT** |
| `usage-collector.ts` worker model | `packages/proxy/src/usage-collector.ts` (whole file) | **ABSENT** — `usage-worker-controller.ts` + `post-processor.worker.ts` instead |
| `session-governor.ts` (session budget 429) | `packages/proxy/src/session-governor.ts` | **ABSENT** |
| `model-capacity.ts` (model_family_exhausted) | `packages/proxy/src/handlers/model-capacity.ts` | **ABSENT** |
| `anthropic-terminal-recovery.ts` | `packages/proxy/src/anthropic-terminal-recovery.ts` | **ABSENT** |
| LeastUsed load-balancing strategy | absent | `packages/load-balancer/src/strategies/least-used.ts` |
| Startup banner with `🎯 Server v${version}` | `apps/server/src/server.ts:1380-1395` | `apps/server/src/server.ts:1080-1100` |
| `/api/system/info` (build-independent) | `packages/http-api/src/handlers/system.ts:1-45` | same path / shape |
| `/api/version/check` | `packages/http-api/src/handlers/version.ts:1-67` | same path / shape |
| DB path resolver | `packages/database/src/paths.ts:5-19`; `packages/config/src/paths-common.ts:8-25` | same shape |
| Retention defaults | `docs/database.md:509-511` | same shape |
| 502 in unauthenticated fallback flow | `docs/data-flow.md:478-481` | absent in repo as of b2c8688e |
| Status code reference | `docs/api-http.md:982-983` | same shape |

---

## 10. Build discrimination — which branch is ccmax running?

This is the single most important fact to confirm before trusting any of the
hypothesis greps. **The orchestrator-cited circumstantial evidence:**

| Signal | What ccmax shows | What it suggests |
|---|---|---|
| `lb_strategy=least-used` available as a value | (per orchestrator's observation) | `origin/zenprocess-deploy` (LeastUsed was added there) |
| `rateLimitStatus` / `sessionInfo` returned as **strings** | (per orchestrator's observation) | older API shape; consistent with `origin/zenprocess-deploy` |

Treat this as **HYPOTHESIS, NOT FACT** until the operator runs §4.0 and confirms.

If ccmax is closer to `origin/zenprocess-deploy` b2c8688e:
- Hypotheses H4 (Path A2) and H5 (Path A3) **cannot be the cause** — those code paths
  don't exist in the deployed build. Don't bother grepping for their signatures.
- Hypothesis H6 (process crash) is **substantially more likely** — that build does
  NOT have the `ERR_POSTGRES_IDLE_TIMEOUT` filter that prevents idle-connection
  reaps from crashing the process. If ccmax uses Postgres, every idle reap is a
  crash candidate.
- Hypotheses H1, H2, H3 (Paths B1, B5, A1) remain the primary candidates.

If ccmax is closer to `upstream/main`:
- All seven hypotheses remain on the table.
- H4 and H5 are only meaningful in this build.
- The `ERR_POSTGRES_IDLE_TIMEOUT` filter exists and H6 is harder to trigger via that
  specific bug.

**The boundary in this analysis is intentional:** every hypothesis that depends on
upstream/main-only code says so explicitly. The operator does not waste cycles
grepping for log lines the deployed build cannot emit.

---

## 11. Summary

**Three** 502 paths are generated by ccflare (A1, A2, A3), and **four** are pure
upstream passthroughs (B1–B4), plus one (B5) that comes from the load balancer in
front of ccflare. Of these:
- **A1** is present in **both** `upstream/main` and `origin/zenprocess-deploy`.
- **A2, A3, B3, B4** are present **only in upstream/main** — they require packages or
  wrappers that `origin/zenprocess-deploy` does not have.
- **B1, B2, B5** are present in both.

For a transient, self-recovering 502 with no operator intervention, **H1 (upstream
Anthropic 502 forwarded by ccflare) and H2 (LB-front 502 with no ccflare-side record)
are the highest-plausibility hypotheses**. If the deployed build is the orchestrator's
hypothesized `origin/zenprocess-deploy`, **H6 (process crash via missing
`ERR_POSTGRES_IDLE_TIMEOUT` filter on Postgres) is also a leading candidate** and
matches the symptom exactly.

**First action**: confirm the deployed build via §4.0. Once that is pinned, every
hypothesis grep becomes either useful or immediately refutable.

**pool_exhausted 503s surfaced by the orchestrator's analysis pass are historical
signal — NOT evidence of an active 502 flap.** They are useful only as a positive
control to validate query syntax, and as proof that ccflare's existing
`requests`-table greps work. **They do not conflate with the 502 flap.**

The flap is forensically recoverable: requests / payloads / accounts / alerts tables
persist; app.log + systemd journal cover the in-process evidence. Snapshot the DB
and logs within 72 hours (the default payload-retention window) to preserve
payload-level evidence that distinguishes A1/A2/A3 from B1.

No code was modified. No commits pushed. No PR opened. No config changed.
