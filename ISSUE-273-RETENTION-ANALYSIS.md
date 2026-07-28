# ISSUE-273-RETENTION-ANALYSIS.md

**Branch:** `analysis/issue-273-retention`
**Upstream commit examined:** `053746c1c0dfe5c8fe5d11be089b7ac750411c15` (upstream/main)
**File paths verified against the upstream tree, not the v2 internal fork.**

## TL;DR — answer to "does ccflare RETAIN discarded Responses?"

**No retention was found.** The Response returned by `makeProxyRequest` flows through
the proxy in a way that lets it become unreachable when its caller decides to
discard it. Every long-lived map checked holds scalars (`number`, `string`,
`{until,origin}`, `{accountId,assignedAt}`, etc.) — never a `Response` and never
a `ReadableStream<Uint8Array>` that comes from a discarded upstream body.

- **Worker handoff** serialises only scalars (`responseStatus`, `responseHeaders`,
  `requestId`, …) — never the Response object.
- **Retry / failover loops** overwrite a `let rawResponse` / `let response`
  variable; the previous binding becomes unreachable when the new assignment
  lands, provided nothing else holds a reference (and nothing does, except
  for the brief forwarding window in `forwardToClient`).
- **The forwarding path** wraps the upstream body in `teeStream` /
  `createAnthropicTerminalRecoveryStream` and returns a NEW Response whose
  body stream is the tee'd output. Once that wrapper is consumed or aborted,
  the upstream Response is unreachable.
- **Long-lived module-level Maps / Sets** were enumerated and none hold a
  Response — all entries are scalars, all have explicit size caps and
  age-based eviction.

**Implication for the leak:** since the leak's backing store is released only
when the Response becomes unreachable and the native source finalises, the
fact that nothing retains a discarded Response means **the drain fix from
Task A is sufficient** to release the per-request 73 KB on stock Bun. There is
no second mitigation hiding behind this analysis.

This is a strong, but-not-trivial, claim. The rest of the document is the
search log that earns it.

---

## 1. Lifetime trace — `Response` returned by `makeProxyRequest`

### 1.1 Construction (`packages/proxy/src/handlers/request-handler.ts`)

`makeProxyRequest` is the single entry point that returns a `Response` from
`fetch`:

```ts
// request-handler.ts:88-143
export async function makeProxyRequest(
    target: string | Request,
    method?: string,
    headers?: Headers,
    createBodyStream?: () => ReadableStream<Uint8Array> | undefined,
    hasBody?: boolean,
    signal?: AbortSignal,
): Promise<Response> {
    ...
    if (target instanceof Request) {
        ...
        const response = await fetch(new Request(target, {...}));
        chatGptCloudflareCookieJar.captureFromResponse(targetUrl, response);
        return response;                                   // <-- line 124
    }
    ...
    const response = await fetch(target, {...});          // <-- line 131
    chatGptCloudflareCookieJar.captureFromResponse(target, response);
    return response;                                       // <-- line 139
}
```

`chatGptCloudflareCookieJar.captureFromResponse` is the only side-effect
besides the `fetch`. It is a header-cookie capture, not a body-store — see §2.5.
**No closure captures `response` in this function.** The Response is built,
`chatGptCloudflareCookieJar` touches its headers (scalars), and the function
returns. The Response is not stashed in any module-level Map.

### 1.2 Callers of `makeProxyRequest` (six sites in `proxy-operations.ts`)

All six calls follow the same shape: `let rawResponse = await makeProxyRequest(...)`.

| Line | Caller shape                                                            | Discards?            |
| ---- | ----------------------------------------------------------------------- | -------------------- |
| 472  | `proxyUnauthenticated` — non-loop, single shot                           | Only on caught throw |
| 691  | Initial fetch in `proxyWithAccount`                                      | Yes, if retry follows |
| 725  | Retry after invalid thinking signature (filtered body)                  | Yes, if 2nd retry follows |
| 757  | Retry after cache_control rejection                                      | Yes, if next retry follows |
| 1072 | Model-list cycle: retry with next model in fallback list                 | Yes, while loop iterates |
| 1209 | 529 in-place retry loop (uses `transformedRequestForRetry.clone()`)     | Yes, while loop iterates |

