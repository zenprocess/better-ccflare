---
title: Body-stream idle timer — implementation brief for tombii/better-ccflare#348
issue: tombii/better-ccflare#348
branch: ao/348-design-brief
base_ref: upstream/main @ 6f2c9d28
status: design-only (READ-ONLY investigation; no implementation shipped here)
audience: implementer who will write the PR against upstream/main
generated: 2026-08-06
generator: AO worker session (5-agent parallel investigation)
---

# Implementation Brief — Body-stream idle timer (#348)

## TL;DR

Add a body-stream idle timer that fires when no chunk arrives on the upstream
response body for a configurable threshold (recommended default 9 minutes, ~540
000 ms). On fire, error the downstream `ReadableStream`, record `success: false`
on the `requests` row with a specific error message and `streamTerminalState`
value, abort the upstream fetch via the existing `AbortSignal.any` plumbing, and
let the client see the half-stream terminate. Default-on. Env-tunable via
`CCFLARE_BODY_STREAM_IDLE_TIMEOUT_MS`. The maintainer (`tombii`, 2026-08-05
in the issue thread) walked back an earlier "env-gated, off-by-default" position
to land here; treat the default-on stance as the ask.

The bug being fixed: `PROXY_REQUEST_TIMEOUT_MS` (30 minutes) covers only the
header round-trip — its `AbortController` is cleared in `finally` at header
time. After the headers are in, the body stream has no timer at all. A request
that streams nothing for minutes is recorded as a healthy 200, so it is invisible
to operators and never fails over. `lunetics` produced a real production
reproduction of a 304-second stalled opus-5 turn that fell through with
`status=200, errorMessage=null, failoverAttempts=0, outputTokens=3`. That is the
exact shape this fix turns into a failed request.

---

## 1. Issue and maintainer's position (source: github issue thread)

The full thread was read on 2026-08-06 via
`gh api repos/tombii/better-ccflare/issues/348/comments`. Key timeline:

- 2026-07-28 — `@zenprocess` opens the bug with evidence (p50 3.6s, p90 12.7s,
  p99 153s, max 246s; pool 3/3 routable, 0 errors, 0 failover attempts; clients
  stalling at ~1070s).
- 2026-07-30 — `@lunetics` posts an independent reproduction: 7 client
  `API Error: Response stalled mid-stream` events at exactly **300 s**
  (Claude Code's idle watchdog floor), each correlated to a ccflare row with
  `status=200`. Each row is structurally indistinguishable from a healthy
  success.
- 2026-07-30 — `@zenprocess` corrects the 1070s figure to be their own
  orchestrator watchdog, not ccflare. Confirms the silent-failure gap is real
  and ccflare's.
- 2026-07-30 — `@lunetics` sharpens: rows do NOT carry a full response body
  (outputTokens=4-7 = `message_start` only; no `message_delta` ever arrived).
  The 200 is header-only.
- 2026-07-31 — `@tombii` lands PR #360 (commits `fd389fd2`, `cec5b5b9`,
  `23cf0cea`): abort upstream on client disconnect; stop walking every account
  on a closed socket; add `stream_terminal_state` column to `/api/requests`.
  Asks for production verification.
- 2026-08-03 — `@lunetics` supplies the production data on v3.5.46: 3
  `client_cancelled` rows in a 1000-row sample, all `status=200, success=true`.
  Two `opus-5` requests ran 304 529 ms and 303 609 ms — `outputTokens=3` only.
  These are the live instances of the bug.
- 2026-08-03 — `@zenprocess` offers to build the body-stream idle timer, asks
  tombii for the default.
- 2026-08-05 — `@tombii` first answers "env-gated, off by default", then
  immediately revises to "default-on, threshold ~8-10 min, env override".
  The revision is explicit and final: *"build it default-on, with a sensible
  threshold (~8-10 min, tune as the data suggests) and an env var to override
  for anyone with atypical long-silence workloads"*.

The brief is scoped to satisfy the final position.

---

## 2. Current state on upstream/main (commit 6f2c9d28)

Verified by direct `git show upstream/main:<path>` reads. The relevant code
repos (130-commit gap from this worktree) was NOT inspected — only upstream.

### 2.1 What `PROXY_REQUEST_TIMEOUT_MS` actually protects

`packages/core/src/constants.ts:32`:

```ts
PROXY_REQUEST_TIMEOUT_MS: 30 * 60 * 1000, // 30 minutes — covers long agent calls
```

