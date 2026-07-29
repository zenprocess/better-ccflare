# BLUEGREEN-DESIGN.md

**Branch examined:** `upstream/main` @ `053746c1` (better-ccflare 3.5.44, the version ccmax runs)
**Worktree:** `ao/ccflare-63/root`
**Deployed image (from spec):** `registry.zp.digital/zen-infra/ccflare:amd64` (Bun 1.2.23, 3.5.44)

> **Analysis only. No code, no config, no PR, no push, no live-service mutations.** This
> document catalogues per-process state and recommends a cutover / rollback shape, but
> does not change anything in `apps/server/src/server.ts` or elsewhere.

---

## 0. The headline finding

A shared PostgreSQL does NOT make blue/green safe for ccflare 3.5.44. The repo has at
least seven categories of per-process, module-level, or class-instance state that two
replicas behind one hostname would diverge on, and several of them are the exact
mechanisms that make the proxy work correctly (session stickiness, rate-limit
single-flight recovery, usage-cache coherence, prompt-cache keepalive). A Postgres
backend fixes accounts, OAuth tokens, sessions, request history, alerts, strategies,
combos, OAuth PKCE, API keys, agent prefs, model translations, and usage snapshots —
but leaves the in-memory layers untouched.

The most damaging divergence is `SessionAffinityStrategy` (the `clientId →
{accountId, assignedAt}` Map) because the prompt-cache benefit of pinning clients to
a single upstream is the entire reason the strategy exists. With two replicas, half
the requests for the same client land on the wrong replica, get reassigned to a
fresh account, and lose prompt-cache locality for the duration of the divergence.

ccflare's own source documents this explicitly. `session-governor.ts:24-30` reads:

> *State is process-local by design: better-ccflare runs as a single-process local
> proxy. A multi-replica deployment without session-affinity routing would multiply
> the effective budget by the replica count; that setup needs shared state (or
> affinity) and is out of scope here.*

That is the maintainers saying "we have not designed for two replicas." Blue/green
without code changes risks (a) doubling effective per-session rate-limit budgets,
(b) losing prompt-cache stickiness, (c) breaking single-flight recovery probes, and
(d) splitting the usage cache. The cutover mechanics in §6 assume a shared
Postgres alone and explain why each one of these still bites; the recommendation
in §8 is therefore: **share Postgres AND introduce sticky-by-`clientSessionId`
routing at the load balancer before going blue/green**, and gate the deploy behind
the code changes in §7.

---

## 1. What state must be shared, enumerated from the schema

The Postgres schema for the deployed version is `packages/database/src/migrations-pg.ts`
(`ensureSchemaPg`). Tables that exist on both backends:

| Table | Holds | Already DB-shared |
|---|---|---|
| `accounts` | OAuth tokens, session_start, session_request_count, rate_limited_until, paused, priority, model_mappings, fallbacks, auto_fallback, auto_refresh, custom_endpoint, model_fallbacks | ✅ |
| `requests` | Per-request history (status, model, tokens, cost, project, agent, billing_type, stream terminal state) | ✅ |
| `request_payloads` | Cached request/response bodies (PK references `requests.id`) | ✅ |
| `alerts` | Threshold / anomaly history | ✅ |
| `oauth_sessions` | PKCE verifiers + mode + custom_endpoint + priority + expiry | ✅ |
| `agent_preferences` | Per-agent model override | ✅ |
| `api_keys` | Hashed dashboard auth keys | ✅ |
| `model_translations` | Client → Bedrock model mapping | ✅ |
| `combos`, `combo_slots`, `combo_family_assignments` | Account-routing rules | ✅ |
| `strategies` | Strategy selection + session_duration_ms | ✅ |
| `usage_snapshots` | Per-account per-window utilization history | ✅ |

Verified at `upstream/main:packages/database/src/migrations-pg.ts:50-200` and
`packages/database/src/migrations.ts:80-400` (SQLite parity version).

**Conclusion of this section:** what is *obviously* DB-shaped is already
DB-shaped, including the parts a blue/green operator most cares about (tokens,
cooldown timestamps, session start, request history). Postgres as the shared
backend therefore makes the *persistent* side of the cutover safe. The remainder
of this document is the part Postgres does not see.

---

## 2. Per-process / in-memory state that a shared Postgres does NOT fix

The following are all on the **per-instance** code path. Each one is module-level
or class-instance state held inside the running Bun process — not in Postgres. Two
replicas behind one hostname each carry their own copy; nothing in the deploy plan
keeps them in sync.

### 2.1 `SessionAffinityStrategy` — per-client sticky mapping
**File:** `packages/load-balancer/src/strategies/session-affinity.ts`

Per-instance state declared as private Maps on the strategy class:

```ts
// session-affinity.ts:78
private affinity = new Map<
    string,
    { accountId: string; assignedAt: number }
>();
// session-affinity.ts:83
private lastPickedAt = new Map<string, number>();
```

The `affinity` Map is the entire reason `SessionAffinityStrategy` exists. The
doc-comment at lines 84-91 explains the design:

> *That client→account mapping is then made STICKY for `affinityTtlMs`, so every
> subsequent request from the same client keeps hitting the same upstream →
> prompt-cache affinity is preserved across the agentic loop.*