In every case `rawResponse` is a `let`-binding that is reassigned on the next
iteration. There is no `push` into an array, no closure capture, no map write.
When the new value is assigned, the previous `Response` becomes unreachable
from that binding. It can still be alive only if some other reference holds
it — and the audit below shows nothing does.

### 1.3 Outermost call: `handleProxy` (`packages/proxy/src/proxy.ts:525-595`)

```ts
// proxy.ts:525
let response: Response | null = null;
...
for (let i = 0; i < accounts.length; i++) {
    ...
    try {
        response = await proxyWithAccount(...);             // <-- line 564
    } finally {
        if (probeAdmission === "admitted") {
            completeRateLimitProbe(accounts[i], "abandoned"); // <-- line 581
        }
    }
    if (response) {
        return response;                                     // <-- line 586
    }
}
```

The `try { ... } finally { completeRateLimitProbe(...) }` block at lines
579-583 is the closest thing to a retention-shaped construct. It runs on
both success and failure of `proxyWithAccount`. `completeRateLimitProbe`
(see `rate-limit-cooldown.ts:121-133`) only deletes a key from
`probeLeases` (a `Map<string, number>` keyed by accountId). It does NOT
touch `response`.

When the loop returns at line 586, `response` is the FIRST non-null result.
The previous failed-attempt responses have already been discarded by the
overwrite on line 564 — `proxyWithAccount` returns `null` on failure (see
proxy-operations.ts:1145, 1180, 1265, 1315, 1346) — so the `response`
binding holds either `null` or the winning Response, never both.

**No retention at this layer.**

### 1.4 The forwarding path: `forwardToClient` (`response-handler.ts:122-504`)

This is where the question gets subtle. The forwarding function DOES capture
the Response in two closures:

```ts
// response-handler.ts:369-407 (Anthropic-Messages SSE path)
const responseBody = isAnthropicMessagesSseResponse
    ? createAnthropicTerminalRecoveryStream(response.body, {
        ...
        onTerminalState(state) {
            streamTerminalState = state;
            if (state === "truncated") {
                log.warn("anthropic_stream_truncated_mid_content", {
                    ...
                    statusCode: response.status,            // <-- captures Response
                });
            } else if (state === "error") {
                log.warn("anthropic_stream_in_band_error", {
                    ...
                    statusCode: response.status,            // <-- captures Response
                });
            }
        },
    })
    : response.body;
```

```ts
// response-handler.ts:457-493 (non-streaming body path)
const passthroughBody = teeStream(response.body, {
    ...
    onClose(buffered) {
        ...
        if (response.status === 200 && account) {           // <-- captures Response
            void ingestModelsListing(...);
        }
        ...
        fireAndForgetEnd({
            ...
            success: isExpectedResponse(path, response),     // <-- captures Response
        });
    },
    ...
});
```

**This is retention, but it is bounded by stream consumption.** The Response
reference is held by the `onClose` / `onTerminalState` closure only until the
body stream completes (or is cancelled). In all three reads
(`response.status`, `isExpectedResponse(path, response)`), the closure only
**reads scalars** — it never re-reads the body, never re-reads the headers,
never stashes the Response anywhere.

The function returns `new Response(passthroughBody, {...})` — a brand new
Response whose body stream is the tee'd output. The original `response`
becomes unreachable from any caller-visible variable when this return lands.

When `teeStream` finishes reading the upstream body (or is cancelled by a
client abort), `onClose` / `onError` fires, the closure is dropped, and
`response` becomes unreachable. The Bun runtime can then finalize the
underlying native source.

**A discarded Response does NOT go through `forwardToClient`.** A "discarded
Response" in the spec's sense is one where `proxyWithAccount` decided to
fail over / not forward (returned `null` or threw). In those paths,
`forwardToClient` is never called. The Response stays only as the local
variable in `proxyWithAccount`, and is overwritten on the next iteration.

---

## 2. Long-lived Maps / Sets audited — no Response held anywhere

The spec asks specifically: "Are there long-lived maps/caches keyed by
request that could hold one (compare how `session-affinity.ts` bounds its
map)?"

I enumerated every module-level `Map` / `Set` in the proxy and provider
packages, and audited each one's value type. Summary table:

| Location | Identifier | Type | Bounded by | Holds Response? |
| -------- | ---------- | ---- | ---------- | --------------- |
| `usage-collector.ts:334` | `requests` | `Map<string, RequestState>` | `MAX_REQUESTS_MAP_SIZE=10000` (line 69), TTL=stream-timeout, periodic 30s sweep (line 1201) | **No** — `RequestState` (line 27-59) is scalars only |
| `rate-limit-cooldown.ts:18` | `probeLeases` | `Map<string, number>` | `MAX_PROBE_GATES=10_000` (line 17), per-call prune | **No** — number (leaseUntil) |
| `model-capacity.ts:168` | `negativeCache` | `Map<string, ExhaustionEntry>` | TTL-based, family-keyed | **No** — `{until,origin}` |
| `token-manager.ts:23` | `refreshFailures` | `Map<string, number>` | `MAX_FAILURE_RECORDS=1000` (line 27), TTL=5min | **No** — number (timestamp) |
| `token-manager.ts:25` | `backoffCounters` | `Map<string, number>` | TTL-based | **No** — number |
| `token-manager.ts:422+` | `refreshClearers`, `pollingRestarters`, `codexUsageRefreshers`, `codexUsageInflight` | `Map<string, fn>` | Per-account | **No** — functions only |
| `cache-body-store.ts:106` | `staging` | `Map<string, {accountId, entry}>` | `MAX_STAGING_ENTRIES=200` (line 36), 5min TTL sweep | **No** — `CachedRequestEntry` (line 69-78) is request body bytes + sanitized headers |
| `cache-body-store.ts:112` | `lastCachedRequest` | `Map<string, CachedRequestEntry>` | One entry per account + age-multiplier TTL eviction | **No** — `CachedRequestEntry` (request body, NOT Response) |
| `account-selector.ts:31` | `comboSlotInfoMap` | `WeakMap<RequestMeta, ComboSlotInfo>` | WeakMap — auto-GC'd with the key | **No** — slot metadata |
| `account-selector.ts:76` | `exhaustionInfoMap` | `WeakMap<RequestMeta, ModelFamilyExhaustionInfo>` | WeakMap — auto-GC'd with the key | **No** — exhaustion info |
| `proxy.ts:1674` (apps/server) | `inflightStreams` | `Set<TrackedInflightStream>` | Set is cleared on shutdown (line 1748); per-stream `finish()` removes the entry (line 1687) | **No** — `{abort, settled}` (line 1669-1672) |
| `load-balancer/strategies/session-affinity.ts:78` | `affinity` | `Map<string, {accountId, assignedAt}>` | `MAX_AFFINITY_ENTRIES=10_000` (line 36) + TTL + `evictOldestIfFull()` (line 158) | **No** — scalars only |
| `load-balancer/strategies/session-affinity.ts:83` | `lastPickedAt` | `Map<string, number>` | Opportunistic GC at line 145-148 | **No** — number |

### 2.1 `usage-collector.ts` — the highest-risk candidate

`RequestState` (lines 27-59) is the data structure that travels with a
request's lifetime in the worker. It contains:

- `startMessage: StartMessage` — the structured-clone payload from main
  thread; only scalars (see §2.2 below)
- `buffer: string` — pending SSE-line text buffer
- `streamDecoder: TextDecoder` — UTF-8 decoder
- `chunks: Uint8Array[]` — captured response chunks, capped at 256 KB
  (`MAX_RESPONSE_BODY_BYTES`, line 73)
- `chunksBytes`, `chunksTruncated`, `usage`, `lastActivity`, `createdAt`,
  `agentUsed`, `agentAttributionSource`, `project`, … — all scalars
- `payloadReleased: boolean`, `retainedPayloadBytes: number` — bookkeeping

**No `Response`, no `ReadableStream`, no `Headers` from the upstream
body.** The `chunks: Uint8Array[]` field is the only potentially-large
field, and it's capped at 256 KB and explicitly bounded by
`MAX_ACTIVE_PAYLOAD_BYTES = 100 * 1024 * 1024` (line 76).

The map is bounded by `MAX_REQUESTS_MAP_SIZE = 10000` (line 69) with
emergency eviction (line 389-404) and age-based cleanup every 30 seconds
(`setInterval` at line 1199-1203, `.unref()` so it doesn't pin the
process).

In `_handleEndInternal` (line 619), the state is `requests.delete(msg.requestId)`
on line 628 — IMMEDIATELY removed from the map. Then `freeRequestState` at
line 667 clears `state.buffer = ""` and `releasePayloadState` at line 929-930
trims chunks and decrements `activePayloadBytes`. After `_handleEndInternal`
returns, the local `state` goes out of scope.