It has **no env override** — only one consumer and one definition. Confirmed
exhaustively. The 30-minute figure is wired in via a hard `setTimeout` in
`makeProxyRequest`:

`packages/proxy/src/handlers/request-handler.ts:102-117`:

```ts
// The header-phase timeout is always armed, independent of the caller
// signal, and disarmed in `finally` once the headers are in.
const timeoutController = new AbortController();
const timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(
    () => timeoutController.abort(),
    TIME_CONSTANTS.PROXY_REQUEST_TIMEOUT_MS,
);

// Both reasons must be able to abort the same fetch. Combining them keeps
// the caller signal live for the whole stream lifetime, whereas replacing
// one with the other silently drops a client disconnect (upstream leak) or
// the header timeout.
const effectiveSignal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutController.signal])
    : timeoutController.signal;
```

And the cleanup at `request-handler.ts:150-156`:

```ts
} finally {
    if (timeoutId) clearTimeout(timeoutId);
}
```

`finally` runs as soon as `await fetch(...)` resolves — which is **header time,
not body-stream end**. Both `fetch()` call sites (`request-handler.ts:120-128`
Request-target, `:136-148` string-target) return the `Response` from inside the
try block. The timer is dead before the body is read.

**The 30-minute timeout covers ONLY the header round-trip.** After headers are
in, the only thing that can abort the upstream is `req.signal` (client
disconnect, wired in by PR #360 / commit `fd389fd2` via `AbortSignal.any`). The
body stream itself has no time-based backstop.

### 2.2 The body-stream path (where the new timer plugs in)

`packages/proxy/src/response-handler.ts:358-426` (streaming branch of
`forwardToClient`):

```ts
// Anthropic-Messages-shaped SSE response detection — covers native
// anthropic AND anthropic-compatible providers (e.g. minimax) which
// speak the same wire format on `/v1/messages`. Gated on path +
// content-type + 2xx status only; provider name and `anthropic-version`
// request header are deliberately excluded because the wire format is
// identical and a 200 with truncated content must not be silently
// recorded as success regardless of which upstream served it.
const isAnthropicMessagesSseResponse =
    method === "POST" &&
    path === "/v1/messages" &&
    response.ok &&
    (response.headers
        .get("content-type")
        ?.toLowerCase()
        .includes("text/event-stream") ??
        false);
let streamTerminalState: AnthropicTerminalState | null = null;
const responseBody = isAnthropicMessagesSseResponse
    ? createAnthropicTerminalRecoveryStream(response.body, {
            /* callbacks */
        })
    : response.body;

const passthroughBody = teeStream(responseBody, {
    onChunk,
    onClose,
    onError,
});

return new Response(passthroughBody, {
    status: response.status,
    statusText: response.statusText,
    headers: withModelRewriteHeader(/* ... */),
});
```

Two layers matter for the new timer:

- `createAnthropicTerminalRecoveryStream` (`packages/proxy/src/anthropic-terminal-recovery.ts:84`)
  TOUCHES bytes (parses SSE, may synthesize `message_stop`). Owns its own
  10 000 ms post-`message_delta` grace timer (`ANTHROPIC_TERMINAL_RECOVERY_GRACE_MS`,
  `anthropic-terminal-recovery.ts:14`).
- `teeStream` (`packages/proxy/src/stream-tee.ts:7-66`) is the universal
  chokepoint — every forwarded body flows through it. Reads the upstream via
  `upstream.getReader()` (line 23), forwards every chunk unchanged
  (`controller.enqueue(value)` line 36), buffers up to 1 048 576 bytes for
  analytics (`BUFFER_SIZES.STREAM_TEE_MAX_BYTES`, `stream-tee.ts:22`). Has
  no timer of its own.

The PR-#360 plumbing (`request-handler.ts:574-582`, `forwardUpstream`) passes
`req.signal` explicitly because provider transforms rebuild `Request` from URL
and would otherwise drop the signal. The new idle timer inherits the same
requirement — see §5.3 for the non-Anthropic providers caveat.

### 2.3 How the row is recorded on close

`packages/proxy/src/response-handler.ts:304-341` (`onClose` callback inside
`forwardToClient`):

```ts
const success = streamTerminalState
    ? streamTerminalState === "complete" ||
      streamTerminalState === "recovered" ||
      streamTerminalState === "client_cancelled"
    : isExpectedResponse(path, response);
const error =
    streamTerminalState === "truncated"
        ? "stream_truncated_mid_content"
        : streamTerminalState === "error"
            ? "stream_in_band_error"
            : undefined;
const endMsg: EndMessage = {
    type: "end",
    requestId,
    success,
    error,
    streamTerminalState: streamTerminalState ?? null,
};
fireAndForgetEnd(endMsg);
```

Per-state outcome (verified):

| `streamTerminalState`         | success | error column                  |
|-------------------------------|---------|-------------------------------|
| `complete`                    | true    | null                          |
| `recovered`                   | true    | null                          |
| `client_cancelled`            | true    | null (preserves prior header) |
| `truncated`                   | false   | `"stream_truncated_mid_content"` |
| `error`                       | false   | `"stream_in_band_error"`      |
| unset (non-Anthropic-Messages)| `isExpectedResponse(path, response)` (`response.ok` minus `.well-known/*` 404) | null |

The single writer of the persisted row is `_handleEndInternal`
(`packages/proxy/src/usage-collector.ts:622`), reaching the `requests` table via
`saveRequest` (`usage-collector.ts:822`). `success: true/false` literals exist
only on `EndMessage` payloads in non-test proxy code — every flow funnels
through `_handleEndInternal`.

### 2.4 What premature-SSE-termination detection already covers

`1565a5d4` ("fix: detect and record premature SSE termination for all
Anthropic-Messages-shaped streams", Val, 2026-07-27) IS on upstream/main —
verified by `git merge-base --is-ancestor 1565a5d4 upstream/main` returning YES
and `git rev-list upstream/main | grep -n 1565a5d4` returning 164/200. (One of
the parallel investigation agents flagged uncertainty about position-count;
this is a verified fact — the commit is reachable from upstream/main.)

It does NOT cover the idle-stall case. 1565a5d4 detects a stream that closes
mid-content without ever emitting a terminal SSE event. The idle-stall case is
different: **no upstream `done` at all**, the stream is open but silent. The
two are separate signals. Both should be recorded distinctly — see §3.3.

### 2.5 Telemetry surface

Single `EventEmitter` at `packages/core/src/request-events.ts:25`,
`requestEvents`, channel name `"event"`. Two payload types:

- `RequestStartEvt` — fired at `response-handler.ts:236-247`, no terminal state.
- `RequestSummaryEvt` — `{type:"summary", payload: RequestResponse}` where
  `payload.streamTerminalState` is the persisted value (`usage-collector.ts:930`).

Consumers: `packages/http-api/src/handlers/requests-stream.ts:35` (SSE fan-out
to dashboard), `packages/http-api/src/services/alerts.ts:246-253`
(`.on("event", ...)` alert detector). The idle-fire case is observable today
through `streamTerminalState` on the summary payload — there is no dedicated
"idle-fire" event type.

### 2.6 Failover is structurally impossible once `forwardToClient` returns

`proxy-operations.ts:1311-1317` (401 gate), `:1320-1383` (529 in-place retry),
`:1403-1410` (post-retry 401), `:1474-1476` (rate-limit) all return `null` to
the next-account loop **before** `forwardToClient` is invoked. After
`forwardToClient` returns the `Response` (`response-handler.ts:419-426`),
failover cannot fire. Mid-stream failures (`createSseRateLimitSniffer` at
`response-handler.ts:257-301`) only trigger `applyRateLimitCooldown` on the
account; the in-flight response continues.

This matters because turning a silent stall into a failed-and-inactionable
record is strictly worse than turning it into a failed-and-failover-eligible
record. The new idle-fire outcome cannot trigger failover either (it fires
mid-stream), but it CAN participate in account cooldown if the implementer
chooses. Recommendation in §3.4.

### 2.7 The env-tunable pattern to follow

`packages/core/src/constants.ts:62-73` (helper):

```ts
function readDurationOverrideMs(
    raw: string | undefined,
    fallback: number,
): number {
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
```

`packages/core/src/constants.ts:160-169` (named reader pattern, mirrors
`computeOverloadCooldownMs`):

```ts
export function computeOverloadCooldownMs(): number {
    return readDurationOverrideMs(
        process.env.CCFLARE_OVERLOAD_COOLDOWN_MS,
        TIME_CONSTANTS.OVERLOAD_COOLDOWN_MS,
    );
}
```

`packages/core/src/constants.test.ts:11-15` (test env-keys matrix):

```ts
const ENV_KEYS = [
    "CCFLARE_OVERLOAD_COOLDOWN_MS",
    "CCFLARE_OVERLOAD_WITH_RESET_MAX_MS",
    "CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS",
    "CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS",
    "CCFLARE_RATE_LIMIT_RESET_STABILITY_MS",
] as const;
```

`docs/configuration.md:113-152` (Additional Environment Variables table, gold-
standard row shape is the `CCFLARE_OVERLOAD_*` block at 132-140; closest
domain-cluster neighbour is `CF_STREAM_TIMEOUT_MS` at 151).

Existing env-var prefixes on the file system:
- `CCFLARE_*` — rate-limit / cooldown family (modern, recommended). Five knobs
  in production.
- `CF_*` — legacy stream/pricing/model-catalog. `CF_STREAM_TIMEOUT_MS`,
  `CF_PRICING_TIMEOUT_MS`, etc.
- `BETTER_CCFLARE_*` — top-level only.
- `PROXY_*` — used in error-code meta only; not established for ms tunables.

The new env var should be `CCFLARE_BODY_STREAM_IDLE_TIMEOUT_MS` — matches the
modern rate-limit precedent and groups with semantically-related cooldowns.

---

## 3. Design — what the implementer must build

### 3.1 Where the timer plugs in

**Recommended:** Option A — a new dedicated wrapper slotted between
`createAnthropicTerminalRecoveryStream` (or `response.body` for non-Anthropic)
and `teeStream`, at `packages/proxy/src/response-handler.ts:414` (today:
`const passthroughBody = teeStream(responseBody, { ... })`).

After the change:

```ts
const responseBody = isAnthropicMessagesSseResponse
    ? createAnthropicTerminalRecoveryStream(response.body, { /* ... */ })
    : response.body;

const passthroughBody = teeStream(
    wrapWithIdleTimer(responseBody, {
        timeoutMs: getBodyStreamIdleTimeoutMs(),
        onIdle: (info) => {
            log.warn("body_stream_idle_timeout", {
                requestId,
                accountId: account?.id ?? null,
                provider: ctx.provider.name,
                statusCode: response.status,
                idleMs: info.idleMs,
                lastChunkAt: info.lastChunkAt,
                thresholdMs: info.thresholdMs,
        }),
    }),
    { onChunk, onClose, onError },
);
```

Rationale for A over inline-in-teeStream (Option B in the agent investigation):
- Separation of concerns — `anthropic-terminal-recovery` owns its 10s
  post-`message_delta` grace, `teeStream` owns analytics buffering, the new
  wrapper owns the global "no chunks flowing at all" case.
- Independently testable against a synthetic stream — see §4.
- Mirrors the existing wrapper-per-concern layering.

### 3.2 Behaviour on idle-fire

The new wrapper (`packages/proxy/src/idle-stream-wrapper.ts`, new file):

- Reads the upstream body via `getReader()` in `pull(controller)`.
- Maintains `lastChunkAt = Date.now()`; on every `value` resets a
  `setTimeout(() => controller.error(new IdleTimeoutError(/* ... */)), timeoutMs)`.
- On `controller.error(...)`, the error propagates through `teeStream`'s
  `controller.error(error)` branch (`stream-tee.ts:65-66`), which fires
  `onError(err)` to `response-handler.ts:343-352`:
  ```ts
  const onError = (err: Error): void => {
      if (shouldProcessRequest) {
          const endMsg: EndMessage = {
              type: "end",
              requestId,
              success: false,
              error: err.message,                 // "stream_idle_timeout"
              streamTerminalState: streamTerminalState ?? null,
          };
          fireAndForgetEnd(endMsg);
      }
  };
  ```
- The wrapper MUST also call `reader.cancel()` on the upstream reader so the
  upstream socket is closed (lunetics' `request-handler-client-abort.test.ts`
  shows `reader.cancel()` does NOT close the socket on stock Bun; `abort()` on
  the fetch signal does). The cleanest path: arm the timer with a separate
  `AbortController` that calls `controller.abort()` and pass that signal into
  `makeProxyRequest`'s `effectiveSignal` plumbing. **§5.4 flags this as a
  decision the implementer must verify empirically.**

What the client sees:
- HTTP 200 (headers were sent before the timer fired).
- Stream terminates mid-content with a connection error. The client SDK sees an
  incomplete response.
- Claude Code's own 300s watchdog will already have aborted in the lunetics
  case, so on a healthy client the idle-fire race against the client watchdog
  is decided at the lower threshold (300s). At ~9 min default, the idle timer
  fires well after Claude Code has given up — so the actual user-visible
  change for well-behaved clients is **zero**. The change is for clients
  without their own watchdog (raw fetch users, custom dashboards) and for the
  observability gap (the proxy now records `success: false` instead of
  `success: true`).

What gets persisted:
- `success: false`
- `error: "stream_idle_timeout"`
- `streamTerminalState`: see §3.3 — either a new explicit `"idle_timeout"`
  state or `null` (no wrapper `onTerminalState` fired before the error).

What telemetry emits:
- The summary payload carries `streamTerminalState` (either `"idle_timeout"` if
  added, or the prior value), so dashboards/alerts already pick it up.
- Add a `log.warn("body_stream_idle_timeout", { requestId, accountId, provider,
  statusCode, idleMs, lastChunkAt, thresholdMs })` so log searches catch it
  even when telemetry is suppressed.

### 3.3 Recommended `streamTerminalState` mapping

**Recommendation:** add `"idle_timeout"` to `ANTHROPIC_TERMINAL_STATES`
(`packages/proxy/src/anthropic-terminal-recovery.ts:23-30`, the export
const-array that drives the runtime type) and to
`STREAM_TERMINAL_STATES` (`packages/types/src/request.ts:103-112`).
Update `stream-terminal-state-union-parity.test.ts` (it pins the two arrays to
the same set — without that update, the new state will trip the test).

Mapping in `response-handler.ts:314-330`:

| `streamTerminalState` | success | error column |
|---|---|---|
| `idle_timeout` | false | `"stream_idle_timeout"` |

Why a new state (rather than reusing `truncated` or letting `streamTerminalState`
stay null and using only `error`):
- Operationally distinct: a real mid-content TCP close (`truncated`) means
  the upstream died. An idle stall means the upstream is alive but silent —
  a very different thing to investigate. Operators triaging "why are these
  200 rows succeeding with no tokens" need to separate them.
- Reuses the existing `streamTerminalState` column and `/api/requests` filter,
  no schema change.

Alternative (acceptable, simpler): skip the new state, let
`streamTerminalState` stay `null` and rely on `error: "stream_idle_timeout"` to
distinguish. The implementer should pick based on how the schema migration cost
balances against the operational observability gain. The parity test must be
updated either way (otherwise the new state breaks the existing pin).

### 3.4 Should idle-fire trigger cooldown / failover?

- **Failover: NO.** `forwardToClient` has already returned the `Response` —
  failover is structurally closed (see §2.6). Adding it would require
  rearchitecting the body-stream path. Out of scope.
- **Cooldown on the account: OPTIONAL, implementer's call.** The SSE
  rate-limit sniffer pattern (`response-handler.ts:268-301`) fires
  `applyRateLimitCooldown` mid-stream on a real `event: error` frame. A
  silent idle is a weaker signal (the upstream is alive). Two acceptable
  choices:
  1. **No cooldown** — minimum behavioural change. Treat idle-fire as
     observability + record only.
  2. **Cooldown with a short duration** (e.g. 60s, the same
     `DEFAULT_RATE_LIMIT_NO_RESET_COOLDOWN_MS` used for reset-less 429s).
     Treats silent-stall as a soft "this account is unhealthy" signal.

  Recommendation: **(1) for v1**, revisit when production data accumulates.

### 3.5 Recommended default

- **9 minutes (540 000 ms).** Centered in tombii's "8-10 minutes" range,
  comfortably above Claude Code's 300s floor (zenprocess + lunetics measured
  300.7-300.97 s as the client's own giveup; the proxy idle timer at 9 min
  never preempts a healthy client) and well under the 30-minute outer ceiling.
- The implementer should expose the env var as
  `CCFLARE_BODY_STREAM_IDLE_TIMEOUT_MS` and document it under the
  `CCFLARE_*` row cluster in `docs/configuration.md`.

### 3.6 Files to change

| Path | Change |
|---|---|
| `packages/core/src/constants.ts` | Add `PROXY_BODY_STREAM_IDLE_TIMEOUT_MS: 9 * 60 * 1000` adjacent to `PROXY_REQUEST_TIMEOUT_MS` at line 32. Add named export `getBodyStreamIdleTimeoutMs()` mirroring `computeOverloadCooldownMs()` at lines 160-169. |
| `packages/core/src/constants.test.ts` | Add `"CCFLARE_BODY_STREAM_IDLE_TIMEOUT_MS"` to `ENV_KEYS` (line 11-15). Add a "honors valid positive override" assertion (line 32+) and a "rejects negative / Infinity / unparseable" assertion mirroring the existing ones. |
| `packages/proxy/src/idle-stream-wrapper.ts` *(new)* | Export `wrapWithIdleTimer(stream, { timeoutMs, onIdle }): ReadableStream<Uint8Array>` and `class IdleTimeoutError extends Error` with `name = "IdleTimeoutError"` and a message that starts with `"stream_idle_timeout"`. The wrapper pulls via `getReader()`, resets a `setTimeout` per chunk, and calls `controller.error(new IdleTimeoutError(...))` on expiry. On idle-fire it MUST also cancel the upstream reader. |
| `packages/proxy/src/response-handler.ts` | At line 414, wrap `responseBody` with `wrapWithIdleTimer(...)` before passing to `teeStream`. Add `"idle_timeout"` to the success-mapping table (lines 314-330) if §3.3 path taken. Add a `log.warn("body_stream_idle_timeout", { ... })` from the wrapper's `onIdle` callback. |
| `packages/proxy/src/anthropic-terminal-recovery.ts` | Add `"idle_timeout"` to `ANTHROPIC_TERMINAL_STATES` (line 23-30) — only if §3.3 path taken. |
| `packages/types/src/request.ts` | Add `"idle_timeout"` to `STREAM_TERMINAL_STATES` (line 103-112) — only if §3.3 path taken. |
| `packages/proxy/src/__tests__/stream-terminal-state-union-parity.test.ts` | The test pins the producer + API arrays to the same set — must be updated to allow the new state, or simply re-runs cleanly with the new state added to both arrays. |
| `packages/proxy/src/__tests__/idle-stream-wrapper.test.ts` *(new)* | See §4 for cases. |
| `docs/configuration.md` | Add a row under "Additional Environment Variables" (line 113+) in the `CCFLARE_*` cluster. |
| `docs/data-flow.md` *(optional but recommended)* | Mention idle-fire as a path in the body-stream section if it describes streaming behaviour. |
| `.env.example` | None of the recent tunables are listed there; leaving it consistent with the existing pattern is fine. |

---

## 4. Tests — concrete cases and the real command

### 4.1 The real command

```bash
# All proxy tests (handles src/__tests__/ + src/handlers/__tests__/)
bun test packages/proxy

# Just the new file
bun test packages/proxy/src/__tests__/idle-stream-wrapper.test.ts

# Just the parity test if §3.3 path is taken
bun test packages/proxy/src/__tests__/stream-terminal-state-union-parity.test.ts
```

There is **no** `bun run test:unit` or proxy-specific test script — only
`"test": "bun test"` at the root and `"typecheck": "bunx tsc --noEmit"` in
`packages/proxy/package.json`. Path filters are the standard. There is **no**
CI workflow on upstream/main that runs `bun test` — pre-push test invocation
is left to the developer (per `docs/contributing.md`).

There are **no** `bun:test` fake timers (`setSystemTime` / `advanceTimersByTime`)
in use anywhere in `packages/proxy/`. New tests must use real `setTimeout` /
`setImmediate` / `Bun.sleep`, or a `Date.now` swap (the pattern in
`packages/proxy/src/__tests__/usage-collector-lifecycle.test.ts:216-245`),
or copy `controllableStream` from `anthropic-terminal-recovery.test.ts:25-37`.

### 4.2 New file — `packages/proxy/src/__tests__/idle-stream-wrapper.test.ts`

Mirror the `controllableStream` pattern. Cases:

1. **Idle-fire on no chunks at all.** Build a stream that never enqueues
   anything and never closes. `wrapWithIdleTimer(stream, { timeoutMs: 50 })`.
   Read from the wrapped stream. Expect `controller.error()` to fire within
   ~50ms, with `IdleTimeoutError`. Verify `onIdle` callback was called once.

2. **Idle-fire after some chunks.** Enqueue a chunk, wait `timeoutMs / 2`,
   enqueue another chunk, wait `timeoutMs + 10`. Expect no error during the
   wait-after-chunk intervals. Expect the error to fire after the silent gap.

3. **Idle-fire reset on every chunk.** Steady stream of chunks at intervals
   of `timeoutMs / 2`. Read all chunks. No error.

4. **No chunks after header close (clean EOF).** Enqueue a chunk, then
   `controller.close()`. Expect no error (clean EOF does not idle-fire).

5. **Upstream cancel propagates.** Call `reader.cancel()` on the wrapped
   stream. Expect the wrapper's upstream `getReader().cancel()` to be called
   (verify with a mock reader).

6. **Env-tunable default is 540 000 ms.** In a separate test (or constants
   test), assert `getBodyStreamIdleTimeoutMs()` returns `540_000` when
   `process.env.CCFLARE_BODY_STREAM_IDLE_TIMEOUT_MS` is unset.

7. **Env-tunable override.** Set `process.env.CCFLARE_BODY_STREAM_IDLE_TIMEOUT_MS = "120000"`,
   assert `getBodyStreamIdleTimeoutMs() === 120_000`. (Save/restore in
   beforeEach/afterEach like `constants.test.ts:11-40`.)

8. **Integration with `forwardToClient`.** Mock `getUsageCollector()` with
   `bun:test` `mock()` (`response-handler-anthropic-terminal-recovery.test.ts:255-263`
   for the pattern). Build a synthetic streaming response that emits one chunk
   then goes silent. Set `getBodyStreamIdleTimeoutMs()` to a tiny threshold
   for the test (use `process.env` or pass it explicitly). Assert the end-
   message fires with `success: false`, `error: "stream_idle_timeout"`, and
   `streamTerminalState: "idle_timeout"` (if §3.3 path taken) or `null`.

### 4.3 Existing tests to verify still pass

```bash
bun test packages/proxy/src/__tests__/stream-terminal-state-union-parity.test.ts
bun test packages/proxy/src/__tests__/anthropic-terminal-recovery.test.ts
bun test packages/proxy/src/__tests__/response-handler-anthropic-terminal-recovery.test.ts
bun test packages/proxy/src/__tests__/bun-leak-273-regression.test.ts
bun test packages/proxy/src/handlers/__tests__/request-handler-client-abort.test.ts
bun test packages/proxy/src/handlers/__tests__/proxy-operations-client-abort.test.ts
```

The existing tests should not regress — the new wrapper sits between the
recovery wrapper and teeStream and only changes behaviour when its timer
fires (which existing tests do not exercise).

---

## 5. Things the implementer must VERIFY (not trust from this brief)

These are the load-bearing claims where I am not certain enough to skip the
empirical check.

1. **§2.4 — 1565a5d4 is reachable from upstream/main.** Verified via
   `git merge-base --is-ancestor 1565a5d4 upstream/main` returning YES and
   `git rev-list upstream/main | grep -n 1565a5d4` returning 164 of 200. One
   of the parallel investigation agents reported uncertainty about
   position-count and the agent's `git log --oneline` default-tail output
   did not surface it — the brief's claim is correct, but verify yourself
   with `git rev-list upstream/main | grep 1565a5d4` before quoting externally.

2. **§3.2 — `controller.error()` alone does not abort the upstream fetch.**
   The error propagates through `teeStream`'s downstream controller only;
   the upstream `fetch()` is unaffected. To actually close the upstream
   socket, the implementer must either (a) call `reader.cancel()` on the
   upstream reader from the wrapper's idle callback, or (b) plumb an
   `AbortController` through to `makeProxyRequest`'s signal. Option (b)
   closes the socket faster on stock Bun (lunetics measured 8ms via abort()
   vs. ambiguous for cancel() in `request-handler-client-abort.test.ts`),
   but requires threading the signal through `wrapWithIdleTimer`'s
   contract. **Measure this on the actual Bun version in use** before
   shipping — Bun's behaviour changed in 2026 (PR `789be97d` upstream
   Bun; zenprocess verified no stable release currently contains the fix,
   per the issue thread).

