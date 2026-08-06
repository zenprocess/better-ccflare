# Issue #348 — Adversarial Regression Risks of a Default-On Body-Stream Idle Timeout

**Status:** READ-ONLY adversarial analysis. No code, no PR.
**Target:** upstream `tombii/better-ccflare#348`. Proposal: arm an idle timer on the proxied response body stream; if no bytes arrive for ~8–10 minutes, abort the request rather than letting it sit until `PROXY_REQUEST_TIMEOUT_MS` (30 minutes). Default ON, env override.
**Method:** every claim below cites `upstream/main:path:line`. Where the code does not answer the question, that is stated plainly.

This ships as a default-on behavior change for every operator of a public project. A wrong default silently truncates healthy work for people who never opted in.

---

## 0. The current architecture (so the proposal is on solid ground)

Three layers, all visible in upstream code today:

| Layer | Boundary | Source |
| --- | --- | --- |
| Header phase | 30-min `PROXY_REQUEST_TIMEOUT_MS` aborts fetch if upstream doesn't return headers in time. Cleared in `finally` after headers arrive. | `packages/core/src/constants.ts:32`, `packages/proxy/src/handlers/request-handler.ts:106-117` |
| Body phase | **No timeout at all today.** Only `req.signal` (client disconnect) aborts upstream. | `packages/proxy/src/handlers/request-handler.ts:115-117` (combines `callerSignal` with timeout signal) |
| In-memory state hygiene | `cleanupStaleRequests` evicts orphaned request state from the collector map after `CF_STREAM_TIMEOUT_MS` (default 60 s) of inactivity. **This does NOT abort the upstream or the response — it only drops the bookkeeping entry.** | `packages/proxy/src/usage-collector.ts:1079-1135`, especially the comment at `:1097-1098` |

The proposed body-idle timer is the **first** body-phase abort boundary ccflare would have. It will be reached for every long-running request, healthy or not.

There is also an Anthropic-specific post-terminal-delta recovery grace of 10 s (`ANTHROPIC_TERMINAL_RECOVERY_GRACE_MS = 10_000`, `packages/proxy/src/anthropic-terminal-recovery.ts:4`), and the upstream-derived usage extractor already enforces 60 s overall / 30 s per-read timeouts (`STREAM_READ_TIMEOUT_MS` / `STREAM_OPERATION_TIMEOUT_MS` in `packages/providers/src/providers/base-anthropic-compatible.ts:348-380`). Neither of those aborts the user-visible stream.

---

## 1. FALSE FIRE — healthy requests the timer would falsely abort

A "healthy" stream in this context is one that has *not* failed but produces zero bytes for longer than the timer. Every path below is a real code path in upstream, not a hypothetical.

### 1.1 Anthropic extended thinking on the wire (severity: HIGH)

Anthropic Messages supports `thinking: { type: "enabled", budget_tokens: N }` with `budget_tokens` of 1024–64000+ tokens (`type: "enabled"` is part of the public Anthropic Messages API). The API emits `content_block_start` for the thinking block, then a long silent phase while it computes, then later opens a text/tool-use block and produces tokens.

In upstream:

- `packages/providers/src/providers/anthropic/provider.ts` does **not** strip thinking blocks (search returns no `thinking` handling). They flow through ccflare unchanged.
- The Anthropic SSE stream is wrapped by `createAnthropicTerminalRecoveryStream` in `packages/proxy/src/response-handler.ts:373-412`. That wrapper starts an internal recovery timer only AFTER a terminal `message_delta` is seen (`packages/proxy/src/anthropic-terminal-recovery.ts:458-471`). It does nothing during the pre-delta reasoning phase.
- The proxy's only body-phase abort today is `req.signal` — absent a client cancel, a thinking phase of any length is silently passed through.

A user who turns on thinking with `budget_tokens: 32000` on a hard reasoning task routinely waits several minutes between `content_block_start` (thinking) and the first text delta. **A 10-min idle abort will fire on a healthy extended-thinking run that is just slow.** Operators who enable thinking as a default for their team will hit this on the first hard task.

### 1.2 DashScope reasoning models (severity: HIGH)