With two replicas, half of a sticky client's requests hit the replica that owns
its mapping; the other half hit a replica where the mapping does not exist. On
the second replica the strategy falls into the "new client-session" branch
(`session-affinity.ts:230-247`) and assigns a fresh least-loaded account. The
client sees a different upstream until the cache TTL on replica 1 expires
(`affinityTtlMs`, default `TIME_CONSTANTS.ANTHROPIC_SESSION_DURATION_DEFAULT`).

This is the headline finding — it is the per-process state the spec asked us to
find.

### 2.2 `LeastUsedStrategy` & `SessionDrainSoonestStrategy` — recency penalty Map
**Files:** `packages/load-balancer/src/strategies/least-used.ts:69`,
`packages/load-balancer/src/strategies/session-drain-soonest.ts`

Both keep a `lastPickedAt: Map<string, number>` for the recency-penalty logic
(documented at `least-used.ts:43-50`). With two replicas, each replica's
`lastPickedAt` reflects only its own request stream. The purpose of the penalty
is to spread concurrent bursts across the pool; per-instance spreading makes
cross-replica burst spreading uneven — replica 1's penalty profile looks
nothing like replica 2's.

### 2.3 `UsageCache` — singleton with twelve private Maps
**File:** `packages/providers/src/usage-fetcher.ts:586-595` (class), `:1200`
(singleton export)

```ts
class UsageCache {
    private cache = new Map<string, { data: AnyUsageData; timestamp: number }>();
    private pollTimeouts = new Map<string, NodeJS.Timeout>();
    private failureCounts = new Map<string, number>();
    private tokenProviders = new Map<string, AccessTokenProvider>();
    private providerTypes = new Map<string, string>();
    private customEndpoints = new Map<string, string | null>();
    private windowResetCallbacks = new Map<string, (accountId: string) => void>();
    private usageRateLimitedUntil = new Map<string, number>();
    private capacityRestoredCallbacks = new Map<string, (accountId: string) => void>();
    private snapshotCallbacks = new Map<string, (accountId: string, data: UsageData) => void>();
    private inFlightFetches = new Map<
        string,
        Promise<{ success: boolean; retryAfterMs: number | null }>
    >();
}
// usage-fetcher.ts:1200
export const usageCache = new UsageCache();
```

Twelve private Maps. Polling intervals, the usage-poll retry schedule, the
in-flight-fetch deduplication, the 429 cooldown on the usage API itself
(`usageRateLimitedUntil`), and the per-account window-reset / capacity-restored
callbacks all live here. Two replicas double the polling load and produce
duplicate `recordUsageSnapshot` writes to Postgres.

There is no explicit lifecycle method to clear it (the file does export `clear()`,
used at server-shutdown `server.ts:1939`); startup of the new replica populates
it from scratch via `startPolling` for each refresh-backed account
(`server.ts:1495-1575`).

### 2.4 `CacheBodyStore` — keepalive replay cache
**File:** `packages/proxy/src/cache-body-store.ts:104-112`

```ts
class CacheBodyStore {
    private staging = new Map<...>();
    private lastCachedRequest = new Map<string, CachedRequestEntry>();
}
// cache-body-store.ts:279
export const cacheBodyStore = new CacheBodyStore();
```

The keepalive scheduler (`packages/proxy/src/cache-keepalive-scheduler.ts`) reads
`getLastCachedRequest(accountId)` at tick time and replays the cached request
body to keep Anthropic prompt caches warm. With two replicas, each replica only
keeps alive the bodies it has seen. Replica 1 keeps its accounts warm; replica 2
keeps its accounts warm; neither sees the other's traffic, so half the prompt
caches the operator paid for silently cool down.

### 2.5 `AutoRefreshScheduler` — refresh mutex, failure counters, probe cooldowns
**File:** `packages/proxy/src/auto-refresh-scheduler.ts:32-52`

```ts
export class AutoRefreshScheduler {
    private lastRefreshResetTime: Map<string, number> = new Map();
    private refreshMutex: Promise<void> | null = null;
    private refreshMutexResolver: (() => void) | null = null;
    private consecutiveFailures: Map<string, number> = new Map();
    private lastFailureProbeAt: Map<string, number> = new Map();
    private readonly FAILURE_PROBE_COOLDOWN_MS = 10 * 60 * 1000;
    ...
}
```

One instance per server (`server.ts:autoRefreshScheduler`). With two replicas,
`refreshMutex` is local; an OAuth-refresh race that would have been serialized
on a single instance can fire concurrently across replicas — twice the
upstream refresh rate, twice the chance of a token being rotated while the
other replica is mid-use. `consecutiveFailures` and `lastFailureProbeAt`
(10-minute cooldown) are also per-instance, so the failure-probe cadence
effectively halves from the operator's perspective.

### 2.6 `RateLimitCooldown` — single-flight recovery probe
**File:** `packages/proxy/src/handlers/rate-limit-cooldown.ts:22`

```ts
const probeLeases = new Map<string, number>();
```