3. **§3.2 — Idle-fire race with `req.signal.aborted`.** When the client
   disconnects while the wrapper is mid-pull, both the client's
   `req.signal` and the wrapper's idle timer may fire near-simultaneously.
   The downstream stream will see one error first. Verify that
   `controller.error()` (from idle) and `req.signal` propagating cancel
   produce a single `onError` call and a single end-message — not two,
   which would race the AsyncDbWriter.

4. **§3.3 — parity test update is required, not optional.**
   `stream-terminal-state-union-parity.test.ts` compares two arrays at
   runtime. Adding a state to only one side will trip the test. Verify
   both `ANTHROPIC_TERMINAL_STATES` and `STREAM_TERMINAL_STATES` are
   updated together.

5. **§3.4 — non-Anthropic providers' body transforms.** The PR-#360
   workaround for the signal-dropping URL-rebuild pattern is at
   `proxy-operations.ts:574-582, 722, 758, 801, 1165, 1194`. OpenAI-
   compatible, codex, qwen, bedrock etc. may have their own transforms.
   The new wrapper inherits the existing signal plumbing; verify the
   idle-fire path on at least one non-Anthropic provider before
   declaring success.

6. **§3.6 — `docs/configuration.md` row format.** The gold-standard row
   shape is the `CCFLARE_OVERLOAD_*` block at lines 132-140. Match it
   exactly. The brief specifies "9 minutes" but verify the project's
   prose style for "ms" vs "minutes" in that table (the existing rows mix).

