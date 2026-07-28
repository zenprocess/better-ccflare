# NATIVE-FALLBACK-ANALYSIS

**Task B** of three parallel ccmax config-finding analyses.
Branch: `analysis/native-fallback` (built from `upstream/main`).
Scope: assess enabling per-account `autoFallbackEnabled` and `modelFallbacks`,
mindful of the `model_fallback_429` reason and the `modelMappings` interaction,
and the circuit-breaker work being wired in parallel.

> **Constraint**: ANALYSIS ONLY. No production code, no config changes, no push,
> no PR. Sandbox egress to ccmax.zp.digital was deliberately denied; this is the
> code-side half only. Every numeric below is an estimate unless flagged otherwise.

---

## 0. Quick orientation — what the spec's terms actually map to in code

The operator-visible names in the spec do not correspond 1:1 with single
upstream fields. Three distinct concepts are conflated under "native fallback":

| Operator term | DB column / wire name | Code symbol | Real effect at runtime |
|---|---|---|---|
| `autoFallbackEnabled` | `accounts.auto_fallback_enabled` | `account.auto_fallback_enabled` | **Auto-unpause**: lets a paused account self-recover when its `rate_limit_reset` window has elapsed. **Not a per-request model fallback.** |
| `modelFallbacks` | `accounts.model_fallbacks` (JSON string) | `account.model_fallbacks` → `parseModelFallbacks` | Legacy per-family fallback map (`fable→...`, `opus→...`, …). Merged into the `model_mappings` arrays at runtime and marked **deprecated as a separate concept** in `model-mappings.ts:140-148`. |
| `modelMappings` | `accounts.model_mappings` (JSON string) | `account.model_mappings` → `getModelMappings` | **Modern** per-account model mapping. Values may be a string or `string[]` — the array form is the cycling chain used by the proxy on 429. |

So "enable native fallback" actually has two separable questions:
1. Should paused accounts self-recover? (`auto_fallback_enabled = 1`)
2. Should the proxy cycle through a model list on a 429 before benching the account? (`model_mappings` arrays / legacy `model_fallbacks`)

The two operate on different code paths and have different risk profiles.

---

## 1. What `autoFallbackEnabled` / `modelFallbacks` actually do at runtime

### 1.1 `auto_fallback_enabled` — auto-unpause

**Code path** (file:line, all from `upstream/main`):
- `packages/load-balancer/src/strategies/peek-availability.ts:21` — `wouldAutoUnpause` short-circuits to `false` when `!account.auto_fallback_enabled`.
- `packages/load-balancer/src/strategies/peek-availability.ts:23-37` — also requires `provider` ∈ `{ANTHROPIC, CODEX, ZAI}`, `rate_limit_reset < now - 1s`, and `pause_reason` ∈ `{null, "overage", "rate_limit_window"}`.
- `packages/load-balancer/src/strategies/index.ts:359-388` (`checkForAutoFallbackAccounts`) — the matching unpause emitter that mutates the account back to "active" when these conditions hold.
- `packages/load-balancer/src/strategies/least-used.ts:134` — same gate in `autoUnpauseElapsedAccounts`.
- `packages/load-balancer/src/strategies/session-affinity.ts:185`, `session-drain-soonest.ts:342` — same shape in those strategies.

**What it does NOT do**: it does **not** retry requests with a different model on 429, it does **not** decide which model to send upstream, it does **not** change the proxy's behaviour toward healthy accounts. It is a recovery toggle for **already-paused** accounts whose upstream window has reset.

**Failure mode if enabled naively**: very low. The flag is conservative — it only fires when the upstream itself has signalled a reset (`rate_limit_reset` already passed). The keepalive/synthetic-probe tests in `__tests__/peek-availability.test.ts` and `__tests__/least-used-strategy.test.ts` confirm it gates correctly.

### 1.2 `model_fallbacks` (legacy) and `model_mappings` arrays — the actual cycling