`packages/providers/src/providers/openai/provider.ts:201, 452-498` injects `enable_thinking: true` for DashScope endpoints whenever the model name contains `qwen`, `qwq`, or `deepseek-r1`, or when the incoming Anthropic request has `thinking.type === "enabled"`. DashScope OpenAI-compat then emits `reasoning_content` deltas before content deltas.

This is a real, instrumented upstream path. Search for `injectDashScopeReasoning` and the `enable_thinking` setter. The reasoning phase for `deepseek-r1` and `qwq` is publicly documented to run for tens of seconds to several minutes depending on prompt size. The ccflare proxy does not interleave any keepalive bytes during this phase (see §2.6 below — there is no proxy-side SSE keepalive injection).

### 1.3 Bedrock Claude with extended thinking (severity: MEDIUM)

`packages/providers/src/providers/bedrock/provider.ts:104-259` (`createAnthropicCompatibleStream`) iterates `bedrockStream: AsyncIterable<ConverseStreamOutput>` from the AWS SDK and emits Anthropic-shaped SSE events. Bedrock Claude supports the same `thinking` content blocks as native Anthropic, and the provider does not deduplicate or compress them. Long thinking phases here produce the same silent gap as 1.1.

### 1.4 Slow upstream TTFB on accepted (non-error) responses (severity: MEDIUM)

For non-streaming responses the proxy buffers the upstream body via `teeStream` with a 256 KB cap (`packages/proxy/src/response-handler.ts:459-497`). For streaming responses the proxy immediately forwards each chunk. Either way, if the upstream takes longer than the proposed timer to send its first byte after headers — e.g. a Bedrock cold-start, a regional Anthropic endpoint with latency spikes, or an overloaded-but-still-200 upstream — the timer fires.

Anthropic p50 first-byte latency is typically < 1 s but p99 tail on overloaded days has been observed in the proxy's existing logs (`CCFLARE_CIRCUIT_BREAKER` is an explicit acknowledgment of overload incidents in `packages/proxy/src/circuit-breaker.ts:3-9` — "this morning a single provider overload became a fleet-wide retry storm"). The overload days are precisely the days a healthy request's TTFB blows out. The default-on timer would make those days worse by killing the request before any content arrives.

### 1.5 Large non-streaming responses buffered upstream (severity: LOW–MEDIUM)

Some Anthropic-compatible endpoints (Bedrock cross-region in particular) buffer the response server-side before sending. A 200 OK with no bytes for 8 min followed by a 5 MB body is a known failure mode of certain AWS configurations. The proposed timer would abort a healthy large response whose upstream is buffering. Confirmed: `BedrockConverseResponse` and `transformNonStreamingResponse` in `packages/providers/src/providers/bedrock/response-parser.ts` accept large multi-tool responses.

### 1.6 Cache body revalidate (severity: LOW)

`packages/proxy/src/cache-keepalive-scheduler.ts:71-78` (interval calculation: `Math.max(60_000, (currentTtlMinutes - 1) * 60_000)`) re-fetches cached model listings up to one minute before TTL. With a long TTL, these synthetic probes can land on a slow upstream, but they have their own header `x-better-ccflare-keepalive` (`packages/proxy/src/response-handler.ts:14-18` and `cache-keepalive-scheduler.ts` callers) and are filtered out of analytics. The proposal would not break this path *if* the keepalive header is honored by the new timer code, but the proposal as described does not say so.

### 1.7 Provider health-probe / auto-refresh paths (severity: LOW)

`packages/proxy/src/auto-refresh-scheduler.ts` and the proxy's internal probe patterns (`x-better-ccflare-auto-refresh`, `INTERNAL_PROBE_SECRET_HEADER` in `packages/proxy/src/handlers/proxy-types.ts`) fire synthetic requests that intentionally validate that an account is reachable. A reachable-but-slow account is the signal we want; aborting it after 10 min converts a "still good" into a "needs reauth" because the auto-refresh scheduler increments a failure counter on non-2xx and on abort.

### Net for §1

There is **no way** to make 8–10 minutes safe by default for ccflare. Extended-thinking on Anthropic, Qwen/QwQ/DeepSeek-R1 via DashScope, and Bedrock thinking all regularly go quiet for that long on legitimate workloads. A default-on timer will cut off real work the first time a user enables thinking or runs a long reasoning task.

