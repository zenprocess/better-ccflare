# tombii/better-ccflare #348 — does zp6 data isolate the recording half from the abort half?

Authored to verify-or-demolish the proposed claim before publishing it to
#348:

> Our live build (`origin/deploy/zp6`) carries the READ side of the
> terminal-state work (`stream_terminal_state`, `client_cancelled` are
> present) but NOT the abort wiring. `AbortSignal.any` appears 0 times in
> zp6 and `fd389fd2` is not an ancestor. So our rows would show
> client-disconnects being RECORDED on a build where the upstream fetch
> is NOT linked to the client signal — making our data a control group
> isolating the two halves.

**Verdict: demolish the framing, keep one narrow observation.**

The recorded **`response_time_ms` on a `client_cancelled` row on zp6
measures the duration of the stream before the client cancelled, not
the duration that the upstream fetch outlived the client.** That is the
same number v3.5.46 would write for the same disconnect. There is no
field, log line, or counter on zp6 that distinguishes "upstream
fetch was aborted" from "upstream fetch kept streaming into the void."
The claimed control group splits the code, but the data it produces on
either side of that split is observationally indistinguishable on this
metric.

What IS true (and is itself worth publishing) is the narrower code-state
observation: zp6 records `client_cancelled` correctly while never
threading `req.signal` into the upstream fetch. That is verifiable from
source; it does not need operational data to support it.

---

## 1. Source verification (what is actually true)

### 1.1 `origin/deploy/zp6` does NOT contain the abort wiring

| Probe | Result |
|---|---|
| `git merge-base --is-ancestor fd389fd2 origin/deploy/zp6` | `false` |
| `git grep "AbortSignal.any"` over `origin/deploy/zp6:packages/**/*.ts` | 0 occurrences |
| `git grep "req.signal"` in `proxy-operations.ts` on zp6 | 0 occurrences |
| `makeProxyRequest` call sites in zp6 `proxy-operations.ts` | 5 sites, all call without `signal` arg |

`makeProxyRequest` on zp6 (`packages/proxy/src/handlers/request-handler.ts:88-150`)
DOES accept `signal?: AbortSignal` as its 6th positional argument. The
internal controller it creates when the argument is missing has the
30-minute header timeout and is cleared in the `finally`:

```ts
const effectiveSignal =
    signal ??
    (() => {
        internalController = new AbortController();
        timeoutId = setTimeout(
            () => internalController?.abort(),
            TIME_CONSTANTS.PROXY_REQUEST_TIMEOUT_MS,  // 30 min
        );
        return internalController.signal;
    })();
// ...
try { return await fetch(..., { signal: effectiveSignal }); }
finally { if (timeoutId) clearTimeout(timeoutId); }
```

Because every call site omits `signal`, every upstream fetch is bound
to a controller that:
1. Times out at 30 minutes if headers never arrive.
2. Becomes unreachable from the client the moment headers arrive
   (the `finally` clears the timer; the controller object is still
   alive but no one holds a reference to its `.signal`).

This matches the framing in `fd389fd2`'s commit message verbatim —
"from then on the upstream request has no abort path at all" — for
every zp6 upstream call.

### 1.2 The recording path on zp6 fires correctly on client disconnect

The wrapper transform (`packages/proxy/src/anthropic-terminal-recovery.ts:573-583`)
sets `clientCancelled = true` from its downstream `cancel(reason)`
handler:

```ts
cancel(reason) {
    if (finalized) return;
    finalized = true;
    clearRecoveryTimer();
    // Downstream (client) cancellation, not upstream failure. Set
    // before firing so determineTerminalState classifies this as
    // "client_cancelled" ...
    clientCancelled = true;
    fireTerminalState();
    return cancelUpstream(reason);
},
```