Module-level Map of `accountId → leaseUntil` that gates the post-cooldown
recovery probe (one in-flight probe per account, with a 2-minute lease,
`PROBE_LEASE_MS`). With two replicas, *each* runs its own probe; the gate
that exists precisely to prevent "every concurrently selected request piles
onto the next account" (per the doc-comment at `rate-limit-cooldown.ts:54-77`)
runs in parallel on both replicas. The mechanism the maintainers built to
avoid 429 storms is silently halved in a blue/green setup.

### 2.7 `SessionGovernor` — session volume circuit breaker
**File:** `packages/proxy/src/session-governor.ts:35`

```ts
const sessions = new Map<string, SessionWindow>();
```

The module-level comment at lines 22-30 says this *out loud*:

> *State is process-local by design: better-ccflare runs as a single-process
> local proxy. A multi-replica deployment without session-affinity routing
> would multiply the effective budget by the replica count; that setup needs
> shared state (or affinity) and is out of scope here.*

Per-instance budgets (`CCFLARE_SESSION_WARN_REQUESTS_PER_HOUR`,
`CCFLARE_SESSION_MAX_REQUESTS_PER_HOUR`) scale linearly with replica count.
Two replicas → 2× the effective per-session cap.

### 2.8 `ProxyContext.refreshInFlight` — per-account OAuth refresh dedupe
**File:** `apps/server/src/server.ts:917`

```ts
const proxyContext: ProxyContext = {
    ...
    refreshInFlight: new Map(),
    ...
};
```

A `Map<accountId, Promise>` used to dedupe concurrent OAuth token refreshes.
Two replicas → two concurrent refreshes for the same account during a
race window. This is a small one but it interacts with §2.5.

### 2.9 `AsyncDbWriter` — pending write queue
**File:** `packages/database/src/async-writer.ts:39-58`

Per-instance:

```ts
private metadataQueue: MetadataJob[] = [];
private payloadQueue: PayloadJob[] = [];
private payloadBytesPending = 0;
private runningPromise: Promise<void> | null = null;
private intervalId: Timer | null = null;
private healthInterval: Timer | null = null;
```

The drain on dispose is documented (`async-writer.ts:165-198`) — both queues
are processed to empty, and a process-level watchdog in `server.ts` will
`process.exit(0)` after `drainMs + SHUTDOWN_WATCHDOG_MARGIN_MS` (default
60s + 15s = 75s) regardless of what `dispose()` is still awaiting. The 5s
job-warn threshold (`async-writer.ts:151`) is per-instance; a wedged SQLite
write can hold the queue for that long. Cross-replica: if green is drained
mid-flight, any request events green enqueued but did not yet flush are
lost — see §4.

### 2.10 Module-level server singletons (server.ts)
**File:** `apps/server/src/server.ts:240-260`

A pile of module-level mutable state — `serverInstance`, `usagePollingRetryTimeouts`,
`autoRefreshScheduler`, `cacheKeepaliveScheduler`, `memoryMonitorInterval`,
`registeredServerId`, `tlsEnabled`. Each instance carries its own; harmless in
isolation but a reminder that the process owns far more than the database.

### 2.11 Per-instance rate-limit probe accounting + capacity-restored callbacks
**Files:** `usage-fetcher.ts:594`, `usage-fetcher.ts:599`, `usage-fetcher.ts:597`

Already enumerated under §2.3 but worth pulling out: `capacityRestoredCallbacks`
and `windowResetCallbacks` are wired at `server.ts:381-460` to call
`dbOps.resetAccountSession` / `forceResetAccountRateLimit` / `recordUsageSnapshot`.
With two replicas, the same capacity-restored event can fire twice (once per
polling loop), producing duplicate writes.

### Summary table

| # | State | Where | Effect under 2-replica blue/green |
|---|---|---|---|
| 2.1 | `affinity` Map (clientId→accountId) | session-affinity.ts:78 | Lost prompt-cache stickiness for half of each client's requests |
| 2.2 | `lastPickedAt` recency | least-used.ts:69, session-drain-soonest.ts | Burst-spreading even across replicas only by accident |
| 2.3 | `UsageCache` (12 Maps) | usage-fetcher.ts:586 | 2× polling load, duplicate snapshot writes, separate 429 budgets on the usage API |
| 2.4 | `lastCachedRequest` Map | cache-body-store.ts:112 | Half the prompt caches cool down (only one replica sees the body) |
| 2.5 | refresh mutex + failure counters | auto-refresh-scheduler.ts:39-52 | Concurrent refresh races; halved failure-probe cadence |
| 2.6 | `probeLeases` Map | rate-limit-cooldown.ts:22 | Two parallel recovery probes per cooldown expiry (the single-flight gate is per-instance) |
| 2.7 | `SessionGovernor` budget | session-governor.ts:35 | 2× effective per-session rate-limit budget (the maintainers flagged this) |
| 2.8 | `refreshInFlight` Map | server.ts:917 | Two concurrent refreshes per account during race windows |
| 2.9 | `metadataQueue`/`payloadQueue` | async-writer.ts:39-58 | Lost in-flight writes on non-graceful kill (75s watchdog bounds the worst case) |
| 2.10 | Module-level server singletons | server.ts:240-260 | Cosmetic, but a reminder that the process owns far more than the DB |