---

## 2. REGRESSION — what existing behavior breaks

The danger here is not just "abort a slow request." It is that the abort interacts with state machines and bookkeeping that were designed assuming "the upstream is allowed to be quiet."

### 2.1 State misclassification: abort becomes "success" (severity: HIGH)

The most subtle bug. `packages/proxy/src/response-handler.ts:304-341` decides success vs. failure from `streamTerminalState`:

```text
const success = streamTerminalState
    ? streamTerminalState === "complete" ||
      streamTerminalState === "recovered" ||
      streamTerminalState === "client_cancelled"
    : isExpectedResponse(path, response);
```

`streamTerminalState` is set by the Anthropic recovery wrapper via `onTerminalState` (`response-handler.ts:393-411`, `anthropic-terminal-recovery.ts:197-206, 591-602`). The wrapper fires the terminal state in three cases:

1. `done:true` from upstream (`pull()`, `anthropic-terminal-recovery.ts:542-568`).
2. Reader rejection / stream error (`pull()` catch, `:572-588`).
3. Downstream cancel via `cancel()` (`:591-602`).

If the new idle timer is implemented by calling `controller.cancel()` on the *outer* stream returned by the wrapper (the one the proxy returns to the client), `cancel()` fires (case 3) and `clientCancelled = true` → `streamTerminalState = "client_cancelled"` → success. **Correct.**

If the implementation aborts by calling the upstream `reader.cancel()` directly, or by destroying the network socket, the wrapper's `pull()` sees `done:true` (case 1). The wrapper then enters the EOF branch and computes the terminal state from observed SSE events. If no `message_stop` was observed, the state is `"truncated"` → recorded as failure. **Also defensible.**

But if the implementation aborts by raising an exception into the wrapper's `pull()` (e.g. wrapping the stream in an `AbortSignal`-raced reader that throws on abort), the catch branch fires (case 2), which calls `markTerminalFailure()` → state becomes `"error"`. **Wrong** — this is a proxy-initiated abort, not an upstream error, and the code's own comment at `:576-584` says reader rejections must NOT be conflated with mid-content TCP closes.

The default-on proposal must explicitly choose one of these paths and the choice has to be visible to the response-handler. The risk is that someone implements the abort by throwing into the reader and silently poisons the success-rate metrics at the same time the timer is firing on real failures.

### 2.2 Race with the 10-s recovery grace (severity: MEDIUM)

If the timer fires during the 10-s `ANTHROPIC_TERMINAL_RECOVERY_GRACE_MS` window after a terminal `message_delta` but before `message_stop` is observed, the recovery flow is mid-execution. The wrapper has `finalized = false`, `recoveryTimer` armed. An abort of the outer stream calls `cancel()` (line 591-602): `finalized = true`, `clientCancelled = true`, recovery timer cleared, `cancelUpstream(reason)`. State becomes `"client_cancelled"` → success. OK.

But if the abort is implemented by calling the *upstream* `reader.cancel()` (not the wrapper), the wrapper's `pull()` resolves with `done:true` and the EOF branch fires. In that branch (`:542-568`), the wrapper checks `if (terminalDeltaSeen && !messageStopSeen && ...)` and calls `recover("eof", ...)` — which appends a synthesized `message_stop` to the client and reports the state as `"recovered"`. That is a *successful* recovery, which is the opposite of what the proxy wanted: the timer fired because it decided the upstream was stuck, but the recovery logic decided the stream was fine. The result: the user sees a successful response with a synthesized terminator, while the proxy's metrics record it as a timer-aborted request. The bookkeeping diverges from the client experience.

### 2.3 Usage accounting: silent zero-write on mid-stream abort (severity: HIGH)

The usage collector's authoritative token counts come from `message_delta`. See `packages/proxy/src/usage-collector.ts:224-244`:

```text
const isMessageDelta = parsed.type === "message_delta" || eventType === "message_delta";
if (isMessageDelta) {
    state.lastTokenTimestamp = Date.now();
    if (parsed.usage) {
        if (parsed.usage.output_tokens !== undefined) {
            state.providerFinalOutputTokens = parsed.usage.output_tokens;
            state.usage.outputTokens = parsed.usage.output_tokens;
        }
        ...
    }
}
```