`fireTerminalState()` synchronously writes the state into a closure
variable in `response-handler.ts:368-390`. `teeStream` then runs
`onClose` (`response-handler.ts:300-336`) which builds an
`EndMessage` with `streamTerminalState: "client_cancelled"` and calls
`fireAndForgetEnd`. The first `EndMessage` per `requestId` writes the
DB row (`usage-collector.ts:619-631`); the second (the trailing
`onError` from a possibly-rejected `cancelUpstream`) is dropped
because the request state has already been transferred out of the
map.

`response_time_ms` is computed in `_handleEndInternal` at
`usage-collector.ts:631`:

```ts
const responseTime = Date.now() - startMessage.timestamp;
```

That timestamp is when `handleStart` ran, **before** the upstream was
fetched — so `response_time_ms` is "request start → client cancel
event arrived in the worker, plus a few ms of cancel-propagation
through `teeStream`'s `pull()` returning `done:true`." It is the
client-side disconnect duration. **It does not measure the upstream
post-cancel tail.**

This is test-confirmed: the `proxy-operations-client-abort` test
(`fd389fd2`) tests the upstream-side signal propagation against a
real local Bun server with a `cancel()` handler; it is the only place
that observes the missing `abort()` call. zp6 has no equivalent
shape — there is no equivalent observation on the upstream side.

### 1.3 The recording is operating with full coverage on zp6

Concretely, on zp6 today:
- `stream_terminal_state` column is created in both
  `packages/database/src/migrations.ts` and `migrations-pg.ts`.
- `client_cancelled` rows are written by `usage-collector.ts:851`
  (`msg.streamTerminalState ?? null`).
- HTTP API exposes the field on `GET /api/requests` and `/api/requests/stream`
  (`stream_terminal_state` → `streamTerminalState`).
- The wrapper transform produces `"client_cancelled"` values whenever
  its downstream `cancel()` fires.

So rows **will** be written. Plenty of them. The recorded value
captures a real event — the client did disconnect mid-stream —
on a build that genuinely does not abort the upstream. That much of
the framing is correct.

---

## 2. Why the "control group isolating the two halves" framing collapses

### 2.1 What `response_time_ms` actually measures on a `client_cancelled` row

Trace, on zp6, from client disconnect to DB write:

1. `client` cancels → `teeStream.cancel(reason)` is invoked.
2. `teeStream.cancel` calls `wrapper.reader.cancel(reason)`.
3. Wrapper's `cancel(reason)` runs synchronously: sets
   `clientCancelled = true`, runs `fireTerminalState()` which writes
   the state into the closure variable, then calls
   `cancelUpstream(reason)` which calls
   `upstream.reader.cancel(reason)`. Per `fd389fd2`'s commit message
   on Bun ≥ 1.3.11, **`reader.cancel()` does not close the
   upstream socket** — the upstream fetch keeps streaming. That
   property is exactly the bug PR #360 exists to fix.
4. The EndMessage with `streamTerminalState: "client_cancelled"` is
   enqueued to the worker.
5. `_handleEndInternal` computes
   `responseTime = Date.now() - startMessage.timestamp` and writes
   the row.

Steps 1-4 complete within ~milliseconds of each other on a healthy
Bun runtime. **The DB row is finalized before the upstream socket
closes.** Whether the upstream then runs for 5 more seconds or 25
more minutes is invisible to the DB.

### 2.2 The same number is produced on v3.5.46

On v3.5.46, the same disconnect flow:
1. `req.signal` aborts.
2. `AbortSignal.any([callerSignal, timeoutController.signal])` in
   `request-handler.ts` actually fires an abort on the fetch.
3. The fetch throws `AbortError` upstream; the upstream socket
   closes immediately.