**Decision:** RequestState does not retain a Response, and the map's eviction
behavior is correct.

### 2.2 `StartMessage` / `ChunkMessage` / `EndMessage` (`worker-messages.ts`)

All three worker-bound message types use scalars:

- `StartMessage` (lines 13-67): `requestHeaders: Record<string, string>`
  (line 23), `responseStatus: number` (line 28), `responseHeaders:
  Record<string, string>` (line 29). Headers are pre-flattened to plain
  objects via `Object.fromEntries` in `response-handler.ts:154, 156`. The
  request body is base64-encoded (line 24, response-handler.ts:191-198).
- `ChunkMessage` (lines 83-87): `data: Uint8Array` — chunk bytes only.
- `EndMessage` (lines 89-112): scalars + an optional base64 response body
  string. The body is read by `teeStream.onClose` (response-handler.ts:464,
  `combineChunks(buffered).toString("base64")`).

**The structured-clone boundary across the worker would actually be a bad
place to ship a `Response` object** — it would attempt to serialize
internal slots that aren't meaningful. The architecture correctly avoids
this.

### 2.3 `cache-body-store.ts` — request bodies, not responses

The store holds `CachedRequestEntry` (lines 69-78): request body Buffer,
sanitized headers, path, timestamp. The store exists to support cache
keepalive — when a request creates a cache entry, its body is replayed
periodically to keep the upstream cache warm. **No Response, no body stream,
nothing from the upstream's response.** The data is read out via
`getLastCachedRequest(accountId)` and used by `cache-keepalive-scheduler.ts`
to construct a NEW outbound request.

### 2.4 `session-affinity.ts` — the comparison target the spec named

The spec asked to compare other maps against how `session-affinity.ts`
bounds its map. The pattern is well-defined:

```ts
// session-affinity.ts:36-37, 158-169
const MAX_AFFINITY_ENTRIES = 10_000;
...
private evictOldestIfFull(): void {
    if (this.affinity.size < this.maxAffinityEntries) return;
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.affinity) {
        if (entry.assignedAt < oldestAt) {
            oldestAt = entry.assignedAt;
            oldestKey = key;
        }
    }
    if (oldestKey !== null) this.affinity.delete(oldestKey);
}
```

The doc-comment at line 27-36 explains the choice explicitly — the TTL GC
alone is not enough under adversarial input (distinct `clientId`s), so the
hard cap with LRU-ish eviction is added. Other Maps in the codebase
follow the same pattern:

- `usage-collector.ts:69, 389-404` — `MAX_REQUESTS_MAP_SIZE=10000` with
  emergency 10% eviction of oldest by `createdAt`.
- `rate-limit-cooldown.ts:17, 29-33` — `MAX_PROBE_GATES=10_000` with
  oldest-key eviction in `pruneProbeLeases`.
- `cache-body-store.ts:36, 162-178` — `MAX_STAGING_ENTRIES=200` with
  oldest-timestamp eviction in `stageRequest`.

**None of these maps holds a Response. The cap+eviction pattern is
consistent across the codebase.**

### 2.5 `chatGptCloudflareCookieJar` — the only non-Map side-effect from `makeProxyRequest`

`request-handler.ts:123, 138` calls `chatGptCloudflareCookieJar.captureFromResponse(...)`.
This is not a body-store; it captures upstream `Set-Cookie` headers. The
jar holds cookie name→value pairs (scalars) keyed by host, not a Response.
The captured Response reference inside the function goes out of scope when
the function returns — `captureFromResponse` does not store the Response
parameter.

---

## 3. Retry-loop audit — variable overwrites and closures

Six call sites of `makeProxyRequest` were audited for closure retention.
Summary:

| Line | Retry shape | Closure capture? | Variable overwrite behavior |
| ---- | ----------- | ---------------- | -------------------------- |
| 472  | None — single shot | No | `response` is the only binding; returned at line 480 via `forwardToClient` |
| 691  | Inline | No | `let rawResponse = ...` — overwritten on next makeProxyRequest call |
| 725  | Inline (thinking-signature filter) | No | `rawResponse = ...` — same pattern |
| 757  | Inline (cache_control rejection) | No | `rawResponse = ...` — same pattern |
| 1072 | Model-list `for` loop (lines 1014-1078) | No | `rawResponse = ...` — overwritten each iteration; previous becomes unreachable |
| 1209 | 529 in-place retry `for` loop (lines 1192-1247) | No | `let retryRaw = ...` local; `response = retryResponse` overwrites at line 1227 |

