# Issue #240 Verification — `SessionAffinityStrategy` and parallel-projects cache thrash

**Verifier:** ao/ccflare-45 (assigned worktree, root branch `ao/ccflare-45/root`).
**Verification branch:** `verify/session-affinity-240` (created from `upstream/main`,
commit `053746c1c0dfe5c8fe5d11be089b7ac750411c15` — "fix: repair broken tests and
eliminate cross-file mock.module pollution").
**Source of truth:** `https://github.com/tombii/better-ccflare` @ `upstream/main`
(remote `upstream`). The repo-local `AGENTS.md` on origin/main describes an internal
v2 layout that does not exist on upstream; we deliberately bypassed that file and
read everything from upstream's tree via `git show upstream/main:<path>`.

**Hard constraint honored:** the default load-balancing strategy was NOT changed.
This is a verification only — no production behavior was modified. The ban-risk
incident #58 tied to strategy changes on production credentials is not touched.

---

## Headline findings

| # | Question | Answer |
|---|----------|--------|
| 1 | Does `SessionAffinityStrategy` resolve the cache-thrash d4rken reported? | **Partially.** It preserves prompt-cache locality per client (sticky mapping) and spreads picks across the pool WHEN (a) starts happen inside the 500 ms recency window, OR (b) utilization telemetry has caught up. In the corner case where many parallel projects start in a tight microsecond loop with no telemetry update yet, the recency penalty saturates the pool and picks fall back to input order — same failure shape as the old strategy, just with N picks (N = pool size) spread across accounts instead of 1. See "Parallel-projects honesty" below. |
| 2 | **CRITICAL: is it the default?** | **NO.** `packages/core/src/strategy.ts` hard-codes `export const DEFAULT_STRATEGY = StrategyName.Session;`. A stock install with no `LB_STRATEGY` env var and no `lb_strategy` file field lands on `SessionStrategy` — the OLD global session behavior that funnels all traffic to one account until it rate-limits. **Issue #240 is still live for every install that has not explicitly opted in via `LB_STRATEGY=session-affinity` or `lb_strategy: "session-affinity"`.** |
| 3 | Does it hold under parallel projects specifically? | **Mixed.** See #1 above and the honesty section. |

The headline finding is the negative answer to question 2: even if #240 were fully
resolved by `SessionAffinityStrategy` (it is only partially resolved — see below),
the default install still hits the OLD strategy. The issue cannot be closed on
upstream/main without a default change, which is explicitly out of scope for this
verification (hard constraint + ban-risk incident #58).

---

## Mechanism — does `SessionAffinityStrategy` solve cache thrash in code?

**File:** `packages/load-balancer/src/strategies/session-affinity.ts`
(verified by `git show upstream/main:packages/load-balancer/src/strategies/session-affinity.ts`).

The strategy maintains a per-process `Map<clientId, { accountId; assignedAt }>`
keyed on the **client session id** — derived from the request body's
`metadata.user_id` (`RequestMeta.clientSessionId`, wired in
`packages/proxy/src/proxy.ts:234` via `requestBodyContext.getClientId()` which
reads `body.metadata.user_id`). The 5 h Anthropic default TTL is reused as
`affinityTtlMs`.

`select(accounts, meta)` algorithm:

1. **GC expired mappings** (older than `affinityTtlMs`).
2. **Sticky hit path** — if `meta.clientSessionId` has a non-expired mapping and
   the mapped account is available: return it FIRST (`[mapped, ...othersByLeastUsed]`),
   refreshing `assignedAt` to keep active sessions alive. The `mapped, ...others`
   shape means subsequent retries / failover chains see the same primary.
3. **Failover path** — if the pinned account is unavailable (rate-limited /
   paused), the mapping is **NOT** deleted. The client temporarily fails over
   to the least-used available account; on the next request after the pinned
   account recovers, the client **snaps back** to the original (mirrors issue
   #115 reasoning — the prompt-cache window outlives the rate-limit window).
4. **New-session path** — `pickAndMark(available, now)` ranks available accounts
   by least-utilized, with a `RECENT_PICK_PENALTY=100` added to any account that
   was picked within the last `RECENT_PICK_WINDOW_MS=500 ms`. The chosen
   account is recorded as the new `clientId → accountId` sticky mapping.

The recency penalty's purpose is documented in-source: "concurrently-starting
sessions spread across the pool instead of all landing on the same lowest-
utilization candidate" (verbatim from the file's header comment).

**Mechanism versus the OLD `SessionStrategy`** (verified by `git show upstream/
main:packages/load-balancer/src/strategies/index.ts`):

| Aspect | `SessionStrategy` (OLD, default) | `SessionAffinityStrategy` (NEW, opt-in) |
|---|---|---|
| Keyed on | Account-level `session_start` (single shared session) | Client-level `metadata.user_id` (one mapping per client) |
| Behavior for new clients | All funnel to the active-session account until it 429s | First request per client → least-loaded account; subsequent → sticky |
| Cache locality | Yes for the active account (within its 5h window) | Yes for each client's pinned account (within affinity TTL) |
| Spread under load | No — sequential exhaustion | Partial — see "honesty" below |
| Reset on rate-limit window | Resets when `rate_limit_reset < now` | **Does NOT** delete the mapping on failover — snaps back later |
| Manual bypass header | `x-better-ccflare-bypass-session: true` | Not honored (not in the file) |

So the per-client sticky mapping IS a real mechanism that does the right thing
when its preconditions hold.

---

## CRITICAL: is `SessionAffinityStrategy` the default?

**No. It is not.**

Evidence, traced through the code (not assumed):

1. `packages/core/src/strategy.ts:13` — the canonical default:
   ```typescript
   // Default load balancing strategy
   export const DEFAULT_STRATEGY = StrategyName.Session;
   ```

2. `packages/types/src/strategy.ts` — the `StrategyName` enum:
   ```typescript
   export enum StrategyName {
       Session = "session",
       LeastUsed = "least-used",
       SessionAffinity = "session-affinity",
       SessionDrainSoonest = "session-drain-soonest",
   }
   ```
   `SessionAffinity` is a valid value, but `DEFAULT_STRATEGY` resolves to
   `StrategyName.Session` ("session"), NOT `StrategyName.SessionAffinity`
   ("session-affinity").

3. `packages/config/src/index.ts:208-228` — `loadConfig()` eagerly seeds a fresh
   config file with `{ lb_strategy: DEFAULT_STRATEGY }`, so a brand-new install
   writes `"session"` to disk.
4. `packages/config/src/index.ts:542-555` — `resolveStrategy()` precedence:
   valid `LB_STRATEGY` env > valid `lb_strategy` file field > `DEFAULT_STRATEGY`.
   No env or file setting means `"session"` is returned with `source: "default"`.
5. `packages/config/src/strategy-source.test.ts` — this test file (verbatim) makes
   the contract explicit: a freshly created config and a config from a pre-`lb_strategy`
   raw file both report `getStrategy() === StrategyName.Session`. It only switches
   to `SessionAffinity` (or any other) via an env var or an explicit file write.
6. `apps/server/src/server.ts:81-92` — the strategy factory `buildStrategy()`
   dispatches:
   ```typescript
   switch (name) {
       case StrategyName.LeastUsed: return new LeastUsedStrategy();
       case StrategyName.SessionAffinity: return new SessionAffinityStrategy(...);
       case StrategyName.SessionDrainSoonest: return new SessionDrainSoonestStrategy(...);
       default: return new SessionStrategy(...);   // ← Session falls through here
   }
   ```
   `SessionAffinity` is reachable; `Session` falls through to the default branch.

**Conclusion:** a stock install gets `SessionStrategy`. The new
`SessionAffinityStrategy` is opt-in (env var or config-file write). Issue #240
remains live for every install that has not opted in.

---

## Parallel-projects honesty — does it hold under the reported scenario?

The d4rken #240 report describes multiple concurrent Claude Code sessions
(each with its own `metadata.user_id`) all starting against a small account
pool, with the prompt-cache hit-rate collapsing because adjacent turns of each
agentic loop land on different upstreams.

`SessionAffinityStrategy` addresses this in three concrete ways:

1. **Per-client sticky mapping.** Two different `metadata.user_id` values get
   two different `clientId → accountId` mappings, so they are not contending
   for the same account-level session slot (the OLD failure mode).
2. **Recency penalty at new-session selection.** Concurrent starts (within
   `RECENT_PICK_WINDOW_MS=500 ms` of each other) are steered off the
   just-picked account by a +100 score penalty.
3. **Failover without mapping deletion.** When the pinned account 429s, the
   client fails over to a least-loaded account but the mapping is preserved;
   when the pinned account recovers, the client snaps back. This keeps
   cache locality across the rate-limit window.

The partial-mitigation caveat (this is why I called it "PARTIALLY" up top):

- The recency penalty only helps for **the next pick** after an account was
  picked. In a tight microsecond loop with no utilization telemetry update,
  the first M picks (M = pool size) each land on a different account via
  the recency penalty, but the (M+1)th pick and onward have ALL accounts
  penalized at score = 0 + 100 = 100, so the sort falls back to input order
  and re-picks the first account. With 3 accounts and 30+ concurrent picks,
  roughly 28 / 30 land on the first account in input order — same shape as
  the OLD strategy's collapse, just delayed by M picks.
- Without utilization telemetry being CURRENT (real-world Anthropic
  telemetry has a polling lag), each new client after the first M picks
  also collapses to input order — confirmed by an empirical test below
  (10 concurrent picks across 600 ms gaps with no telemetry updates: all
  10 land on `x`).
- With utilization telemetry current, picks spread evenly across the pool
  (verified empirically below: 30 picks with `+10 util` per pick distribute
  ~10 / 10 / 10 across `x` / `y` / `z`).

So the strategy **mostly** mitigates #240 in steady-state (when telemetry is
live), but does not eliminate the corner case where many parallel projects
start in a microsecond-tight burst before telemetry catches up. The OLD
strategy is strictly worse (every pick collapses to the active-session account
forever), but `SessionAffinityStrategy` is not a full fix — it's a mitigation.

**Net assessment for closing #240:** even with `SessionAffinityStrategy` set
as the default, the issue's literal symptom (cache hits collapsing under
parallel-projects load) would still appear in the tight-burst-no-telemetry
window. Closing #240 likely requires EITHER `SessionAffinityStrategy` as the
default AND a telemetry-tightening change (e.g., synchronous utilization
update on session selection) OR a stronger recency mechanism (e.g., a
round-robin counter instead of a per-account lastPick map).

---

## Harness (negative-control + positive + default assertion)

`verification/session-affinity-240-harness.test.ts` is a Bun test file
containing:

- **Inlined SessionStrategy** — verbatim copy of the `SessionStrategy` class
  from `packages/load-balancer/src/strategies/index.ts` (the OLD default).
- **Inlined SessionAffinityStrategy** — verbatim copy of
  `packages/load-balancer/src/strategies/session-affinity.ts`.
- **Inlined Config precedence** — direct simulation of
  `Config.resolveStrategy()` (env > file > default).
- **Three test groups:**
  1. **Negative control — SessionStrategy on parallel clients.** Asserts
     the OLD strategy funnels 100% of concurrent client traffic onto the
     active-session account, and rotates 100% to the next account when
     the active one 429s. If this test PASSES under both old and new
     strategies, the harness proves nothing — but the assertions are
     specifically on the OLD strategy's behavior.
  2. **Positive — SessionAffinityStrategy on parallel projects.**
     Asserts spread when utilization telemetry is current, sticky
     locality for follow-up requests, failover-with-snap-back, and
     a 10-project scenario that mirrors d4rken's report.
     **Also includes an honest caveat test** that documents the
     tight-loop-no-telemetry corner case where the strategy still
     collapses.
  3. **Default-strategy assertion.** Asserts `DEFAULT_STRATEGY ===
     StrategyName.Session` and that `Config.resolveStrategy()` returns
     `Session` for stock install (no env, no file field).

**Negative-control transitions (verbatim):**

```
SessionStrategy.select([x, y, z], metaFor("client-0")) → [x, ...]
  → 50 concurrent selects with distinct clientSessionIds → all 50 → x
  → flip x to rate_limited_until = now + 60_000
  → 100 concurrent selects with distinct clientSessionIds → all 100 → y
```

This is the failure mode d4rken reported. The harness demonstrates it
concretely.

**Positive transitions (verbatim):**

```
SessionAffinityStrategy.select([x, y, z], metaFor("client-A")) → [x, ...]
  (records mapping {client-A → x})
SessionAffinityStrategy.select([x, y, z], metaFor("client-B")) → [y, ...]
  (records mapping {client-B → y}; recency penalty pushed off x)
SessionAffinityStrategy.select([x, y, z], metaFor("client-C")) → [z, ...]
  (records mapping {client-C → z}; recency penalty pushed off y)
SessionAffinityStrategy.select([x, y, z], metaFor("client-A")) → [x, ...]
  (sticky hit — same client, same account)
```

The mapping state for `client-A → x` survives a 60 s rate-limit on `x`:
the next `select` for `client-A` returns `[y, ...]` (failover) and the
mapping is preserved; when `x` recovers, `client-A` snaps back to `x`.

**Empirical harness results (verbatim from `bun test`):**

```
10 pass
0 fail
1720 expect() calls
Ran 10 tests across 1 file. [41.00ms]
```

Negative-control and default-strategy assertions all PASS — the strategy
collapse to one account under `SessionStrategy` is reproducible, and the
default value of `StrategyName.Session` is reproducible.

The positive-behavior assertions PASS under the realistic-with-telemetry
case and the failover-with-snap-back case. The honesty caveat test
(tight-loop-no-telemetry) PASSES by documenting that the strategy still
collapses to ~96% on `x` in that corner case — confirming the partial
mitigation verdict above.

A separate diagnostic file `verification/debug-spread.test.ts` records
the raw distribution traces:

```
FIRST 12 picks sequence:        x, y, z, x, x, x, x, x, x, x, x, x
50 pick counts (tight loop):    [["x",48],["y",1],["z",1]]
50 pick counts (util=0):        [["x",48],["y",1],["z",1]]
10 picks (600ms gaps, no tel):  x, x, x, x, x, x, x, x, x, x
10 picks w/ util telemetry:     x, y, z, x, y, z, x, y, z, x
```

The 600 ms gap row is the d4rken scenario without telemetry. Every new
client lands on `x`. That is the failure mode that is NOT fully resolved
by `SessionAffinityStrategy` alone.

---

## How to reproduce the harness

The harness is checked into this branch under `verification/`. Run it with:

```bash
bun test verification/session-affinity-240-harness.test.ts
```

Expected output: 10 pass, 0 fail. Run the diagnostic for the distribution
traces:

```bash
bun test verification/debug-spread.test.ts
```

Expected output: 4–5 pass, 0 fail (depending on the timeout-bumped test).

---

## Caveats and known limitations

1. **Sandbox-restricted checkout.** The literal command in the task
   (`git checkout -b verify/session-affinity-240 upstream/main`) failed
   with `fatal: cannot create directory at '.claude/agents': Operation
   not permitted` because the worktree's sandbox denies writes to
   `.claude/agents` (which exists on `upstream/main` but is not present
   in the divergent fork). Worked around by `GIT_FLOCK=0 git branch
   verify/session-affinity-240 upstream/main` (creates the branch ref
   without updating the work tree, which is the read-only operation
   the task actually needs), then reading all source files via
   `git show upstream/main:<path>`. The harness inlines the relevant
   strategy code verbatim so it does not depend on a clean working tree.
   No part of `upstream/main`'s source was modified.
2. **Ban-risk incident #58 — not touched.** The default
   load-balancing strategy was NOT changed. This verification only
   reports on existing behavior.
3. **Harness uses inlined copies.** The `verification/session-affinity-
   240-harness.test.ts` file inlines the relevant strategy source. If
   upstream's `session-affinity.ts` changes, the harness should be
   re-validated. (The upstream commit hash is recorded at the top of
   this report.)
4. **No telemetry source.** The harness uses a `MockStore` for
   utilization; in production, `getAccountUtilization` is provided by
   the proxy runtime and reflects asynchronous usage polling. The
   harness's positive test models "telemetry is current after each
   pick" — the d4rken scenario's tight-burst-no-telemetry corner case
   is documented separately as the honest caveat.
5. **No push, no PR, no issue comment.** Per task constraints. The
   branch is committed locally only.

---

## Recommended next steps (out of scope for this verification)

1. **Decide whether to flip the default to `SessionAffinityStrategy`.**
   This is the headline finding — without it, #240 remains live on
   stock installs. Operators reviewing this should weigh the
   partial-mitigation (cache hits still collapse in the
   tight-burst-no-telemetry corner case) against the existing failure
   mode (every install currently collapses immediately).
2. **Strengthen the recency mechanism if #240 needs to be closed.**
   A round-robin counter on top of the per-account lastPick map, or
   a "concurrent burst detector" that spreads picks across all
   accounts on the first pick of each new `metadata.user_id` value
   seen within a short window, would close the corner case.
3. **Synchronize utilization telemetry with session selection.** If
   each `select()` synchronously increments a per-account counter
   that influences the next `select()`'s least-used scoring, the
   tight-burst scenario spreads naturally without needing the
   recency window.
4. **Coordinate with ban-risk incident #58.** Any default-strategy
   change must clear that gate before landing.

---

## Verification metadata

- **Branch:** `verify/session-affinity-240`
- **Base:** `upstream/main` @ `053746c1c0dfe5c8fe5d11be089b7ac750411c15`
- **Files added:**
  - `verification/session-affinity-240-harness.test.ts` — main harness
  - `verification/debug-spread.test.ts` — distribution diagnostic
  - `SESSION-AFFINITY-240-VERIFICATION.md` — this report
- **Files NOT modified:** zero source files in the upstream tree were
  modified. The harness inlines copies of the strategies for self-contained
  execution.
- **No push, no PR, no issue comment, no remote calls.** Per task constraints.

---

## Addendum (from ccflare-20 additional input)

Two follow-up questions from the orchestrator were folded into this
verification: (1) whether schema drift on `rateLimitStatus` /
`sessionInfo` affects the session-affinity decision path; (2) the
exact availability of `SessionAffinityStrategy` across the three
branches that any live deployment could be running.

### A. Three-branch availability matrix (the "is it the default?" question, refined)

The original question "is `SessionAffinityStrategy` the default?" has
three distinct answers depending on which branch a deployment is
running. Verified by `git cat-file -p` on each ref:

| Branch / ref | `StrategyName` enum | `DEFAULT_STRATEGY` | `SessionAffinityStrategy` reachable? |
|---|---|---|---|
| `upstream/main` @ `053746c1` | `{ Session, LeastUsed, SessionAffinity, SessionDrainSoonest }` | `Session` | **Yes — but not default.** Must opt in via `LB_STRATEGY=session-affinity` env or `lb_strategy: "session-affinity"` config. |
| `origin/main` @ `9c44de10` | `{ Session }` | `Session` | **No — absent entirely.** Only `SessionStrategy` is compiled in. `apps/server/src/server.ts` `buildStrategy()` switch has no `case StrategyName.SessionAffinity`. |
| `origin/zenprocess-deploy` @ `b2c8688e` | `{ Session, LeastUsed }` | `Session` | **No — absent entirely.** Verified by `git cat-file -p origin/zenprocess-deploy:packages/types/src/strategy.ts` which shows `enum StrategyName { Session = "session", LeastUsed = "least-used" }` with no affinity or drain-soonest entries. |

So the three categories the orchestrator asked for:

- **(a) upstream default** — `SessionAffinityStrategy` is NOT the default
  even on `upstream/main`. `DEFAULT_STRATEGY = StrategyName.Session` in
  `packages/core/src/strategy.ts:13`. A stock install on upstream/main
  still uses the OLD `SessionStrategy`.
- **(b) present-but-not-default** — applies to `upstream/main` only.
  `SessionAffinityStrategy` exists in the enum and is wired in
  `apps/server/src/server.ts:87`, but requires opt-in.
- **(c) absent entirely** — applies to `origin/main` and
  `origin/zenprocess-deploy`. Neither build can run `SessionAffinityStrategy`
  — the enum doesn't even name it. Any deployment running either of these
  branches is stuck on `SessionStrategy` regardless of config.

This refines the headline finding: #240 is live on every stock install
in all three branches. It is **doubly** live on `origin/main` and
`origin/zenprocess-deploy` because the fix doesn't even compile into
those builds.

### B. Schema drift — does it affect session-affinity decisions?

The orchestrator's concern: live ccmax returns `rateLimitStatus` and
`sessionInfo` as **strings**; the current fork (`origin/main`) types
them as **objects** (`AccountRateLimitInfo`, `AccountSessionInfo`).
If the affinity code path reads either field, a string-vs-object
mismatch could silently break affinity at runtime even when unit
tests pass against the typed shape.

**Verdict: schema drift does NOT affect session-affinity decisions.**

Evidence (verified by `git grep`):

1. `SessionAffinityStrategy.select()` reads only these fields on `Account`:
   - `account.id`, `account.name`, `account.provider`,
     `account.priority`, `account.paused`, `account.rate_limited_until`,
     `account.requires_reauth`, `account.pause_reason`,
     `account.rate_limit_reset`.
   - Plus `store.getAccountUtilization(accountId, provider): number | null`
     via the `StrategyStore` interface.
   - Source: `git show upstream/main:packages/load-balancer/src/strategies/session-affinity.ts`
     — no `rateLimitStatus`, `sessionInfo`, `AccountRateLimitInfo`, or
     `AccountSessionInfo` references anywhere in the file.
2. The companion helper `peek-availability.ts` reads: `account.paused`,
   `account.auto_fallback_enabled`, `account.provider`,
   `account.rate_limit_reset`, `account.pause_reason`,
   `account.rate_limited_until`. No `rateLimitStatus` / `sessionInfo`.
3. The object-typed accessors `getAccountRateLimitInfo()` and
   `getAccountSessionInfo()` exist ONLY in `origin/main` (introduced by
   the v2 refactor) and are referenced ONLY from:
   - `packages/api/src/serializers/account.ts` (API response serializer)
   - `packages/ui/src/account-display.ts` (UI presenter)
   - `packages/types/src/account.test.ts` (unit tests)
   - `git grep` on `packages/proxy/src/`, `packages/load-balancer/src/`,
     and `packages/core/src/` returns **zero** references. The
     strategies never call these accessors.
4. `upstream/main` does not contain `getAccountRateLimitInfo` or
   `getAccountSessionInfo` at all (these are origin/main-only
   additions). `git grep "getAccountRateLimitInfo\|getAccountSessionInfo"
   upstream/main` returns no results. So even the schema drift
   premise doesn't apply to upstream's code — the upstream types
   are derived from primitives (`rate_limited_until`, `session_start`,
   `session_request_count`) at the API/UI boundary and composed into
   strings there.

What the drift WOULD affect (out of scope here):

- The `/api/accounts` response payload, where the fork types
  `rateLimitStatus: AccountRateLimitInfo` (object with `code`,
  `isLimited`, `until`, `resetAt`, `remaining`) but live ccmax
  returns a string (e.g., `"allowed_warning (5m)"`). A client of
  the API expecting an object and calling `.code` on the string
  would get `undefined`. This is a display/serialization concern,
  not an affinity decision concern.

**Conclusion on the headline question:** the orchestrator's "this
would be a headline finding" worry does not materialize. The schema
drift exists at the API output layer, but it does not reach the
session-affinity decision code path. SessionAffinityStrategy (when
present in the build) operates on primitives and a `number | null`
store interface; it does not touch the drifted fields.

### C. Combined net answer (incorporating both addenda)

- **Upstream/main builds**: #240 is live by default, mitigable by
  opt-in to `SessionAffinityStrategy`. Schema drift does not apply
  (upstream doesn't have the object-typed accessors).
- **Origin/main builds**: #240 is live by default AND
  `SessionAffinityStrategy` is absent from the compiled code. No
  config change can resolve #240. Schema drift exists at the API
  layer but doesn't reach the (single) strategy's decisions.
- **Origin/zenprocess-deploy builds**: same as origin/main —
  `SessionAffinityStrategy` absent, schema drift at API layer only.

For all three branches, the cache-thrash mitigation in upstream's
`SessionAffinityStrategy` is not available without first back-porting
the strategy into the fork. The orchestrator's branch-fact is
correct: deployment branches without `SessionAffinityStrategy`
compiled in cannot opt into it.