4. The wrapper's `cancel()` still runs, sets `clientCancelled =
   true`, fires the terminal state, writes the row.
5. `_handleEndInternal` writes `response_time_ms` = (start → cancel
   propagation), just like zp6.

**The recorded `response_time_ms` value is the same metric on both
builds, and measures the same thing — client-side disconnect
duration.** The only place the two builds visibly diverge is in
provider-side behavior (and in log signature: 499 vs cascade — see
existing 348 plan §2.1, the pre-flight runbook already published on
2026-08-01).

### 2.3 Implication

A distribution over `response_time_ms WHERE stream_terminal_state =
'client_cancelled'` on zp6, compared to the same query on v3.5.46,
will be **near-identical in shape**. Differences will be dominated by
traffic mix, time-of-day, model choice, and user behavior — not by the
presence or absence of `AbortSignal.any`.

There is no scenario in which the `response_time_ms` distribution
on `client_cancelled` rows can be interpreted as evidence about
upstream leak duration. The user's framing converts the absence of
aborts into "control-group evidence," but the data being collected
does not contain the variable the framing needs.

---

## 3. What distributions WOULD support or falsify the claim (per the original prompt)

The original prompt asked what shape of `response_time_ms` values on
`client_cancelled` rows would constitute evidence. **Answering honestly
per §2.1-2.3 above: none.** This is the verdict.

For completeness, what the data WILL look like (which is not what the
claim needs):

- The median `response_time_ms` on zp6 `client_cancelled` rows will
  reflect typical client-disconnect timing — distribution will be a
  mixture of:
  - Short durations (<10 s): user-initiated Esc / interrupt, tool
    abort, network drop during first response chunk.
  - Medium durations (10-300 s): Claude Code's idle-progress wait
    timeout firing on a slow stream.
  - Long-tail durations (>300 s): Claude Code worker being reaped
    by an external supervisor (`/health` 503 path, container
    restart, OOM, manual stop). The exact distribution of
    disconnect-source timing drives the bulk of the long-tail
    shape, NOT upstream leak duration.

Critically: **a SHORT `response_time_ms` on a `client_cancelled` row
is NOT evidence of a leaked upstream.** A short cancellation can still
leave the upstream streaming until it times out (header timeout is
30 min; provider's own keepalive often <5 min; some providers let it
run to natural completion). A short `response_time_ms` only confirms
the client cancelled early; it says nothing about what happened to
the upstream after.

A LONG `response_time_ms` (>10 min, approaching `PROXY_REQUEST_TIMEOUT_MS`)
on a `client_cancelled` row IS suspicious — `client_cancelled`
should typically come from the cancel path, which fires within ms;
a long value would suggest the row was written by a different code
path (e.g., a delayed `onClose` from upstream finishing naturally
and triggering `clientCancelled` secondarily), but the chain of
events is too entangled to interpret as upstream-leak duration.

---

## 4. Confounders (especially the alleged 900-1200 s watchdog reap band)

### 4.1 The proxy in-memory reaper is NOT a 900-1200 s band

`packages/proxy/src/usage-collector.ts:362`:

```ts
this.timeoutMs = Number(
    process.env.CF_STREAM_TIMEOUT_MS ||
    TIME_CONSTANTS.STREAM_TIMEOUT_DEFAULT,  // 1 minute (packages/core/src/constants.ts:26)
);
```

The in-memory reaper in `cleanupStaleRequests`
(`usage-collector.ts:1061-1098`) evicts a request from the map when
`inactivity > timeoutMs` (~60 s default). The cleanup itself runs
every 30 s. **This reaper is not the same thing as the operator's
"watchdog reap."** What the reaper does:
- Removes the in-memory state for a stalled request that emits no
  chunks for >60 s.
- **Does not** emit an `EndMessage` of any kind.
- **Does not** write a DB row.
- **Does not** abort the upstream fetch.

So if a 900-1200 s worker reap band exists at all, it is NOT a
feature of the proxy code I can identify on the zp6 tree. Possible
sources of a longer band:
- An external supervisor (k8s pod, systemd watchdog, docker
  restart policy).
- Claude Code's own internal idle timeouts.
- A `Bun.serve` `idleTimeout` setting (max 255 s, per
  `packages/core/src/constants.ts:254` — note the proxy uses the
  default of 0 in some places).

The operator's claim about a 900-1200 s reap band needs to be
verified against the actual deploy config on `ccmax` / `ccproxy2`
(`/health?detail=1`, supervisor unit, compose healthcheck). It is
not a property of the proxy code.

### 4.2 Confounders that DO exist in zp6

- **Traffic mix heterogeneity.** `client_cancelled` rows aggregate
  user-initiated cancels, Claude Code worker reaps at multiple
  supervisor layers, network drops, and HTTP-client idle
  timeouts. Without instrumentation distinguishing the source, the
  `response_time_ms` distribution is the convolution of several
  processes, not one.
- **The request-handler timeout is 30 minutes**
  (`PROXY_REQUEST_TIMEOUT_MS`), so a request CAN in principle
  have a `response_time_ms` up to that value even on a healthy
  build. A `client_cancelled` row with `response_time_ms` near
  30 minutes is ambiguous: it could be the in-memory reaper
  letting go and a trailing `client_cancelled` end winning, or a
  genuinely-slow provider whose response took that long.
- **The wrapper's recovery timer**
  (`ANTHROPIC_TERMINAL_RECOVERY_GRACE_MS`, 10 s) can fire on a
  client-cancelled stream if the upstream was still producing
  bytes; this doesn't change `stream_terminal_state` (it stays
  `client_cancelled`) but it interleaves the cancel with the
  recovery timer path.
- **`onError` fires AFTER `onClose` for client-cancelled rows**
  in some paths — see the response-handler test comment
  ("there may be a subsequent error end from the upstream-cancel
  rejection"). Two end messages per row, but only one wins the
  DB write. If someone naively counts `EndMessage` log lines
  versus DB rows, they'll see a mismatch.

These are all primarily relevant if the claim is published as
"the ABORT FIX reduces the rate of `client_cancelled` rows" or
some shape argument. None of them change the §2 verdict.

---

## 5. What we CANNOT conclude from this data, regardless of what it shows

1. **Whether the upstream fetch outlived the client.** Not measured.
2. **By how long.** Not measured.
3. **Whether provider billing was charged for the orphaned
   upstream compute.** Out of our control.
4. **Whether the upstream socket stayed open.** Not measured.
5. **That "our rows show client-disconnects being RECORDED on a
   build where the upstream fetch is NOT linked to the client signal"
   demonstrates anything beyond the recording working.** True
   observation, narrow consequence.
6. **That comparing zp6's `client_cancelled` distribution to
   v3.5.46's would isolate the abort-wiring effect.** Indistinguishable.
7. **That the missing `AbortSignal.any` is actually causing
   user-visible harm in our environment.** Plausible but inferred
   only from `fd389fd2`'s code analysis — our data adds nothing.

---

## 6. What we CAN claim honestly (and what we already had)

### 6.1 Narrowest accurate claim (publishable)

**Code-state observation**, not data-driven:

> `origin/deploy/zp6` ships `stream_terminal_state` and `client_cancelled`
> end-message emission, verified by inspection of
> `packages/proxy/src/{anthropic-terminal-recovery.ts, response-handler.ts,
> usage-collector.ts}`. The same build does not contain `fd389fd2`'s
> `AbortSignal.any([callerSignal, timeoutController.signal])` change;
> every `makeProxyRequest` call in `proxy-operations.ts` omits the
> `signal` argument, so the upstream fetch becomes unreachable from
> `req.signal` after the header phase. This is verifiable from
> `git merge-base --is-ancestor fd389fd2 origin/deploy/zp6` (false)
> and `git grep "AbortSignal.any"` over zp6 source (zero hits).
>
> This means our fleet at the moment the upgrade to v3.5.46 lands
> will go from "record a disconnect, leave the upstream to time out
> in 30 minutes" to "record a disconnect AND abort the upstream
> fetch." The DB rows themselves do not distinguish the two
> behaviors — they only confirm that a disconnect occurred.

That is publishable on #348 without operational data, and it is the
honest version of the claim.

### 6.2 What the existing pre-flight plan already covers

`docs/348-preflight-evidence-ccflare131.md` (committed 2026-08-03 in
`68bf6c1b`, prior session) ALREADY specifies what to capture on the
v3.5.46 build to close out PR #360:

- §2.1 — single 499 line per disconnect (vs cascade of "All
  accounts failed" pre-fix).
- §2.2 — `streamTerminalState` distribution on `/api/requests`
  must contain non-zero `client_cancelled` while watchdog reaps
  are running.
- §2.3 — orphan scan: zero rows with `status_code=200 AND
  response_time_ms > 30min AND stream_terminal_state IS NULL AND
  error_message IS NULL`.

That evidence collection runs on the NEW build. The user's framing
attempts to instead argue from the OLD build's records. That is
not the same measurement, and §2.3 specifically does not depend on
distribution shape — it depends on the absence of an orphan class
in the DB, which only becomes provable AFTER the upgrade lands.

### 6.3 A productive additional measurement (optional, not required)

If we still want operational evidence from the zp6 window, the
only thing that actually isolates the abort-wiring effect is a
**log-signature measurement**, not a `response_time_ms`
distribution:

- On zp6 today, count log lines from `journalctl -u
  better-ccflare` matching `grep -c "All accounts failed"` per
  disconnect event.
- Count `JournalLog` 5xx / 499 / `Client disconnected` patterns.

That gives us a V3.5.46-vs-zp6 comparison on a metric that
actually changes. It is not what the user's prompt asks for, but
it is the only live signal that bears on the abort-wiring
mechanism rather than on the recording mechanism.

---

## 7. Recommendation

If the question is "should we publish that zp6 data proves the
abort half is missing?", **no**. The data does not prove that, and
posting it that way invites a maintainer to point at §2.2 of this
analysis and walk away.

If the question is "should we publish that zp6 carries recording
without abort wiring?", **yes** — but as a code-state observation
(§6.1), not as a data argument. The existing #348 plan already
includes the necessary operational capture for what we genuinely
need to prove from data; that capture happens on the new build,
not the old one.

If the honest answer is "this data does not isolate anything
interesting," as the prompt allows, **that is the answer**. §2
shows why.

---

## Provenance

- `git merge-base --is-ancestor fd389fd2 origin/deploy/zp6` → false
- `git grep "AbortSignal.any"` over `origin/deploy/zp6:packages/**/*.ts` → 0 hits
- `git show origin/deploy/zp6:packages/proxy/src/handlers/request-handler.ts:88-150` — `makeProxyRequest` signature, internal controller, `finally` clearTimeout
- `git show origin/deploy/zp6:packages/proxy/src/handlers/proxy-operations.ts` — 5 `makeProxyRequest` call sites, none pass `signal`
- `git show origin/deploy/zp6:packages/proxy/src/anthropic-terminal-recovery.ts:573-583` — `cancel()` sets `clientCancelled = true`
- `git show origin/deploy/zp6:packages/proxy/src/response-handler.ts:300-336` — `onClose` builds EndMessage with `streamTerminalState: "client_cancelled"`
- `git show origin/deploy/zp6:packages/proxy/src/stream-tee.ts` — `pull()` calls `onClose` on `done:true`; `cancel()` returns `reader.cancel(reason)` (does NOT enqueue `done`)
- `git show origin/deploy/zp6:packages/proxy/src/usage-collector.ts:619-631` — `responseTime = Date.now() - startMessage.timestamp` (no upstream-tail inclusion)
- `git show origin/deploy/zp6:packages/proxy/src/usage-collector.ts:1061-1098` — `cleanupStaleRequests` inactivity threshold
- `git show origin/deploy/zp6:packages/core/src/constants.ts:26` — `STREAM_TIMEOUT_DEFAULT = 1 minute` (NOT 900-1200 s)
- `git show fd389fd2` — commit message explicitly states "reader.cancel() does not close the socket in Bun, only abort() does"
- `git show 68bf6c1b:docs/348-preflight-evidence-ccflare131.md` — sibling doc, prior session's plan for the v3.5.46 evidence capture