**Code path**:
- `packages/core/src/model-mappings.ts:171-187` (`getModelMappings`) — merges `model_mappings`, legacy `custom_endpoint` mappings, env-var override, and `model_fallbacks`. Crucially, `model_fallbacks` entries are **appended to the array** for any family key that already has a `model_mappings` entry (lines 178-184). They are never used standalone for a 429 cycling path on a `model_mappings` entry that already exists.
- `packages/core/src/model-mappings.ts:248-258` (`mapModelName`) — returns the **first** element of the resolved list. The rest are not consulted on this code path; they only matter when the response from `index 0` fails and the proxy enters its cycling loop (see §3).
- `packages/core/src/model-mappings.ts:280-290` (`getModelList`) — same merge, used by the proxy failover path.
- `packages/proxy/src/handlers/proxy-operations.ts:935` — the runtime caller: `const modelList = getModelList(requestedModel, account);`.

**What `model_fallbacks` and the array form of `model_mappings` actually do**: they populate the **per-account cycling list** the proxy walks through on a model-scoped 429 (see §3). It is not "switch back to a healthy account on 429" — the load balancer does that today. It is "before failing over, try alternative models on the same account". That is the cost-saving mechanism; it is also the silent-substitution risk.

---

## 2. How they interact with `modelMappings` and the `model_fallback_429` reason

### 2.1 The reason taxonomy (`packages/types/src/account.ts:3-23`)

```
RateLimitReason =
  | "upstream_429_with_reset"
  | "upstream_429_no_reset_default_5h"        // deprecated
  | "upstream_429_no_reset_probe_cooldown"   // v3.5.2+
  | "model_fallback_429"                     // ★ THIS ANALYSIS
  | "all_models_exhausted_429"               // ★
  | "upstream_529_overloaded_with_reset"
  | "upstream_529_overloaded_no_reset"
  | "out_of_credits"                          // (added upstream after zenprocess-deploy)
  | "extra_usage_exhausted"                   // (added upstream after zenprocess-deploy)
```

### 2.2 What triggers `model_fallback_429` (the audit reason the spec worries about)

`packages/proxy/src/handlers/proxy-operations.ts:934-947` is the **only** place this reason is emitted in the proxy:

```ts
const modelList = getModelList(requestedModel, account);
if (!modelList || modelList.length <= 1) {
  if (rawResponse.status === 429) {
    ...
    const reason: RateLimitReason = "model_fallback_429";
    applyRateLimitCooldown(account, { resetTime: cooldownUntil, reason }, ctx);
    ...
    return null;
  }
  ...
}
```

The condition for emitting `model_fallback_429` is therefore:

> The account has **no model mapping list of length > 1** for the requested model (or family), AND the upstream returned a 429.

When `autoFallbackEnabled = false` and `modelFallbacks` is empty (ccmax's
current state), this branch is **the default** for every primary-model 429.
Every such 429 benches the entire account via `applyRateLimitCooldown` —
`account.consecutive_rate_limits` is incremented, `rate_limited_until` is
stamped, and `isAccountAvailable()` (`packages/core/src/strategy.ts:46-56`)
excludes the account from selection until cooldown expires.

### 2.3 What `all_models_exhausted_429` means (the other 429 reason)

`packages/proxy/src/handlers/proxy-operations.ts:1109-1130`: emitted when a
model mapping list of length > 1 was tried (the proxy cycled through every
fallback at indices 1..N) and **every** model still returned 429. Then the
whole account is benched.