7. **§3.6 — schema migration for the new `idle_timeout` state.** §3.3
   path requires no schema change (it reuses the existing
   `stream_terminal_state` TEXT column). The migration question only
   arises if the implementer wants to also persist an `idle_timeout_ms`
   or similar new column — DON'T. Reuse the existing column.

8. **§2.5 — telemetry gaps.** The `RequestStartEvt` does NOT carry
   `streamTerminalState`. Live idle-fire observation only happens via
   the `RequestSummaryEvt` (post-close). If real-time alerting is
   desired before the stream closes, the implementer must add a
   dedicated event type or piggy-back on `log.warn` subscriptions. Not
   strictly required for v1.

---

## 6. Uncertainties I could not determine

- **The exact line range of `forwardToClient` may have shifted slightly.**
  I cited 304-341, 358-426, 419-426 based on the agent's read of
  `git show upstream/main:packages/proxy/src/response-handler.ts`. If the
  file has been touched since 6f2c9d28 (and the worktree sync catches up),
  re-verify these lines before editing.

- **`request-handler-client-abort.test.ts` chunk-delay default.** Cited
  as 100ms based on the agent's read; if the file's default changed, the
  helper signature changes too.

- **Bun runtime behaviour for `reader.cancel()` on idle fires.** Not
  empirically verified — the brief recommends aborting via the upstream
  signal but the choice (cancel vs abort) is left to the implementer.