---

## 3. Session affinity across blue/green

The deployment uses `SessionStrategy` (the default — confirmed from
`apps/server/src/server.ts:64-72` `buildStrategy` falling through to
`SessionStrategy`). `SessionAffinityStrategy` exists as an opt-in but the
caller is currently using the default.

For `SessionStrategy` (active deployment):

The active session is **per-account** (`accounts.session_start`), and
`session_start` is a DB column. Postgres gives both replicas the same view.
The active session is the *most recent* `session_start` across the pool
(`strategies/session-affinity.ts` upstream's `SessionStrategy` peek at
`packages/load-balancer/src/strategies/index.ts` and `strategies/least-used.ts`
in upstream; in the v2 restructure `packages/proxy/src/strategies/index.ts` is
the canonical implementation — `session_start` is read from each account row
and the highest wins).

Consequence: with the active deployment's strategy, the *session* is shared
across replicas. The operator loses nothing about which account the active
session is on. The 5-hour Anthropic prompt-cache window that the session
serves is also shared.

What is NOT shared: nothing in `proxy.ts` decides which replica picks the
account for any given request. Whichever replica Traefik routes the request
to runs `select()`. That is fine when both replicas see identical
`accounts.session_start` data (they do, because Postgres) and the strategy
does not need any per-client state (it doesn't — `SessionStrategy` keys on
account, not client).

**So the default-strategy deployment would actually be safer under blue/green
than the SessionAffinityStrategy deployment.** The headline finding in §0 is
about what would break *if* the operator later flipped the strategy to
`session_affinity` — which is the explicit problem the upstream
`SessionAffinityStrategy` doc-comment was written to address. Operators should
NOT flip the strategy to `session_affinity` until they have sticky-by-`clientSessionId`
routing.

For `SessionAffinityStrategy` (opt-in, NOT currently used at ccmax):

Half the requests for the same client session land on the replica without
the mapping. That replica assigns a fresh least-loaded account. The client
loses prompt-cache locality on the second replica for as long as the
mapping is alive on the first (`affinityTtlMs`, default = Anthropic session
duration = 5 hours). The "every request benefits from cache" claim from
`session-affinity.ts:7-10` does not survive two replicas without sticky routing.

**Implication for cutover:** the cutover must be either (a) sticky-by-
`clientSessionId` at the load balancer, or (b) restricted to the default
strategy (no per-client stickiness to lose). This is the answer to "gradual
vs atomic" — see §6.

---

## 4. The async write path

`AsyncDbWriter` (`packages/database/src/async-writer.ts`) is the buffering
between request events and Postgres. Two queues:

- `metadataQueue: MetadataJob[]` — capacity 2000 (small, fast inserts like
  request rows, alerts, OAuth-session cleanup)
- `payloadQueue: PayloadJob[]` — capacity 1000 jobs / 100 MB bytes (large
  payload blobs)

Drain behaviour:

- `setInterval(processQueue, 100)` runs even without new enqueues
  (constructor, `async-writer.ts:71-75`).
- Per-tick budget: `MAX_JOBS_PER_TICK=50` and `MAX_DRAIN_MS_PER_TICK=250ms`,
  which yields the event loop between ticks so the HTTP listener is not
  starved.
- Round-robin between metadata and payload (`METADATA_PER_PAYLOAD=100`,
  `async-writer.ts:65` + `runTick` at `async-writer.ts:225-265`).
- `dispose()` clears both intervals, then loops `processQueue()` until both
  queues are empty *and* `runningPromise` resolves (`async-writer.ts:355-380`).

The disposability is *not* unbounded. The doc-comment at `async-writer.ts:140-155`
is explicit:

> *The process-level shutdown watchdog in server.ts force-exits 30s after a
> SIGTERM/SIGINT regardless of what dispose() is still waiting on, so a
> wedged SQLite job bounds shutdown lateness to that watchdog rather than
> hanging forever.*

The actual watchdog is `setTimeout(process.exit(0), drainMs + 15_000)` at
`server.ts:1804-1814` (default 60s + 15s = **75s total** before force exit).
Anything green had enqueued but not yet flushed is lost when the watchdog
fires.

For blue/green specifically, the writer is per-instance, so:

- **Green accepts a request, enqueues metadata + payload**, the request
  returns 200 to the client.
- **Traefik shifts blue's weight to 0**, sends SIGTERM to blue. Blue begins
  the drain.
- **Concurrent traffic has stopped** for blue (Traefik already shifted to
  green), so no further enqueues; the 75s watchdog is more than enough to
  drain the back-log that built up during the weight-shift window.
- **Green accepts new traffic**. Its writer is fresh, queues empty, then
  fills up as new requests come in.

The risk window is the **weight-shift phase** (§6 below): during the
gradual cutover, both replicas are taking traffic, and if a replica is
drained mid-weight-shift (e.g., for a config change), its writer may have
a non-empty queue at the SIGTERM. 75s drain budget for metadata + 100MB of
payloads is normally enough but is *not guaranteed* if the payload queue
is at its hard cap (1000 jobs × 4MB/request on Anthropic-tier conversations =
~4GB pending, way over the 100MB byte cap → the cap kicks in, but the
**already-enqueued** jobs still need flushing).