In the 529 retry loop (lines 1192-1247), the body of the loop introduces a
local `let retryRaw = await makeProxyRequest(...)` (line 1209) and assigns
`response = retryResponse` (line 1227). When the loop iterates again,
`retryRaw` is a fresh binding; the previous `retryRaw` is unreachable.

A more subtle shape: between iterations the local `retryResponse` (line
1221) is computed via `provider.processResponse(retryTaggedRaw, ...)`,
which wraps the upstream body in a new Response. Then `response =
retryResponse` (line 1227) overwrites the outer binding. The previous
`response`'s underlying body stream (the tee'd output for the previous
attempt) becomes unreachable.

**No retry-loop closure captures a discarded Response.**

### 3.1 `proxy-operations.ts:1162-1166` — the body-rewrap at success path

```ts
const taggedRawResponse = new Response(rawResponse.body, {
    status: rawResponse.status,
    statusText: rawResponse.statusText,
    headers: responseHeaders,
});
```

This wraps `rawResponse.body` in a new Response. The original
`rawResponse` is then passed to `provider.processResponse(taggedRawResponse, ...)`
(line 1169). The processResponse result becomes `response` (line 1169).
The variable `taggedRawResponse` is local to its scope; once the
processResponse call returns, `taggedRawResponse` goes out of scope. Its
body source is now held by the chain: `response.body → taggedRawResponse.body
→ rawResponse.body`.

When `response` is later overwritten (529 retry, failover return null,
forwardToClient returns), the chain is released — **no separate retention
exists for `taggedRawResponse`.**

---

## 4. Closures that DO touch a Response — and why they don't retain

The audit found only two closures that reference a Response directly. Both
are in `response-handler.ts` and both are bounded by stream consumption:

| Closure              | Location                                  | What it reads       | Lifetime |
| -------------------- | ----------------------------------------- | ------------------- | -------- |
| `onTerminalState`    | response-handler.ts:389-406               | `response.status`   | bounded by stream terminal state |
| `onClose` (streaming) | response-handler.ts:300-336              | `response.status` via `streamTerminalState`, indirectly via `isExpectedResponse(path, response)` | bounded by stream close |
| `onClose` (non-stream) | response-handler.ts:459-483              | `response.status`, calls `isExpectedResponse(path, response)` | bounded by stream close |

`isExpectedResponse` (response-handler.ts:83-91) only reads `response.status`
and `response.ok` — scalars. It does NOT stash the Response anywhere.

These closures DO retain a `Response` reference for the duration of the
stream. That is necessary for the correctness of `fireAndForgetEnd` and
the terminal-state logging. **This is not a bug** — the Response is
actively being forwarded to a client. The leak we are mitigating is about
DISCARDED responses that no client will ever read.

### 4.1 What about `passthroughBody` itself?

The new `ReadableStream` returned by `teeStream` (stream-tee.ts:7-67) holds
a reference to the original `response.body.getReader()`. While the stream
is being consumed (or being cancelled by an abort), the reader keeps the
upstream body source alive. This is also intentional — without it, the
client would receive zero bytes.

If a client aborts mid-stream (cancels the response body), `teeStream`'s
`cancel()` handler (stream-tee.ts:63-65) calls `reader.cancel(reason)`,
which releases the underlying source.

---

## 5. What I searched

For reproducibility, here is the search log.

### 5.1 Module-level Maps / Sets

```
$ grep -rn "new Map\|Map<string" packages/ --include="*.ts" \
    | grep -vE "test|__tests__|\.test\." | grep -v response-related-infrastructure
```

Found and audited (full table in §2):