- **Whether `saveRequest`'s UPSERT semantics could re-finalize the same
  request id.** The agent flagged this. Not material for v1 (single
  producer today), but worth knowing.

- **Exact line numbers of `proxy-operations.ts:574-582, 722, 758, 801,
  1165, 1194`.** Cited from the streaming-path agent's read; the
  surrounding code may have drifted, but the **pattern** (explicit
  `signal: req.signal` at every upstream call site) is structural and
  should be the implementer's guide.

- **Whether the worktree at /Users/vvladescu/ao-projects/ccflare has
  the same line numbers as upstream/main.** It does not — the worktree
  is 130 commits behind. **Do not read the worktree for line numbers.**
  This brief cites only upstream/main.

---

## 7. Acceptance criteria for the implementer's PR

A passing PR satisfies all of:

1. `bun test packages/proxy` passes with zero regressions on existing
   suites.
2. The new `idle-stream-wrapper.test.ts` covers cases 1-8 from §4.2 and
   passes.
3. `bun test packages/core` passes (for the new env-tunable tests in
   `constants.test.ts`).
4. `bun run typecheck` and `bun run lint` pass at the repo root.
5. Manual smoke: with `CCFLARE_BODY_STREAM_IDLE_TIMEOUT_MS=10000` set,
   a request against a deliberately stalled upstream produces a row
   with `success: false`, `error: "stream_idle_timeout"`, and
   `streamTerminalState: "idle_timeout"` (or null per §3.3).
6. Default behaviour (env unset): idle-fire happens at 9 minutes.
7. No new env var on `PROXY_REQUEST_TIMEOUT_MS` — the header timeout
   stays at 30 minutes and is unaffected.
8. PR description links tombii/better-ccflare#348, references PR #360
   as the predecessor (abort-on-client-disconnect), and cites this
   brief.

---

## 8. References

- tombii/better-ccflare#348 — the issue (read on 2026-08-06)
- tombii/better-ccflare#360 — predecessor PR (`fd389fd2`, `cec5b5b9`,
  `23cf0cea`) — abort-on-client-disconnect + `stream_terminal_state`
- 1565a5d4 — premature-SSE-termination detection, Val, 2026-07-27
- 789be97d (oven-sh/bun) — fetch-abort fix, not in any stable Bun as
  of 2026-08-06 per the issue thread
- Response 23cf0cea — `stream_terminal_state` column + `/api/requests`
  read side