**Clean-drain path exists** — `dispose()` drains both queues — and it is
called from `server.ts:1941` inside `handleGracefulShutdown`. It is sound
when shutdown is allowed to take up to 75s. The Postgres side is the
authoritative store; the in-memory queue is a latency optimisation.

---

## 5. What Postgres already shares (so the cutover is *possible* at all)

The pieces of state that DO survive a per-process restart and ARE already
Postgres-shaped:

- accounts.* (tokens, session_start, session_request_count, rate_limited_until,
  rate_limited_reason, rate_limited_at, consecutive_rate_limits, paused,
  pause_reason, priority, expires_at, model_mappings, custom_endpoint, model_fallbacks)
  → `migrations-pg.ts:50-200`
- strategies.config (strategy enum + session_duration_ms) →
  `migrations.ts:317-321`
- requests + request_payloads → `migrations.ts:115-200`
- alerts → `migrations.ts:185-205`
- oauth_sessions → `migrations.ts:222-235`
- combos + combo_slots + combo_family_assignments → `migrations.ts:283-320`
- api_keys → `migrations.ts:243-258`
- model_translations → `migrations.ts:263-278`
- agent_preferences → `migrations.ts:237-242`
- usage_snapshots (append-only) → `migrations.ts:325-345`

These are what the spec asks about: "accounts, OAuth/token state, session-
affinity mappings, rate-limit cooldowns, usage windows and request history".
The first four and the last are shared. *Session-affinity mappings* (per
clientId) and *rate-limit cooldown state* are NOT shared — see §2.1 and
§2.6.

---

## 6. Cutover mechanics

Recommendation: **atomic switch** via Traefik weight-flip (0/100 → 100/0) with
a pre-flight smoke test, NOT a gradual weight-shift. Reasons below.

### Why gradual weight-shift is unsafe at the current code state

A gradual weight-shift (e.g. 90/10 → 50/50 → 10/90 → 0/100) is the textbook
blue/green cutover and is what the spec asks me to weigh. With ccflare 3.5.44
as deployed, gradual cutover has these failure modes:

1. **`UsageCache` duplicates.** Both replicas run independent polling loops
   for each refresh-backed account (`server.ts:381-460`). At 50/50, two
   polls per `intervalMs` (90s default) → doubled upstream /api/oauth/usage
   load and doubled `recordUsageSnapshot` writes to Postgres
   (`server.ts:451-465`). Gradual weight-shift *exacerbates* this because
   it spends more wall-clock time in the "both active" state than an atomic
   switch does.
2. **`AutoRefreshScheduler` race.** OAuth refresh races during gradual
   cutover: an account's refresh can fire on replica A while a request
   relying on the cached token lands on replica B with a stale token view
   until its next `proxyContext.refreshInFlight` resolves. The mutex at
   `auto-refresh-scheduler.ts:41` is per-instance, so the race exists even
   at 1:1.
3. **`SessionGovernor` budget doubles** during the both-active window
   (`session-governor.ts:35` + comment at `:22-30`). A runaway subagent
   storm that would have been capped at 300/h on a single instance spends
   the weight-shift window with effectively 300×(replica count) budget.
4. **`RateLimitCooldown` `probeLeases` doubles** during the both-active
   window. Each replica can fire its own recovery probe the instant a
   cooldown expires. The mechanism that exists to prevent 429 storms
   (`rate-limit-cooldown.ts:54-77`) silently halves in efficacy.
5. **Async write queues have a "both-write" hazard.** Metadata writes (e.g.
   `updateAccountUsage`) are queued on whichever replica handled the
   request. Postgres serialises them, but during the weight-shift window
   the operator sees an inconsistent ordering in the `requests` table —
   acceptable but noisy for any anomaly-detection / alerting that depends
   on request order.

### What atomic switch loses

An atomic switch (Traefik weight 100/0 → 0/100 in one step) loses:

- **A/B canary.** Green is either fully serving or not.
- **Sticky-session safety.** Clients that were mid-request on blue at the
  flip get terminated and have to retry on green. The proxy already
  supports this — `proxy.ts` retries with backoff via `runtime.retry` —
  but a small request volume will see 502s for the duration of the flip
  (typically <1s).
- **No "if green is broken, blue is still up" safety net.** This is the
  reason blue/green is normally gradual. The way to recover it is the
  rollback in §7.

### Recommended cutover (atomic)

Pre-flight (operator):

1. Confirm `ccmax-staging-pg` is reachable from the green container and the
   schema is at the same migration version. Run
   `packages/database/src/migrations-pg.ts::ensureSchemaPg` against green's
   DB and compare.
2. Confirm Postgres has every active `accounts.id` blue sees (run
   `GET /api/accounts` against blue, and again from a Postgres-side
   `SELECT id, paused, session_start, rate_limited_until FROM accounts` to
   confirm counts match).