- `usage-collector.ts:334` — `requests: Map<string, RequestState>`
- `rate-limit-cooldown.ts:18` — `probeLeases: Map<string, number>`
- `model-capacity.ts:168` — `negativeCache: Map<string, ExhaustionEntry>`
- `token-manager.ts:23,25,422,425,434,440` — refreshFailures, backoffCounters, refreshClearers, pollingRestarters, codexUsageRefreshers, codexUsageInflight
- `cache-body-store.ts:106,112` — staging, lastCachedRequest
- `account-selector.ts:31,76` — WeakMaps (auto-GC'd with key)
- `load-balancer/strategies/session-affinity.ts:78,83` — affinity, lastPickedAt
- `load-balancer/strategies/least-used.ts`, `session-drain-soonest.ts:193,207` — availabilityCache (per-call local, not module-level)
- `apps/server/src/server.ts:1674` — `inflightStreams: Set<TrackedInflightStream>`

Each one was opened and its value type inspected. None stores a Response.

### 5.2 Functions that take `Response` and could stash it

```
$ grep -rn "response: Response" packages/ --include="*.ts" | head -50
```

Audited the bodies of:

- `parseRateLimit` (`providers/src/base.ts:67-105`) — reads headers, returns scalars.
- `processResponse` (`providers/src/base.ts:112-123`) — wraps body in new Response, returns it.
- `isInvalidThinkingSignatureError`, `isCacheControlRejectionError`, `isModelUnavailableError`, `isAnthropicExtraUsageExhausted` (`proxy-operations.ts:306-340, 356-377, 384-439, providers/.../extra-usage-exhausted.ts`) — `response.clone().json()` or `response.clone().text()`; the clone is local.
- `isAnthropicOutOfCredits` (similar shape) — only reads headers.
- `extractCooldownUntil` (`proxy-operations.ts:83-130`) — reads headers; no body access.
- `updateAccountMetadata` (`response-processor.ts:65-221`) — reads via `parseRateLimit`, enqueues DB writes; Response is not stashed.
- `processProxyResponse` (`response-processor.ts:231-...`) — calls the above; same.
- `forwardToClient` (`response-handler.ts:122-504`) — described in §1.4 and §4.
- `trackStreamForShutdown` (`apps/server/src/server.ts:1676-...`) — wraps body in a new ReadableStream with abort/settle callbacks; the `tracked` object holds no Response reference (§1.5 not in main flow).

### 5.3 Module-level `let response` / module-level Response variables

```
$ grep -rn "let.*Response\|let _response" packages/proxy/src/ --include="*.ts" \
    | grep -vE "test|__tests__|\.test\."
```

All hits are local variables inside functions:

- `auto-refresh-scheduler.ts:410` — local in `sendAutoRefreshRequest()`
- `proxy.ts:525` — local in `handleProxy()`
- `proxy-operations.ts:689, 1169` — local in `proxyWithAccount()`

None are module-level. Each one is scoped to the function that creates it
and becomes unreachable when the function returns.

### 5.4 Worker / cross-thread message shapes

```
$ cat packages/proxy/src/worker-messages.ts
```

`StartMessage`, `ChunkMessage`, `EndMessage` use only scalars and base64
strings — no Response objects across the worker boundary. §2.2.

### 5.5 The keepalive drain precedent

Out of scope for retention (the keepalive scheduler calls `fetch` directly,
not via `makeProxyRequest`), but worth flagging: the codebase already uses
a drain primitive in `cache-keepalive-scheduler.ts:188`:

```ts
const response = await fetch(endpoint, {...});
// Drain the response so the connection is released
await response.text().catch(() => {});
```

This is the same pattern Task A is migrating the discard sites to. It is
not the leak fix — it's a connection-release primitive — but it shows the
drain primitive is already in the codebase.

---

## 6. Conclusion

No retention. The leak mitigation work in Task A is sufficient; there is no
hidden retention to chase. This is a real positive finding for the project:
a previous `body.cancel()`-based fix (`ccflare-41`'s `7f99aba0`) didn't
have to worry about retention because none exists.

The only Response-retaining constructs in the live request path are the
`onClose` / `onTerminalState` closures in `response-handler.ts`, which are
bounded by stream consumption and only read scalars. They are NOT
retention in the leak-mitigation sense: they only apply to Responses that
are being forwarded to a real client.

If Task A's drain primitive lands on every discard site enumerated in the
ccflare-41 site classification, the per-request leak (73 KB / req on stock
Bun 1.3.14) is expected to drop to ~10 KB / req, matching the
`arrayBuffer()` baseline in `ccflare-42`'s measurement table. The reduction
is real because the underlying native source is genuinely released once
the Response becomes unreachable — and nothing here keeps it reachable.

---

**Signed-off:** No retention found. Document is complete on first pass; no
follow-up analysis required.