The final write happens in `saveRequest` at `:811-840` and only persists when `state.usage.model` is set (which is set on `message_start`, `:214-216`). For an Anthropic request that aborts after `message_start` but before `message_delta`, the DB record will be written with `outputTokens: 0`, `totalTokens: 0`, and `costUsd: undefined`. The request looks successful-but-cheap on the dashboard.

This is the worst kind of regression: it is invisible until someone audits the dashboard and notices that some "successful" requests cost nothing. If the timer starts firing on §1's false-fire cases, the affected accounts will accumulate under-counted token usage at scale. Cost reconciliation against upstream invoices will fail silently.

For non-Anthropic providers (OpenAI-compat / Zai / Ollama / Codex), usage is parsed in `extractStreamingUsage` at `packages/providers/src/providers/base-anthropic-compatible.ts:323-462` with the 60-s `STREAM_READ_TIMEOUT_MS`. The same shape: abort mid-stream → no `message_delta` → no final usage recorded.

### 2.4 Failure to fire on a client-disconnected-but-upstream-still-streaming case (severity: see §3, but worth flagging here)

The proxy DOES abort upstream when the client disconnects: `request-handler.ts:115-117` combines `req.signal` with the header-phase timeout signal. So if the client goes away, the upstream fetch is aborted regardless of body idle. This part of the proposal is not strictly necessary for the *client-disconnected* case.

What the proposal does catch that nothing else does: **headers received, zero bytes follow forever**. That is the real benefit. The next section lists the cases even this benefit does not cover.

### 2.5 Comment at `usage-collector.ts:1097-1098` is a direct contradiction (severity: documentation-honesty)

```text
// 2. Remove inactive requests (orphaned). A stream may legitimately run
// for much longer than the inactivity timeout, so lifecycle age alone must
// never evict it while chunks (including provider pings) are still arriving.
```

The upstream authors have documented, in code, the position that "streams may legitimately run much longer than any inactivity timeout, and provider pings reset it." A default-on 8–10-min body-idle abort overrides that position. If this proposal ships, this comment is wrong; either delete it or change it. If the author is willing to change the comment, the upstream team's position has changed and that change should be discussed in the PR, not implicit.

### 2.6 No proxy-side SSE keepalive (severity: MEDIUM, important for the design)

Search confirms: there is no SSE keepalive injection in `stream-tee.ts` or `response-handler.ts`. `grep -nE "keepalive|keep-alive|ping|heartbeat" packages/proxy/src/stream-tee.ts packages/proxy/src/response-handler.ts` returns one false-positive at `response-handler.ts:170` about a header-based filter, no implementation. `cache-keepalive-scheduler.ts` is for the cached model-listing body, not for the live response.

This means: during a healthy reasoning phase (§1.1, §1.2, §1.3), the upstream emits thinking events as `content_block_delta` deltas — those are bytes, they reset the timer. But between events (the actual silent thinking time), no bytes flow. The proposed timer would fire as soon as 8–10 min of zero-byte thinking is observed, even though bytes arrived just before and just after. **The 8–10 min window is from "last byte" to "next byte"**, which is much smaller than "last activity" in the user's mind.

Mitigation the proposal could include but did not mention: a proxy-injected comment line (`:\n\n`) every ~30 s during the body phase. SSE clients ignore `:`-prefixed lines as keepalives. This is what nginx and other proxies do. Without it, the 8–10 min number is too low for any thinking-enabled workload.

### 2.7 WebSocket proxying — confirmed not present (severity: N/A)

Searched `git grep -E "websocket|webSocket|Upgrade|101 Switching" upstream/main -- packages/`. Zero hits in the proxy layer. ccflare does not proxy WebSockets today. No false-fire risk from long-lived WS connections — but also, if WS support is ever added, this timer will silently break it (a healthy WS connection that goes quiet between messages is normal). Worth a comment in the code: "WS not supported; if you add it, gate the timer on `response.headers.get('upgrade')`."

### 2.8 Circuit breaker is not yet wired (severity: N/A today, HIGH when wired)

`packages/proxy/src/circuit-breaker.ts:8-13` explicitly says the breaker state machine is not yet integrated into the proxy path:

> "This module is the **state machine only**. It is NOT wired into the proxy path on purpose — a follow-up task will integrate it with proxy.ts and response-handler.ts."

So today, an idle-aborted healthy request does not double-count as a circuit failure. But the breaker is being wired in a follow-up. If the wiring lands before or alongside this proposal, the abort needs an exclusion on `kind` (similar to the existing `model_fallback_429` and `api_error` exclusions at `:188-208`) so a healthy-but-slow upstream does not trip the breaker after 5 consecutive idle aborts.

### 2.9 Retryable-429 does NOT auto-retry (severity: N/A — non-finding)

`packages/proxy/src/handlers/retryable-429.ts:8-16` is explicit: the module does not retry. "a `true` result means 'fail over with NO account cooldown'." So the proposed timer does not cause a retry-double-count regression. Honest non-finding — leaving it here so reviewers don't have to check.

### 2.10 Non-streaming large bodies get killed at 8–10 min regardless of size

For the non-streaming path (`response-handler.ts:459-497`), the proxy buffers up to 256 KB via `teeStream`. A slow upstream that is producing bytes slowly but steadily (e.g. a 10 MB JSON body over a 1 Mbps link takes 80 s; a 10 MB body over 100 kbps takes 13 min) would be aborted mid-way through the read, after which `onError` fires (`:488-496`), the response is sent half-complete, and the client sees a truncated body with no error envelope.

### Net for §2

At least five distinct regressions, of which **§2.1 (state misclassification)**, **§2.3 (silent usage under-count)**, and **§2.6 (no keepalive)** are the load-bearing ones. §2.1 in particular requires the implementer to pick one of three paths and the wrong pick produces silently wrong metrics at scale.

---

## 3. FAILURE TO FIRE — what the timer still misses

The classic abandoned-request case is "client disconnected but upstream keeps streaming." Today this is *partially* caught by `req.signal` in `request-handler.ts:115-117`. The proposed body-idle timer does **not** help here: the upstream is still pouring bytes, so the timer never resets, the upstream keeps streaming until the upstream itself closes or fails. The proxy burns upstream-side cost until then.

Other abandoned cases:

1. **Upstream returns 200 but never sends the first body byte, then hangs indefinitely.** The proposed timer DOES catch this after 8–10 min. This is the main case the proposal adds value for.
2. **Upstream sends partial SSE event (no terminator newline) and then goes quiet.** The SSE parser in `anthropic-terminal-recovery.ts:473-519` accumulates into `eventBuffer`. If the upstream goes quiet mid-event, the parser waits. The body-idle timer DOES catch this.
3. **Upstream sends "poisoned" streams that drip bytes often enough to keep the timer alive forever** (e.g. one byte per 5 min). The timer never fires. This is the class the timer does NOT catch.
4. **Upstream returns a 200 with a `Transfer-Encoding: chunked` body that declares a never-ending chunked stream and emits a `0\r\n\r\n` terminator only after the client gives up.** Today's Bun fetch may handle this differently than the timer expects. Worth a Bun-specific test before shipping.
5. **Upstream legitimately streams forever** (a long tool call that streams progress events). The timer does NOT catch this; the upstream is producing bytes the whole time. But this is a *good* case the timer doesn't break — the only risk is the timer being too short to handle long event gaps within the stream.

The timer covers case 1 and case 2 — the obvious "hung upstream" failure modes. It does not address case 3 (slow-drip), case 4 (chunked encoding edge), or the structural "client disconnected but upstream still streaming" case (already handled by `req.signal`, not by the timer).

If the proposal is sold as "fixes abandoned upstream requests," it should be scoped to that and not over-claimed.

---

## 4. Is 8–10 minutes the right number?

**I cannot determine a defensible number from upstream code alone.** Honest non-finding.

What the code does show:

| Constant | Value | Meaning | Source |
| --- | --- | --- | --- |
| `PROXY_REQUEST_TIMEOUT_MS` | 30 min | Header-phase timeout. Comment: "covers long agent calls." | `packages/core/src/constants.ts:32` |
| `STREAM_READ_TIMEOUT_MS` | 60 s | Overall timeout in usage extraction (a clone). | `packages/core/src/constants.ts:27`, used at `packages/providers/src/providers/base-anthropic-compatible.ts:348` |
| `STREAM_OPERATION_TIMEOUT_MS` | 30 s | Per-read timeout in usage extraction. | `:28`, used at `:380` |
| `ANTHROPIC_TERMINAL_RECOVERY_GRACE_MS` | 10 s | Post-terminal-delta recovery grace. | `packages/proxy/src/anthropic-terminal-recovery.ts:4` |
| `STREAM_TIMEOUT_DEFAULT` (env `CF_STREAM_TIMEOUT_MS`) | 60 s | In-memory state cleanup. Explicitly NOT an abort — comment at `usage-collector.ts:1097-1098`. | `packages/core/src/constants.ts:26`, used at `packages/proxy/src/usage-collector.ts:365` |
| Bun server `idleTimeout` | 255 s (max) | TCP connection idle, not request-body idle. | `apps/server/src/server.ts:1271`, `NETWORK.IDLE_TIMEOUT_MAX` at `packages/core/src/constants.ts:254` |

There is no upstream constant that measures real inter-byte gaps on Anthropic / DashScope / Bedrock streaming responses. There is no upstream code that records "this is the longest we ever saw a stream go quiet without it being a failure." I would have to invent a number to recommend 8–10 min, and the proposal as written does not justify it from the code either.

What the Claude Code task description cites as "300 s idle watchdog floor" is a Claude Code (the client) behavior, not a ccflare behavior. The ccflare proxy cannot observe it directly — it sees whatever bytes Claude Code requests and whatever bytes the upstream returns. The 300 s figure tells you Claude Code *itself* will give up first if ccflare doesn't, which means ccflare's 8–10 min timer is *always* shorter than the client's own watchdog and therefore ALWAYS the abort boundary that fires first when the upstream stalls.

If the goal is "let Claude Code give up first," the timer should be **longer** than Claude Code's 300 s — not shorter. The proposal as written does the opposite.

---

## 5. Recommendation summary

If this proposal ships as-is:

- **Default-on** will break every ccflare operator who has enabled Anthropic extended thinking, DashScope `enable_thinking`, or Bedrock extended thinking on a hard reasoning task. First hit is on the first hard task their team runs.
- The state machine in `response-handler.ts:304-341` will record mid-stream timer-aborts as either `client_cancelled` (success, misleading), `truncated` (failure, correct), or `error` (failure, wrong attribution) depending on which of three implementation paths the author picks. Two of three are wrong.
- Usage accounting will silently under-count tokens for every aborted request — see §2.3.
- The timer does not actually fix the most common abandoned-stream case (client disconnect while upstream keeps streaming) — that is already handled by `req.signal`.

If the proposal must ship:

1. **Default OFF, not default ON.** Operators who want the safety should opt in. The blast radius is asymmetric: false-fire hurts every operator on their first long reasoning task; opt-out friction is one env var.
2. **If default-on is non-negotiable, raise the floor to ≥ 30 min** (matching `PROXY_REQUEST_TIMEOUT_MS`) so it is unreachable for healthy workloads and only fires on truly hung upstreams that would have hit the 30-min ceiling anyway. Then the only behavior change vs. today is "hung upstreams fail at 30 min instead of at Bun's transport timeout."
3. **Inject SSE comment-line keepalives (`:\n\n`) every 30 s** during the body phase so the timer measures "no real activity" rather than "no bytes." Without this, the 8–10 min number is too low.
4. **Pick one abort path explicitly** (`controller.cancel()` on the outer wrapper stream) and test that `streamTerminalState` resolves to `"client_cancelled"` for every aborted request.
5. **Add a circuit-breaker exclusion** for `idle_timeout` kind before the breaker is wired, so healthy-slow accounts don't get benched after 5 timer hits.
6. **Emit partial-usage writes** on timer-abort using whatever tokens have been observed up to the abort point. Otherwise dashboard cost reconciliation against upstream invoices will silently diverge.

Items 1–3 are the minimum. Items 4–6 are necessary if 1–3 are rejected.

The honest answer is: at default-on and 8–10 min, this proposal is wrong. The upstream code is unambiguous about it. A default-OFF version with a higher floor, SSE keepalive injection, and explicit abort-path semantics is shippable; what was proposed here is not.