3. Start green. Smoke-test against the green-only hostname
   (`https://green.ccmax.zp.digital`, routed to green with no blue weight).
   Verify the dashboard renders, `GET /api/accounts` returns the same list,
   one proxy request goes through (preferably via `curl -X POST
   http://green:8080/v1/messages` with a `bypass-session: true` header to
   avoid polluting the session).
4. While green is healthy in isolation, **watch the Postgres `usage_snapshots`
   table for 30 seconds**. Two replicas polling will write snapshots faster
   than one. This is the cleanest canary for "did I accidentally leave
   both up."

Flip (operator, 1 step):

5. Atomic Traefik weight flip: blue weight 100 → 0, green weight 0 → 100,
   in a single config write.
6. Watch `server.ts:MemoryMonitor` and `usage-collector`'s health
   (`getUsageCollectorHealth` exposed via `/api/usage/health` on the
   dashboard) for ~5 minutes.
7. Drain blue: send SIGTERM. The drain budget is 75s
   (`server.ts:1804-1814`). Confirm blue exits 0 within budget.

### Why atomic wins over gradual at the current code state

Atomics minimises the wall-clock of the "both active" window — the period
during which §6.1 §6.2 §6.3 §6.4 §6.5 all apply. The longer the window,
the more usage-cache duplicate writes happen and the longer the
session-governor doubling is in effect. With ccflare 3.5.44's per-process
state design, "the longer the both-active window, the worse the consistency
hit." Gradual wins only when there is sticky-by-clientSessionId routing at
the load balancer AND a shared UsageCache (Redis) AND a shared
`probeLeases`; we have none of those.

---

## 7. Rollback

**Rollback trigger** (operator decides; concrete signals):

- Green exit non-zero within the 75s drain budget after the flip (§7 §6 step 7).
- `usage_snapshots` insert rate doubles or more relative to the pre-flip
  baseline — a fingerprint of both replicas polling.
- 429 storm signature in `requests` (multiple accounts alternating
  `rate_limited_until`) within the first 5 minutes post-flip.
- `AsyncDbWriter` `getHealth().healthy === false` (queue cap > 80% for 3+
  consecutive health intervals, `async-writer.ts:91-110`).
- `/api/usage/health` reports `payloadBytesPending > 80%` of `PAYLOAD_BYTES_CAP`
  for 2+ minutes (post-cutover green is not draining its async writer).

**Rollback procedure** (atomic, mirroring the cutover):

1. Traefik weight flip back: green 100 → 0, blue 0 → 100, in a single config
   write. Same atomic-shape reasoning as §6.
2. SIGTERM green. 75s drain budget (`server.ts:1804-1814`).
3. Confirm green exited 0; confirm blue's `GET /api/accounts` and
   `GET /api/usage/health` look like the pre-cutover baseline.