`out_of_credits` (`proxy-operations.ts:870-915`, added for issue #261):
emitted when the 429 carries `overage-disabled-reason: out_of_credits`.
This is **model/beta-scoped**, not account-wide — the account is **not**
benched; the request fails over per-request only. This nuance does not exist
in `origin/zenprocess-deploy` (see §5).

### 2.4 So is native fallback a replacement, a duplicate, or complementary?

**Complementary**, with an important caveat:

- **vs. the external fleet divert (minimax→sonnet)**: the divert is a **fleet-layer** policy that moves traffic between `provider`-classes at request ingress. ccflare's native fallback is a **per-account** cycling within a single provider-class on a per-request 429. They operate on different axes (cross-provider vs within-account). Enabling both is **complementary** in principle, but they can interact confusingly:
  - If the fleet diverts a request before ccflare's load balancer picks an account, the request never enters the cycling loop. The native fallback is a no-op for diverted requests.
  - If the fleet diverts **after** ccflare's 429, ccflare has already benched the account for cooldown. The fleet's divert becomes responsible for back-off, and ccflare's audit log will show a `model_fallback_429` that the fleet considers "its job" to handle. **Two layers fighting over the same signal.**
- **vs. `modelMappings` (the modern array form)**: `model_fallbacks` is the legacy single-string form. They are **merged** at runtime (`model-mappings.ts:171-187`); configuring both is not "do two things", it is "one thing, with two sources". The array form in `model_mappings` is the recommended path (`model-mappings.ts:140-148` documents this deprecation).

**Bottom line**: enabling `model_fallbacks` on accounts that already have `model_mappings` arrays is redundant. Enabling `model_mappings` arrays on accounts with no fallback config **changes behavior** — it changes `getModelList.length > 1`, it changes the path the proxy takes on 429, and it eliminates the `model_fallback_429` audit reason for that account (in favor of `all_models_exhausted_429` only if every fallback also 429s).

---

## 3. Walking the model-scoped 429 with native fallback ON vs OFF

### 3.1 Pre-state

- Request arrives for `claude-sonnet-4-5`.
- Account `A` is selected (or any account in the pool).
- Account `A` has: `auto_fallback_enabled = 0`, `model_fallbacks = null`, `model_mappings = null`.

### 3.2 OFF path (ccmax today)

`packages/proxy/src/handlers/proxy-operations.ts`:
- 935: `getModelList` → `null` (no mappings).
- 945: `rawResponse.status === 429` → enter the `model_fallback_429` branch.
- 962-965: `applyRateLimitCooldown(account, { reason: "model_fallback_429" }, ctx)` → bench the entire account.
- 967-988: enqueue `saveRequest(..., reason: "model_fallback_429", ...)`.
- 989: `return null` → strategy fails over to next account, request retried there.
- **Audit** shows `model_fallback_429` for account `A` (and likely the failover hits the same 429 if the same family is capped across the pool).

### 3.3 ON path with `modelMappings = { "sonnet": ["claude-sonnet-4-5", "claude-sonnet-3-7"] }` (hypothetical)

- 935: `getModelList("claude-sonnet-4-5", accountA)` → `["claude-sonnet-4-5", "claude-sonnet-3-7"]`, length 2.
- 946: `length > 1`, so the 429 branch is skipped.
- 1006-1042: enter the cycling loop. Index 0 (`-4-5`) already failed → try index 1 (`-3-7`).
- The request body is patched (`proxy-operations.ts:1024-1042`): `transformRequestBody` is called, then the model name is re-patched into the body because the provider conversion can remap non-Claude names back to the primary (this is a real subtlety — see `proxy-operations.ts:1043-1057`).
- If `-3-7` succeeds → return that response to the client. **No 429 in the audit log** for this account. Client received `claude-sonnet-3-7` despite asking for `claude-sonnet-4-5`. **Silent model substitution.**
- If `-3-7` also 429s → fall through to `all_models_exhausted_429` branch (`proxy-operations.ts:1108-1130`), bench the account, fail over.

### 3.4 Side-by-side summary

| Step | OFF (today) | ON with array mapping |
|---|---|---|
| Primary 429 | Bench account (`model_fallback_429`) | Try fallback model |
| Fallback 429 | n/a (no fallback configured) | Bench account (`all_models_exhausted_429`) |
| `model_fallback_429` audit volume | HIGH (every primary 429) | LOW (only when no mapping exists) |
| `all_models_exhausted_429` audit volume | 0 | LOW–MED (cycling exhaustion) |
| Silent substitution risk | NONE (proxy returns 429 to client via failover) | **HIGH** if fallback model ≠ requested model |
| Cost shape | Same number of upstream 429s, but spread across more accounts | Same upstream 429s on `-4-5`, fewer on `-3-7` per-account audit; cost shift toward `-3-7` (pricing depends on the model chosen) |

---

## 4. Failure modes of enabling it

### 4.1 Silent model substitution — **correctness**, not just cost

The cycling loop in `proxy-operations.ts:1024-1057` rewrites the upstream
request body and headers to substitute the fallback model. The response is
returned to the client **with the same status, headers, and content-type as
a normal proxy response**. The client has no signal that it received a
different model than the one it asked for.

This matters because:
- **Capability drift**: `claude-sonnet-4-5` and `claude-sonnet-3-7` have different context windows, different tool-use behaviours, different training cutoffs. A client that picked `-4-5` for a reason (cost budgeting, capability assertion, deterministic eval) gets `-3-7` silently. The client's invariants are violated without it knowing.
- **Cache invalidation**: Anthropic's prompt cache keys include the model. A request that hits cache at `-4-5` will miss at `-3-7` and pay full input cost. The cost saving from "stay on the same account" is partially offset by "lose cache hits". **Net cost direction is non-obvious** and depends on request shape.
- **Test reproducibility**: any integration test or eval that compares outputs across model substitutions now silently differs.

The operator should treat this as **the headline correctness risk**, not just a cost line item. It is the same class of issue as the spec warned about.

### 4.2 Masking a genuinely exhausted account

If the fleet has an external minimax→sonnet divert, and an account is
genuinely exhausted (weekly window at 100%, ~40h to reset — the exact pattern
the PR #345 commit message cites, `874a30ea`):

- With native fallback OFF today: account is benched via `model_fallback_429`,
  subsequent requests fail over, audit clearly shows the account is the 429
  culprit.
- With native fallback ON: account tries fallback models, all 429, account is
  benched via `all_models_exhausted_429`. **Same outcome, different audit
  reason.** Net: the masking concern is overstated — the audit reason
  changes but the bench still happens.

**However**: PR #345 (`874a30ea` + `6abbe3c0`, July 27 2026) addresses this
class of issue at the selection layer, not the cycling layer:
`packages/proxy/src/handlers/account-selector.ts:215-231` drops
usage-capped accounts **before** strategies see them. So today, on upstream/main,
a weekly-capped account is removed from selection and never reaches the cycling
loop at all. The `model_fallback_429 → cycling until exhausted` pattern from
the production incident (227× `model_fallback_429`, 27× 503
`pool_exhausted`, 10× `all_models_exhausted_429`) is **already mitigated** in
upstream/main. The risk of cycling-masking-exhaustion only exists on the older
zenprocess-deploy branch that pre-dates PR #345 (see §5).

### 4.3 Interaction with the circuit breaker (the spec's explicit concern)

The spec calls out "a circuit breaker is being wired in parallel that must
NOT trip on `model_fallback_429`". Looking at the code:

- `packages/proxy/src/proxy.ts:238` — the **session volume circuit breaker**
  is a per-client-session request-count governor, not a rate-limit-reason
  classifier. It runs **before** account selection (`proxy.ts:242-248`) and
  rejects an Anthropic-shaped 429 from `buildSessionRejectResponse`. It does
  **not** read `rate_limited_reason` and does **not** branch on
  `model_fallback_429`. **No interaction.**
- `packages/proxy/src/handlers/rate-limit-cooldown.ts:182-187` (doc comment)
  — the cooldown machinery has a *separate* concern: "Must be called from
  every 429/529 path (response-processor, `model_fallback_429`,
  `all_models_exhausted_429`, mid-stream sniffer) — never reach into
  `rate_limited_until` manually." This is about ensuring consistent writes
  to cooldown state, not about a circuit breaker.
- `packages/proxy/src/handlers/rate-limit-cooldown.ts:60-95`
  (`getRateLimitProbeAdmission`) — there is a **single-flight probe gate** on
  accounts with `consecutive_rate_limits >= 5` whose cooldown has just
  expired. Its gate condition explicitly checks `isOverloadReason(reason)`,
  and **`model_fallback_429` is NOT in the `isOverloadReason` set**
  (`packages/core/src/constants.ts:193-197`). The probe gate does fire for
  accounts coming off a `model_fallback_429`-benched cooldown (because the
  streak gates it), but the **reason classifier** itself ignores the reason
  and uses only the streak count.
- `packages/proxy/src/handlers/rate-limit-cooldown.ts:266-289` (forward
  guard) — `isOverload` 529s never shorten an active cooldown. This is the
  reason-discriminating path; `model_fallback_429` is a 429-class reason and
  inherits the 429 backoff ramp via `computeRateLimitBackoffMs` (not the
  forward-guard treatment).

**Conclusion on circuit breaker interaction**: enabling `model_fallbacks`
does not change the existing circuit-breaker behavior. The session-volume
breaker is reason-blind. The single-flight probe gate is streak-gated, not
reason-gated. The forward-guard only special-cases 529s. There is no
hidden coupling that would make enabling `modelFallbacks` cause the
circuit breaker to fire on `model_fallback_429` differently than it does
today.

### 4.4 Interaction with PR #345 (usage-exhaustion skip)

`packages/proxy/src/handlers/account-selector.ts:215-231` — usage-capped
accounts are removed **before** `strategy.select()` sees them. The auto-refresh
bypass header (`x-better-ccflare-bypass-session`) lets synthetic probes
through (so window resets are detected). This is exactly the layer where
enabling `model_fallbacks` becomes safer:

- **Before PR #345** (zenprocess-deploy): enabling cycling on a weekly-capped
  account produced the 227× `model_fallback_429` / 27× `pool_exhausted`
  churn pattern. Cycling masked the underlying exhaustion.
- **After PR #345** (upstream/main): a weekly-capped account is removed at
  `getOrderedAccounts` time, never reaches cycling. The cycling loop only
  sees healthy accounts. Enabling `model_fallbacks` on healthy accounts is
  now meaningfully safer.

**Net effect of PR #345 on this decision**: it lowers the cost of enabling
`model_fallbacks` / `modelMappings` arrays on accounts that are healthy, by
removing the worst-case "cycle through every model on a capped account" pattern.
PR #345 does NOT remove the silent-substitution risk in §4.1.

### 4.5 What about `auto_fallback_enabled` alone — masking through auto-recovery?

If an account is genuinely capped (weekly 100%) and the operator enables
`auto_fallback_enabled`, the account will:
1. Be benched with `pause_reason = "overage"` or `"rate_limit_window"` on the 429.
2. When `rate_limit_reset` elapses (which on a weekly window can be ~40h away
   per the PR #345 incident report), auto-unpause.

This is **the documented intended behavior** and is safe. It does not mask
exhaustion — `rate_limit_reset` is the upstream's own signal that the window
has reset. The only failure mode would be if the upstream's reset timestamp
is wrong (it is trusted as the source of truth throughout the strategies),
which is out of ccflare's control.

### 4.6 Failure mode inventory (compact)

| Failure mode | Triggered by | Likelihood | Severity | Mitigated by |
|---|---|---|---|---|
| Silent model substitution | `modelMappings` array cycling | HIGH if enabled with a fallback model different from primary | HIGH (correctness) | Operator contract: ensure clients tolerate model equivalence, or use `modelMappings` with the SAME model across entries (a no-op chain) |
| Cache miss cost shift | Any cycling onto a different model | MEDIUM | LOW–MED | Operator accounting on cache-hit rate per model |
| Cycling masks capped account (audit reason changes) | `modelMappings` array on a capped account | LOW (post-PR-345) / MEDIUM (pre-PR-345) | LOW (audit noise only) | PR #345 upstream; otherwise rely on audit signal |
| `auto_fallback_enabled` masks exhausted account | Stale `rate_limit_reset` | LOW | LOW | Upstream's own reset timestamp is the trust boundary |
| Circuit breaker false-positive on `model_fallback_429` | (claimed by spec) | NONE — no code path reads reason in breakers | n/a | n/a (concern is unfounded in current code) |
| Fleet divert / native cycling double-handling | Both layers active on same signal | MEDIUM | MEDIUM (operational confusion, not user-facing) | Pick one layer as source of truth (see §6 recommendation) |

---

## 5. Is the feature present in `origin/zenprocess-deploy`?

Comparing `origin/zenprocess-deploy` (`b2c8688e`, 2026-05-06) to `upstream/main`
(`053746c1`, current) — focused on the fallback feature surface:

| Capability | `origin/zenprocess-deploy` | `upstream/main` | Notes |
|---|---|---|---|
| `auto_fallback_enabled` field | ✓ | ✓ | same semantics — auto-unpause gate |
| `model_mappings` (array form) | ✓ | ✓ | cycling chain |
| `model_fallbacks` (legacy form) | ✓ | ✓ | merged into mapping arrays at runtime |
| `RateLimitReason.model_fallback_429` | ✓ | ✓ | emitted in the same proxy-operations path |
| `RateLimitReason.all_models_exhausted_429` | ✓ | ✓ | emitted in the same path |
| `RateLimitReason.out_of_credits` | **✗** | ✓ (added for issue #261) | model/beta-scoped, does NOT bench the account |
| `RateLimitReason.extra_usage_exhausted` | **✗** | ✓ | OAuth extra-usage depletion, NOT a 429 — pass-through |
| `model-capacity.ts` reactive negative cache (`markFamilyExhausted`) | **✗** | ✓ | side-lines an account for a model family after `out_of_credits` |
| Session volume circuit breaker (`session-governor.ts`) | **✗** | ✓ | per-session request-count gate |
| PR #345 usage-exhaustion skip in `account-selector.ts` | **✗** | ✓ | removes weekly-capped accounts before strategies see them |
| `peek-availability.ts` separate module | **✗** | ✓ | mirrors auto-unpause logic without DB writes |

**Verdict**: the feature **is present in `origin/zenprocess-deploy`**. It is
not an upgrade-vs-toggle question. **The toggle works on zenprocess-deploy.**

**But the safety refinements are not.** The four ✗ rows above are the
layers that:
- prevent the cycling-masks-exhaustion failure mode (PR #345),
- prevent over-benching on model-scoped depletions (`out_of_credits`),
- cap runaway-session costs (circuit breaker),
- and let the dashboard's "primary" badge match what traffic actually picks (`peek-availability`).

**Decision**:
- If ccmax is running something close to `origin/zenprocess-deploy` (the
  orchestrator's prior inference based on `lb_strategy=least-used` and string-typed
  `rateLimitStatus`), enabling `model_fallbacks` / `modelMappings` arrays
  **is more dangerous there than on upstream/main**, because the cycling
  loop is not pre-filtered by the usage-exhaustion skip.
- The same fleet-level logic that makes the external divert expensive also
  applies: an account cycling through every model on a weekly cap is exactly
  the production incident that PR #345's commit message describes.
- **Headline for ccmax**: enabling native fallback on a zenprocess-deploy-class
  build reintroduces the pre-PR-345 churn pattern. The right ordering is
  upstream/main first (so the safety refinements land), then the native fallback.

---

## 6. Concrete recommendation (with rollback)

### 6.1 Split the question

**Q1: Should ccmax enable `autoFallbackEnabled`?**
**Q2: Should ccmax enable `modelFallbacks` / `modelMappings` arrays?**

### 6.2 Q1 — `autoFallbackEnabled`

- **Recommendation**: enable per-account where the operator wants
  post-window-reset auto-recovery.
- **Risk**: low. Documented intended behavior; gated on upstream's own
  `rate_limit_reset`.
- **Conflict with fleet divert**: none (different layer).
- **Rollback**: `POST /api/accounts/<id>/auto-fallback -d '{"enabled": 0}'`
  flips it off in seconds. No state loss.
- **Metric to watch after change**: the
  `auto-unpause: <account>` log line frequency vs the manual unpause frequency;
  account `paused=false` / `paused=true` rate over time; verify the unpause is
  correlated with `rate_limit_reset` (not random).

### 6.3 Q2 — `modelFallbacks` / `modelMappings` arrays

- **Recommendation**: **defer** until ccmax is on upstream/main AND the
  operator has decided the fleet's external divert is being retired or kept
  as the source of truth for cross-model failover. Do not enable
  concurrently with the fleet divert without an explicit hand-off plan
  (see §6.4).
- **Risk if enabled on zenprocess-deploy-class build**: high (re-introduces
  the pre-PR-345 churn pattern that the spec's incident observation cites).
- **Risk if enabled on upstream/main with a fallback chain that swaps model
  classes**: high correctness (silent substitution).
- **Risk if enabled on upstream/main with a fallback chain that stays in the
  SAME model class** (e.g. `["claude-sonnet-4-5", "claude-sonnet-4-5-20250929"]`,
  which are model-version strings, not class changes): low — cycling only
  helps if upstream's per-version cap differs. Limited utility.
- **Rollback**: clear `model_mappings` and `model_fallbacks` to null per
  account via the API. The proxy immediately reverts to the OFF path
  (`getModelList` returns `null`, length 1 path triggers `model_fallback_429`).
- **Metric to watch after change** (if enabled):
  - ratio of `all_models_exhausted_429` to `model_fallback_429` (should rise;
    if it does not, the chain isn't being traversed),
  - per-model cache-hit rate (silent substitution cost shift),
  - response-body model-claim (verify with sampled responses that the model
    name in the upstream response matches the client's request — this is a
    client-side audit, not a ccflare one),
  - weekly-cap burn rate (the fleet divert should still trigger first; if
    ccflare cycling is firing while the divert is also active, the layers
    are conflicting — see §6.4).

### 6.4 The hand-off decision the operator must make

If both layers are active simultaneously:
- The fleet divert runs at ingress and is deterministic by policy.
- ccflare cycling runs per-account per-request and is reactive to upstream.
- A request that the divert sends to `sonnet` will never hit the cycling
  loop on `opus`.
- A request that the divert does NOT divert, but lands on an account whose
  `opus` is capped, will cycle on `opus` to its fallback (or bench).

This is workable **as long as the operator explicitly chooses which layer
owns each signal**:
- **Cross-provider failover** (e.g. minimax→sonnet when minimax hits weekly cap)
  → fleet layer. ccflare should NOT also cycle within `minimax` because that
  means the account is genuinely exhausted and should be benched (not
  deflected to sonnet within ccflare — that's the divert's job).
- **Within-provider model fallback** (e.g. opus→opus-mini when opus hits a
  per-model beta cap) → ccflare cycling. This is where `modelMappings`
  earns its keep: it handles a signal the fleet divert is not designed for.

**Source-of-truth rule**: for any given `(provider, model)` pair, exactly
one layer should own the failover decision. If both own it, expect
confusing audit reasons and double-failover (cost and latency).

### 6.5 Rollback plan (summary)

| Change | How to roll back | Time to roll back | Data loss |
|---|---|---|---|
| `auto_fallback_enabled = 1` per account | API call setting it back to `0` | <1 minute | None (column value) |
| `model_fallbacks = "{...}"` per account | API call or DB edit to `null` | <1 minute | None (column value) |
| `model_mappings = "[...]"` per account | API call or DB edit to `null` | <1 minute | None (column value) |
| Fleet divert still active | Independent toggle on the fleet side | Operator-dependent | None |

There is no irreversibly destructive change in any of these toggles. The
rollback path is column-level writes, not schema or data migrations.

---

## 7. Headlines

1. **The spec's framing merges two features.** `autoFallbackEnabled` is
   auto-unpause (low risk); `modelFallbacks`/`modelMappings` arrays are
   in-account cycling on 429 (the risky one). They are independent toggles
   and should be evaluated separately.

2. **`model_fallback_429` is the diagnostic for "no cycling list configured
   and the account 429'd".** Enabling cycling eliminates the audit volume
   of that reason (replacing it with `all_models_exhausted_429` when every
   fallback also 429s) but **does not eliminate the underlying bench** when
   the account is exhausted — it just changes the audit reason.

3. **The circuit breaker does not interact with `model_fallback_429`.**
   The session-volume circuit breaker (`session-governor.ts`) is reason-blind
   and runs before account selection. The single-flight probe gate
   (`rate-limit-cooldown.ts:60-95`) keys on streak count, not reason. The
   forward-guard (`rate-limit-cooldown.ts:266-289`) only special-cases 529s.
   The spec's concern is unfounded in the current code.

4. **The headline correctness risk is silent model substitution.** When the
   cycling loop rewrites the request to a fallback model and returns the
   response to the client, the client receives a different model than it
   asked for without any signal. This is a correctness concern, not just a
   cost one — clients with capability-specific or eval-specific assumptions
   about the requested model silently violate those assumptions.

5. **PR #345 makes enabling safer on upstream/main, not on
   zenprocess-deploy.** The weekly-capped cycling-masks-exhaustion pattern
   is pre-filtered upstream but not in zenprocess-deploy.

6. **The feature exists in `origin/zenprocess-deploy`.** It is a toggle,
   not an upgrade. **However**, the safety refinements (`out_of_credits`
   reason, model-capacity reactive cache, session volume circuit breaker,
   PR #345 usage-exhaustion skip, `peek-availability`) are not in
   zenprocess-deploy. **Enabling on zenprocess-deploy re-introduces the
   pre-PR-345 churn pattern.** The right ordering is upstream/main first,
   then native fallback.

7. **Hand-off decision required if both layers active.** The fleet divert
   and ccflare cycling should not both own the same `(provider, model)`
   pair. Pick a per-pair owner before enabling ccflare cycling, or expect
   double-failover cost and confusing audit reasons.

---

## 8. What evidence would settle what's undecidable here

Items in this analysis that cannot be confirmed from code alone:

- **Is ccmax actually running zenprocess-deploy-class code?** The
  orchestrator's prior inference (`lb_strategy=least-used`,
  string-typed `rateLimitStatus`/`sessionInfo`) is suggestive but not
  confirmed. Settled by: an operator-supplied commit SHA or build artifact
  hash from ccmax. With that, this analysis can be tightened to a binary
  "safe to enable on this build" / "upgrade first".
- **What does the fleet's external divert do exactly?** The spec says
  "minimax→sonnet quota-divert" but the trigger conditions, the fallback
  timing, and whether it operates per-request or per-window are not in the
  spec. Without that, the §6.4 hand-off decision can only be sketched.
- **What `modelMappings` chains, if any, are ccmax clients sensitive to?**
  Whether silent substitution is acceptable depends on whether ccmax
  clients have model-specific contracts. Settled by: a sample of client
  traffic and operator review of model-equivalence assumptions.
- **What is the current `model_fallback_429` rate per account?** Without
  the count, the cost estimate for "audits drop, cycling substitutes"
  cannot be sized. The spec mentions a fleet-wide rate (`227×` in the PR
  #345 commit message) but that is a single-incident observation, not
  ccmax's steady-state.

None of these requires reaching `ccmax.zp.digital` directly; they are
operator-supplied context that the orchestrator should request before any
toggle change.

---

## 9. File:line evidence index

All references resolve against `upstream/main` (commit `053746c1`).

- `packages/types/src/account.ts:3-23` — `RateLimitReason` enum
- `packages/types/src/account.ts:176` — `auto_fallback_enabled` DB column
- `packages/types/src/account.ts:183` — `model_fallbacks` DB column
- `packages/types/src/account.ts:214` — `Account.auto_fallback_enabled`
- `packages/types/src/account.ts:221` — `Account.model_fallbacks`
- `packages/types/src/account.ts:261-275` — `AccountResponse` (operator-visible fields)
- `packages/core/src/model-mappings.ts:140-187` — `getModelMappings` (merges legacy into arrays)
- `packages/core/src/model-mappings.ts:248-258` — `mapModelName` (returns list[0])
- `packages/core/src/model-mappings.ts:280-290` — `getModelList` (used by failover)
- `packages/core/src/strategy.ts:32-44` — `isUsageExhausted` predicate (PR #345)
- `packages/core/src/strategy.ts:46-56` — `isAccountAvailable` (gates on it when usage provided)
- `packages/core/src/constants.ts:188-197` — `isOverloadReason` (529-class reasons)
- `packages/load-balancer/src/strategies/peek-availability.ts:21-37` — `wouldAutoUnpause`
- `packages/load-balancer/src/strategies/index.ts:359-388` — `checkForAutoFallbackAccounts`
- `packages/load-balancer/src/strategies/least-used.ts:134` — `auto_fallback_enabled` gate in `autoUnpauseElapsedAccounts`
- `packages/load-balancer/src/strategies/session-affinity.ts:185`, `session-drain-soonest.ts:342` — same pattern in other strategies
- `packages/proxy/src/handlers/proxy-operations.ts:935-989` — `model_fallback_429` emission
- `packages/proxy/src/handlers/proxy-operations.ts:1006-1057` — cycling loop (silent substitution site)
- `packages/proxy/src/handlers/proxy-operations.ts:1108-1130` — `all_models_exhausted_429` emission
- `packages/proxy/src/handlers/proxy-operations.ts:870-915` — `out_of_credits` path (issue #261)
- `packages/proxy/src/handlers/proxy-operations.ts:772-799` — `extra_usage_exhausted` pass-through
- `packages/proxy/src/handlers/account-selector.ts:215-231` — PR #345 usage-capped pre-filter
- `packages/proxy/src/handlers/rate-limit-cooldown.ts:60-95` — `getRateLimitProbeAdmission` (streak-gated, NOT reason-gated)
- `packages/proxy/src/handlers/rate-limit-cooldown.ts:182-187` — doc comment naming `model_fallback_429` as a caller site
- `packages/proxy/src/handlers/rate-limit-cooldown.ts:266-289` — forward guard (529-only)
- `packages/proxy/src/proxy.ts:238-248` — session volume circuit breaker (reason-blind)
- `packages/proxy/src/session-governor.ts:1-78` — circuit breaker module (count-based)
- `docs/auto-fallback.md` — operator-facing documentation (intent and configuration)
- `origin/zenprocess-deploy:b2c8688e` — older baseline; lacks the four ✗ refinements listed in §5

PR #345 commits (for the usage-exhaustion skip):
- `874a30ea` — "fix: skip usage-exhausted accounts during selection"
- `6abbe3c0` — "fix: wire the usage-exhaustion filter into actual account selection"