**State that is unrecoverable if rollback happens after green has written to
the shared DB** (this is the core answer to the spec's last question):

The async writer is the *only* sink that green shares with blue. Once green
flushes a metadata job (`async-writer.ts:225-265`) it hits Postgres, and
Postgres does not know which instance wrote it. Specific state mutations
green may have committed that survive rollback and cannot be undone by
restoring blue's traffic alone:

| State | Source | Recoverable by stopping green? | Recoverable by revert? |
|---|---|---|---|
| New `requests` rows attributed to green's session_id | `server.ts:request-handler` → `dbOps.recordRequest` (async) | Yes (no more writes after SIGTERM) | No — rows persist in Postgres. Filtering by replica-id would require a future `replica_id` column. |
| Updated `accounts.session_start`, `accounts.session_request_count` | `dbOps.updateAccountUsage` (`database-operations.ts:758`) | Yes | Partial — the active session now reflects green's traffic mix; blue's pinned session may no longer be the "most recent start." |
| Updated `accounts.expires_at`, refreshed `access_token`/`refresh_token` | `dbOps.updateAccountTokens` (`database-operations.ts:752`) | Yes | Yes — these are idempotent and reflect the most recent valid refresh; green's writes are correct. |
| Updated `accounts.rate_limited_until`, `consecutive_rate_limits`, `rate_limited_reason` | `dbOps.markAccountRateLimited` (`database-operations.ts:789`) | Yes | Partial — green's write is authoritative, but if it differs from blue's view (e.g. green saw a 429 blue did not, or vice versa), the operator loses the per-instance accounting. |
| `usage_snapshots` rows from green's polling | `dbOps.recordUsageSnapshot` (`database-operations.ts:848`) | Yes (no more writes after SIGTERM) | No — duplicate snapshots per (account_id, window_key, timestamp) bucket are persistent. Pruning is `pruneUsageSnapshots` on age, not on identity. |
| Updated `accounts.paused`, `pause_reason` from green's auto-unpause logic | `dbOps.resumeAccount` triggered by `strategies/index.ts::SessionStrategy.select()` | Yes | Partial — green's auto-unpause may have unpaused an account blue had paused; blue's traffic then re-pauses it. |

**The pattern:** anything green wrote before SIGTERM is committed to
Postgres and will not auto-revert. Blue, on returning to traffic, will read
whatever state green left behind. For most columns (tokens, expiry) that is
correct. For rate-limit accounting, it depends on which replica saw what
first. The operator cannot reconstruct "what blue would have written" from
Postgres alone — the divergence is lost.

**If the operator wants strict reversibility**, the green image must add a
`replica_id` column to writes (`UPDATE accounts SET ... WHERE id = ? AND
replica_id = green`) and stop touching shared rows on the way out. That is
a code change and out of scope for this design; the cutover plan should
treat Postgres as **eventually consistent under rollback**, not
transactionally revertable.

---

## 8. Recommendation, in order

1. **For the current deployment** (default `SessionStrategy`, single-replica):
   - Cutover can be **atomic** under a shared Postgres.
   - Be aware that the per-process state in §2 is alive in green from boot;
     green will rebuild its `UsageCache`, `cacheBodyStore.lastCachedRequest`,
     `AutoRefreshScheduler.consecutiveFailures`, and `probeLeases` from zero
     when it starts.
   - Prompt caches on blue are NOT kept alive by green — half the
     `lastCachedRequest` Map is gone when blue drains. The 5h Anthropic
     cache window is on the upstream side, so this is a "replay warmup
     spike" not a "permanent loss." Expect 5–30s of slightly-warm-cache
     traffic on green after the flip.
   - The `SessionGovernor` per-session budget *halves* (back to its
     operator-configured value) when green is the only replica — this is a
     **tightening**, not a loosening. Operators running near the limit on
     blue may see trips on green if blue was being lenient.
2. **If the operator later flips the strategy to `SessionAffinityStrategy`**:
   - Add sticky-by-`clientSessionId` at Traefik (or whatever fronts the
     service), keyed on `metadata.user_id` (the upstream identifier
     threaded through `RequestMeta.clientSessionId`,
     `packages/types/src/index.ts` upstream / `packages/types/src/index.ts` v2).
   - Until that is in place, do not go blue/green with that strategy —
     half the prompt-cache benefit is gone.
3. **If the operator wants long-term blue/green at scale** (more than one
   extra replica, or repeated blue/green cycles):
   - Externalise `UsageCache` to Redis (or to a Postgres `usage_cache` table).
   - Externalise `probeLeases` to Redis with a TTL.
   - Externalise `SessionGovernor` budget counters to Redis.
   - Externalise `cacheBodyStore.lastCachedRequest` to Redis or to the DB.
   - Externalise `SessionAffinityStrategy.affinity` to Redis with TTL.
   - Add a `replica_id` column to all writes for clean reversibility (see §7).
   These are code changes; this design only documents them.
4. **Regardless of strategy:** do not assume `dellsrv` has Docker, capacity,
   network reachability to `ccmax-staging-pg`, or an SLA. **Open prerequisites
   the operator must confirm before any cutover**:
   - **dellsrv has Docker installed** and a version compatible with the
     `registry.zp.digital/zen-infra/ccflare:amd64` image. The image is
     linux/amd64 (verified via `docker inspect` from the spec author's
     earlier work) and `ccflare-staging-pg` runs `postgres:17-alpine`; the
     dellsrv host must run the same architecture family or pull will fail.
   - **dellsrv has network reachability to `ccmax-staging-pg`** at
     `postgres://...:5432` from inside the dellsrv container runtime. The
     `ccmax-staging-pg` container is on the `zenstor` host; if dellsrv runs
     on a different host (no registry confirms), the operator needs to
     confirm the route. **Sandbox note:** the agent cannot probe the
     dellsrv→zenstor link from here — the agent's sandbox network
     allowlist includes `*.zp.digital` for HTTPS GET but does not include
     private IP literals or arbitrary ports; confirming the link is a
     manual operator step on the dellsrv host.
   - **dellsrv has capacity** (CPU, RAM, disk) to run a second `ccflare`
     container alongside `zenstor`'s. The current `ccmax` image is
     heavy on RSS (Bun runtime + per-process caches); a back-of-envelope
     estimate is **≥1 GiB RSS sustained per replica**, plus WAL space for
     Postgres WAL shipping if dellsrv also runs Postgres. Verify on
     dellsrv with `docker stats` during a 5-minute load test.
   - **dellsrv's Traefik (or whatever front)** knows about `ccmax.zp.digital`
     *and* has a way to define per-hostname weights. The spec explicitly
     forbids designing around the zeninfra registry, so this design
     assumes a separate routing layer on dellsrv that the operator
     manages.
   - **A monitoring signal exists** for the rollback triggers in §7. If
     there's no Prometheus / log aggregation that fires within 60s on
     "green exits non-zero" or "usage_snapshots rate doubles," the
     operator is rolling blind.
5. **Image identity:** `:amd64` answers *architecture*, not version (per the
   spec). For the duration of the cutover the operator should pin the
   green image to a known tag (recommendation: `:3.5.44-green-<sha>`) so
   the rollback target is unambiguous. This is Task B's concern but the
   blue/green plan assumes it.

---

## 9. What this analysis does NOT cover (out of scope here)

- Bun 1.2.23 → 1.3.14 breaking changes (Task B).
- Building Bun from main for `#35093` (Task B).
- 1.2.23 leak benchmark (Task C).
- Code changes to externalise the §2 per-process state to Redis or to the
  DB. These are documented as a recommendation in §8 §3 but not designed
  in this document.
- Live deploy. The spec forbids it; this document does not propose
  touching any container, registry, or database.
- Designing around the `zeninfra` registry (`mac.zp.digital/registry/`). Per
  the spec, its Portainer env/restart API is disabled and its stacks are
  stopped; this design assumes a different routing layer (likely Traefik
  on `dellsrv`, per the spec's wording "dellsrv... is not in any registry
  we can read").

---

## Appendix A — File:line evidence table

| Claim | Path:line |
|---|---|
| Schema includes accounts, requests, alerts, oauth_sessions, etc. | `packages/database/src/migrations.ts:80-400` |
| Postgres schema is the mirror of the SQLite one | `packages/database/src/migrations-pg.ts:50-200` |
| Default strategy is `SessionStrategy` | `apps/server/src/server.ts:64-72` (buildStrategy fallback) |
| `SessionAffinityStrategy.affinity` Map | `packages/load-balancer/src/strategies/session-affinity.ts:78` |
| `SessionAffinityStrategy.lastPickedAt` Map | `packages/load-balancer/src/strategies/session-affinity.ts:83` |
| `LeastUsedStrategy.lastPickedAt` Map | `packages/load-balancer/src/strategies/least-used.ts:69` |
| `UsageCache` 12 private Maps | `packages/providers/src/usage-fetcher.ts:586-595` |
| `UsageCache` singleton export | `packages/providers/src/usage-fetcher.ts:1200` |
| `cacheBodyStore` singleton with `lastCachedRequest` Map | `packages/proxy/src/cache-body-store.ts:104-279` |
| `AutoRefreshScheduler` private Maps | `packages/proxy/src/auto-refresh-scheduler.ts:32-52` |
| `probeLeases` single-flight Map | `packages/proxy/src/handlers/rate-limit-cooldown.ts:22` |
| `sessions` Map (SessionGovernor) | `packages/proxy/src/session-governor.ts:35` |
| SessionGovernor "process-local by design" comment | `packages/proxy/src/session-governor.ts:22-30` |
| `refreshInFlight` Map | `apps/server/src/server.ts:917` |
| `AsyncDbWriter` queues + intervals | `packages/database/src/async-writer.ts:39-58` |
| Async writer dispose drains both queues | `packages/database/src/async-writer.ts:355-380` |
| Async writer job-warn at 5s | `packages/database/src/async-writer.ts:151` |
| Server-side shutdown watchdog (75s) | `apps/server/src/server.ts:1804-1814` |
| Drain budget default + clamp | `apps/server/src/server.ts:1772-1793` |
| Account token / state write methods | `packages/database/src/database-operations.ts:736-900` |
| `usageCache.clear()` on shutdown | `apps/server/src/server.ts:1939` |
| Per-account usage polling bootstrapped | `apps/server/src/server.ts:381-460` (startUsagePollingWithRefresh) |
| Usage polling restart on graceful shutdown clear | `apps/server/src/server.ts:1941-1943` |
| v2 SessionStrategy uses only accounts.session_start (no per-client Map) | `packages/proxy/src/strategies/index.ts` (origin/main) |

---

## Appendix B — Open prerequisites (operator must confirm)

| Prereq | Why it matters | Verification |
|---|---|---|
| `dellsrv` has Docker + linux/amd64 | Run the green image | `docker --version && uname -m` on dellsrv |
| `dellsrv` → `ccmax-staging-pg` network route | Green must reach shared Postgres | `docker run --rm registry.zp.digital/zen-infra/ccflare:amd64 psql ...` from dellsrv (operator) |
| `dellsrv` CPU/RAM/disk capacity | Second replica won't OOM | `docker run` then `docker stats` for 5 min |
| Traefik (or front) with weight-flip capability | Atomic cutover | config inspection on dellsrv |
| Monitoring signal for rollback triggers | §7 alerts fire within 60s | Prometheus/log pipeline test |
| Green image tag (`:3.5.44-green-<sha>`) | Unambiguous rollback target | spec §Repo setup |
| Postgres schema parity between ccmax-staging-pg and green's first boot | Migrations are idempotent, but version mismatch can break `BunSqlAdapter` | `packages/database/src/migrations-pg.ts::ensureSchemaPg` dry run |

ASSUMPTIONS I'm making (operator correct or BLOCKED):
1. The deployed strategy is the default `SessionStrategy` (no per-client
   affinity Maps to lose on flip). Verified from the `buildStrategy` switch
   defaulting to `SessionStrategy` (`server.ts:64-72`) and from `GET /api/accounts`
   showing `sessionInfo: "Active: N reqs"` per account (the SessionStrategy
   active-session shape). If the operator has since flipped to
   `session_affinity`, see §3 — the analysis tightens.
2. The operator is comfortable with the §7 list of unrecoverable state
   under rollback. This is the *core* assumption; if any row there is
   operationally critical to revert (e.g. you need to undo a token
   refresh), the design needs the `replica_id` column change first.
3. `ccmax-staging-pg` is the only Postgres involved. If a second
   `ccflare-staging-pg` exists on dellsrv, the cross-region / cross-
   instance schema is out of scope here.