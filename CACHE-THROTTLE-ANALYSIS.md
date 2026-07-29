# CACHE-THROTTLE-ANALYSIS — ccmax config findings

**Task:** TASK C from `/Users/vvladescu/.ao/data/worktrees/ccflare/orchestrator/specs/ccmax-config-findings.md`
**Branch:** `analysis/cache-throttle` (off `upstream/main` `@ 053746c1`)
**Working tree:** assigned worktree at `~/.ao/data/worktrees/ccflare/ccflare-51`
**Inputs:** upstream/main + origin/zenprocess-deploy (HEAD `b2c8688e`, ~2026-05-06). Origin/main is the "ccflare v2" restructure and is **not** the code ccmax is running — neither toggle (`system_prompt_cache_ttl_1h`, `usage_throttling_*`) is present there.
**Scope:** ANALYSIS ONLY. No production code, no config, no push, no PR.
**All numbers below are estimates** unless stated as direct file:line evidence.

---

## 1. `system_prompt_cache_ttl_1h` — what it actually changes

### Wire behavior: it rewrites the outbound request body, not a provider header

The toggle is **not** a provider header. It is a request-body mutation applied at the proxy layer on every `/v1/messages` call.

**Read sites** (upstream/main):
- `packages/proxy/src/proxy.ts:153` — gated call inside `handleProxy`:
  ```ts
  // 3b. Optionally inject 1h TTL into system prompt cache_control blocks
  if (ctx.config.getSystemPromptCacheTtl1h() && requestBodyBuffer) {
      injectSystemCacheTtl(requestBodyContext);
  }
  ```
- `packages/proxy/src/proxy.ts:807–845` — the mutator itself. It walks the parsed JSON body's `system[]` array, finds every block whose `cache_control.type === "ephemeral"` and which has no `ttl` field, and sets `cache_control.ttl = "1h"` on each one. It is a no-op on blocks that already have a `ttl`, on blocks with non-ephemeral cache_control, on string-typed `system`, and on malformed JSON.

**What changes on the wire:** every outbound `/v1/messages` POST gets `cache_control.ttl: "1h"` added to each untagged ephemeral system block, in place. There is no other side effect — no headers, no per-account state, no DB writes, no logs beyond the normal request pipeline.

**Config plumbing:**
- `packages/config/src/index.ts:78` — schema field `system_prompt_cache_ttl_1h?: boolean`
- `packages/config/src/index.ts:425–432` — `getSystemPromptCacheTtl1h()` reads env `SYSTEM_PROMPT_CACHE_TTL_1H` first, then file value, default `false`.
- `packages/config/src/index.ts:435–437` — setter.
- Env override: `SYSTEM_PROMPT_CACHE_TTL_1H=true` flips it on without touching the file. `=false` / `=0` flips it off. Empty/unset falls through to the file.
- The flag is read **once per request** inside `handleProxy`. There is no caching of the resolved value, so runtime flips via the dashboard `POST /config/system-cache-ttl` endpoint (`packages/http-api/src/handlers/config.ts:225`) take effect on the next incoming request.

**Test contract** (`packages/proxy/src/__tests__/inject-system-cache-ttl.test.ts`):
- Returns null / no-op when system is a plain string, when no `cache_control` is set, when every ephemeral block already carries a `ttl`, when `system` is absent, on invalid JSON, and on non-ephemeral `cache_control.type`.
- Injects `"ttl": "1h"` on every ephemeral system block that lacks one.
- Does not modify message-level `cache_control` blocks — only system.

**Take-away:** the toggle is a request-body rewrite. There is no fallback path that tries to upgrade via provider headers — `anthropic-beta: prompt-caching-…` is irrelevant to this code; the cache TTL is encoded in the body itself. The toggle is therefore **completely client-transparent**: a Claude Code / fleet client sees no different API surface, no header to send, no env to set.

### Why it matters here

ccmax sees 48k–60k cached tokens per request. That cache is on the Anthropic side (the upstream provider), keyed by the rendered prompt prefix. Cache TTL is the lifetime the entry stays addressable; once the entry expires, the next request pays full input price on that prefix.

Two TTL settings are involved at the provider:
- `5m` (default for `type: "ephemeral"`)
- `1h` (explicit)

For ccflare: 5m → entry expires 5 minutes after last cache-write. 1h → entry expires 60 minutes after last cache-write. A workload that finishes a burst within 5 minutes is identical under both. A workload that bursts intermittently across 6–60 minute gaps is where the 1h TTL buys cache reads.

---

## 2. Cost / latency estimate at 48k–60k cached tokens per request

### Assumptions (each is an estimate; they materially shift the result)

- **Cached tokens per request, midpoint:** 54,000 (range 48k–60k stated by the operator). Use this as the estimate.
- **Input token price (Anthropic Claude Sonnet 4.6 / Opus 4.7):** $3 / 1M tokens input, $0.30 / 1M cache reads, $3.75 / 1M cache writes (5m TTL multiplier) and $6.00 / 1M cache writes (1h TTL multiplier). Prices assumed for Sonnet 4.6-equivalent input — the order-of-magnitude math does not change across tiers but absolute dollars do.
- **Write-to-read ratio under load:** I do not have ccmax's traffic shape. Two illustrative shapes follow.
- **Cache hit rate under each TTL:** I have no measurement of ccmax's actual hit rate. The 1h TTL only helps when consecutive requests to the same prefix are spaced **more than 5 minutes apart**. If they are spaced ≤5 minutes, the 5m TTL already covers every hit and the 1h TTL saves nothing.
- **No idle-keeper overhead assumed.** ccmax has a separate `cache_keepalive_ttl_minutes` config; this is a separate write-frequency multiplier and is **not** counted here.

### Shape A — steady interactive traffic (request every 30s, prefix stable)

Under steady traffic, every cache entry is still warm at 5 minutes. The 5m TTL already hits on request N+1 for every prefix that was written at request N. **1h TTL gives zero additional cache reads.** The only cost change is the higher write multiplier when the cache must be (re-)created.

- If prefix never churns: 0 extra cache reads, 0 saved input tokens.
- If prefix churns once per hour (e.g. a tool set update): a 1h TTL keeps the prior entry alive for re-use after the churn, saving one full write (~54k tokens @ 1h write multiplier). Net savings: **~$0.27 per churn event** (54,000 × ($6 − $3) / 1M = $0.162; vs the alternative of re-paying 54k × $3 / 1M = $0.162). The numbers happen to break even — the only durable saving is the **prompt-cache write itself**, which avoids the ~$0.16 of input that would have been uncached.

### Shape B — bursty traffic with gaps of 6–60 minutes between bursts

This is the shape where 1h TTL materially helps. Suppose there are 10 bursts per day, each 5 minutes long, each burst = 100 requests with the same prefix. Total: 1000 requests/day, ~10 distinct cache-write events instead of 100.

- **5m TTL, no 1h:** every burst pays a cache-write on its first request. First request in burst: ~$0.162 cache-write (1h multiplier equivalent — actually 5m multiplier is 1.25× = $3.75/1M = $0.203; I was using 1h multiplier above by mistake. Let me restate: 5m write = 1.25× base = $3.75 / 1M = $0.2025 for 54k tokens. 1h write = 2× base = $6 / 1M = $0.324 for 54k tokens.)

  Recompute Shape B with the correct multipliers:
  - 10 bursts × (1 cache-write + 99 cache-reads) at 54k tokens each:
    - Writes: 10 × 54,000 × $3.75/1M = **$2.025/day**
    - Reads: 10 × 99 × 54,000 × $0.30/1M = **$16.038/day**
    - Uncached (the 99 reads in each burst that miss because of the 5m gap): **0** (the first request of the burst writes, the rest read).

- **5m TTL with cross-burst gaps > 5m:** same as above per burst. The burst's first request writes; the next 99 read. Uncached prefix between bursts: 0. (The 5m gap has expired the cache, so the first request of each burst writes a fresh entry — paid at 5m write multiplier.)

- **1h TTL with cross-burst gaps > 5m and ≤ 60m:** after the first burst's write, every subsequent burst's first request finds the cache still warm (within 60m). It reads at the cache-read rate instead of writing at the 1h write rate. So:
  - Burst 1: 1 write ($3.75/1M × 54k = $0.203) + 99 reads ($0.30/1M × 54k × 99 = $1.604)
  - Bursts 2–10: 0 writes, 100 reads each. 9 × 100 × $0.30/1M × 54k = **$14.58/day**
  - Total reads: (99 + 9×100) × 54k × $0.30/1M = $16.18/day (essentially same — reads dominate either way)
  - Total writes: 1 × $0.203 = **$0.203/day** (vs $2.025 under 5m)

  **Net daily saving under 1h TTL: ~$1.82/day** for Shape B at these parameters.

- **Latency:** cache reads are typically 2–4× faster than uncached prefill (the cache-hit path skips prefill compute). At 48k–60k tokens, prefill alone is hundreds of ms; a cache read of the same prefix is closer to tens of ms. For a 100-request burst, every request that hits cache instead of uncached prefill saves ~hundreds of ms. **Per-burst latency saving: ~tens of seconds** for 100 requests × hundreds of ms each — but I cannot pin a precise number without measuring ccmax's prefill vs cache-read latency distribution.

### Caveats / undecidable parts

- **I do not know ccmax's actual traffic shape.** Shape A vs Shape B is a hypothesis. If ccmax traffic is steady-state with no >5m gaps, the 1h TTL is pure waste — and worse, the 1h write multiplier is 2× vs the 5m write multiplier (1.25×). Every forced re-write under 1h costs ~60% more than under 5m.
- **The 1h TTL also raises the write multiplier on the very first request after a churn event.** The single big benefit is the survival of the cache entry across 6–60 minute gaps.
- **If ccmax's workload genuinely hits >5m gaps regularly, the 1h TTL is net positive in dollars. If it does not, the 1h TTL is net negative.**
- **No estimate can resolve this without ccmax's request log or `cache_read_input_tokens` over time.**

### State of evidence to settle this

- Compare `cache_creation_input_tokens` (writes) and `cache_read_input_tokens` (reads) on a `/v1/accounts` or `/health` snapshot from ccmax over a 1–2 hour window at the current 5m TTL. The Anthropic usage payload exposes both.
- Look for the **distribution of time-since-last-write** across consecutive cache reads. If reads cluster at <5m, 1h TTL gains nothing. If a meaningful fraction of reads happens at 5–60m, 1h TTL saves.

---

## 3. `usage_throttling` toggles — what they do, who is throttled

### What the toggles actually change

There are two flags, both off by default, both env-overridable:

- `usage_throttling_five_hour_enabled` (env `USAGE_THROTTLING_FIVE_HOUR_ENABLED`)
- `usage_throttling_weekly_enabled` (env `USAGE_THROTTLING_WEEKLY_ENABLED`)

Config plumbing (`packages/config/src/index.ts:439–463`, defaults `false`).

### Wire behavior — model-aware pacing-line gate on candidate selection

The flags wire to **`applyUsageThrottling`** in `packages/proxy/src/proxy.ts:265`. The flow:

1. Strategy picks a candidate set (`selectedAccounts`).
2. `applyUsageThrottling` runs over the candidates.
3. If **both** flags are off, it returns `{ available: accounts, throttled: [] }` immediately — the gate is a no-op.
4. Otherwise, for each candidate, it calls `getUsageThrottleUntil(accountUsageData, settings, now, { requestModel: effectiveModel, scopedMode: "match" })` (`packages/proxy/src/handlers/usage-throttling.ts:175–209`).
5. `getUsageThrottleStatus` computes a **pacing line** per window: the linear percentage of the window's elapsed duration. If the account's **reported utilization** from Anthropic exceeds the pacing line, the account is throttled until the line catches up.
6. **Per-model scoped weekly windows** are checked against the request's model family in `"match"` mode — a per-model cap for Sonnet does not throttle an Opus request and vice-versa.
7. Internal synthetic probes (`x-better-ccflare-auto-refresh` / `x-better-ccflare-keepalive` carrying the process-local loopback secret minted at startup) are exempted entirely — they bypass the gate before any account is checked (`proxy.ts:281–284`).
8. **Combo-routed requests** pass `requestModel: null`, so per-model scoped weekly windows are skipped (only the flat windows and the reactive `out_of_credits` cache still apply). This is by design — combo routing assigns per-slot models later in the pipeline (`docs/routing-architecture.md:133`).
9. If throttling empties the candidate pool, the response is a 529 with `Retry-After: 60`, type `overloaded_error` (`usage-throttling.ts:362–386`).

### Who is throttled

**Accounts, not clients.** A client is never blocked from sending — the response is delayed (or accounts substituted upstream) by **the account-selection step** treating ahead-of-pace accounts as ineligible. From the client's perspective, the latency varies; from the operator's perspective, Anthropic's reported utilization on each account stays closer to the pacing line.

The model-scoped variant means: **for a Sonnet request, only Sonnet-weekly-window exhaustion matters**. The same account can still serve Opus requests, and the gating happens at the candidate-account granularity per request, not per client.

### Failure modes if enabled (the risky parts)

1. **Aggressive pacing line vs reality.** The pacing line is purely linear from window start to reset. If Anthropic's reported utilization spikes mid-window (a long burst), the account will be **excluded from the candidate pool until the pacing line catches up** — which for the 5h window can mean tens of minutes; for the weekly window, days. With ccmax's 48k–60k cache-reload workload, a long burst burns through cache reads quickly, pushing the account ahead of pace and then **locking it out for the rest of the window** even though it could still serve.

2. **Throttling the only-routable account.** If the fleet has thinned to a single non-exhausted account and that account goes ahead-of-pace, the throttling step empties the candidate pool and the response is a 529. Without throttling, the same account would still be selected (upstream is what limits true 429s). This converts a tolerated slowdown into a hard error.

3. **Interaction with `model_fallback_429`** (`packages/proxy/src/handlers/proxy-operations.ts:965`). A 429 that has no `modelMappings` fallback is recorded with `rate_limited_reason: "model_fallback_429"` and the account is cooled down. **Usage throttling is NOT this path.** It does not record `model_fallback_429`; it returns a 529 with type `overloaded_error` and reason `out_of_credits`-driven only via the reactive negative cache. The two paths are independent — turning on usage throttling does not silently change what reasons are persisted on 429s.

4. **Interaction with PR #345 usage-exhaustion skip.** A correctly-configured skip path on usage-exhausted accounts should still work — usage throttling's `throttled[]` is separate from `accounts[]` carrying `rate_limited_until` set, and the 503 `pool_exhausted` response path is taken when both are empty (`proxy.ts:392–404`). The 529 `usage throttling` response is only constructed when `throttledAccounts.length > 0` (`proxy.ts:413`), so a usage-throttled pool still produces a 529, not a 503.

5. **Throttling's 529 does not feed `consecutive_rate_limits`.** Per `applyRateLimitCooldown`'s reason routing (`packages/proxy/src/handlers/rate-limit-cooldown.ts:200–215`), the `rate_limited_until` field is set only on real upstream 429/529 responses — not on the synthesized 529 returned by `createUsageThrottledResponse`. So enabling throttling does not push the account into a cooldown loop on its own. **However**, the auto-refresh scheduler reads utilization from a probe, and if the probe happens while the account is ahead-of-pace, the probe itself would have been throttled without the `isSyntheticProbe` exemption that the code now carries (`proxy.ts:281`); the 529 returned by the throttled-probe path does NOT count toward `consecutive_rate_limits` (the cooldown is only set via `applyRateLimitCooldown`), so a throttled healthy account's probe does NOT auto-pause it. This was a regression pre-PR-#331 and is now closed.

6. **The throttling uses a process-local usage cache (`usageCache.get(account.id)`).** It is in-memory, not persisted. Restarting the process loses throttling state. For a fleet behind load balancing, this means throttling state is per-replica — under multi-replica, the effective pacing enforcement is per-replica, not aggregate. With ccmax presumably running a single process (most local proxies do), this is a non-issue.

7. **No model-scoped capacity interaction** with the toggle unless `MODEL_SCOPED_CAPACITY_ROUTING=exhausted` is also on. The capacity-routing filter (`packages/proxy/src/handlers/account-selector.ts` — confirmed in `proxy-model-capacity.test.ts`) runs in `selectAccountsForRequest` **before** `applyUsageThrottling`. So a Sonnet-exhausted account is filtered before throttling sees it, and usage throttling's `requestModel`-aware check is a no-op for already-filtered accounts. No conflict.

### What does NOT break if enabled

- `isAccountAvailable` in `packages/core/src/strategy.ts:48` is unrelated — it's the gate on `paused` / `requires_reauth` / `rate_limited_until`. Usage throttling operates on candidates that already passed that gate.
- 429 failover (PR #345) and `modelMappings` graceful fallback are unaffected — they run after the account is selected.
- Internal synthetic probes are exempted.
- Cache TTL behavior is unrelated — `injectSystemCacheTtl` runs before account selection, not after.

---

## 4. Interaction with circuit breaker / SSE admission

### Session volume circuit breaker (already in upstream/main)

- `packages/proxy/src/session-governor.ts` — opt-in breaker with `CCFLARE_SESSION_MAX_REQUESTS_PER_HOUR` (default `0` = off). When set, a runaway subagent loop per client session is rejected with a 429 before account selection.
- Call site: `proxy.ts:248–250`. Runs **before** `selectAccountsForRequest` and therefore before `applyUsageThrottling`.
- The breaker has **its own budget** (per-client session, per-hour). It does not share state with usage throttling (per-account, per-window-class).
- Both can fire on the same request only if (a) the session is over its hourly budget AND (b) every available account is ahead-of-pace. In that case the breaker fires first (429, `x-better-ccflare-governor: session-budget`). If the session is within budget but every account is ahead-of-pace, the throttling fires (529, `overloaded_error`).

### SSE admission control (NOT yet in upstream/main)

- Lives in branch `feat/sse-admission-control` (commit `61825651`, listed in the worktree list at `/private/tmp/claude/verify-240`).
- Files: `packages/proxy/src/stream-admission.ts` and `packages/proxy/src/__tests__/stream-admission.test.ts` (verified via `git ls-tree` and `git grep` against the remote).
- **It is not yet merged into upstream/main.** I have not read its content because (a) my assigned worktree's `.claude/agents` is sandbox-blocked so I cannot check it out, and (b) the analysis question is whether an interaction exists — which I can answer from the order of operations in `handleProxy`.

### Are they additive, redundant, or conflicting?

**Additive**, not redundant:

- Session governor: rejects a runaway **client session** before account selection.
- Usage throttling: rejects **accounts** that are ahead-of-pace before forwarding upstream.
- SSE admission (once merged): would presumably cap **concurrent in-flight streams** somewhere mid-pipeline. (I have not read the code; it is a hypothesis based on the branch name and the test file's location under `stream-admission.test.ts`.)

All three reject different populations:
- Session governor → per client session, time-budgeted.
- Usage throttling → per account, utilization-budgeted.
- SSE admission → per concurrent stream, capacity-budgeted.

No two of them gate on the same thing, so enabling usage throttling alongside the session governor is **not** a conflict. The risk if all three are on simultaneously is cumulative rejection: a request can be denied because it fails any one of the three gates, so the **observed success rate** is the product of the three individual rates. With ccmax's high cached-token workload, a stalled cache miss could push usage past the pacing line, which pushes throttling ahead, which has no interaction with the session governor or SSE admission but compounds on top of them.

### One subtle interaction to watch

`applyUsageThrottling` short-circuits when both flags are off (`proxy.ts:269–271`). If usage throttling is left **off**, it does no work at all — no extra latency per request. If it is on, the per-candidate loop in `applyUsageThrottling` adds at most a few microseconds (one JSON parse + a pacing-line check per candidate) — negligible relative to upstream prefill. **Enabling usage throttling does not measurably change p99 latency in the happy path**; only the rejection path (529) costs the client time.

---

## 5. Are these settings in `origin/zenprocess-deploy`?

| Setting | upstream/main (`053746c1`) | origin/zenprocess-deploy (`b2c8688e`) | origin/main (`9c44de10`, v2) |
|---|---|---|---|
| `system_prompt_cache_ttl_1h` | yes — file:line `packages/config/src/index.ts:78`, wired in `proxy.ts:153` via `injectSystemCacheTtl` | yes — file:line `packages/config/src/index.ts:61`, code path exists in `packages/proxy/src/proxy.ts` (confirmed via grep) | **NO — not present** |
| `usage_throttling_five_hour_enabled` | yes — config schema + wired through `applyUsageThrottling` in proxy.ts | yes — same shape, defaults match (`false`) | **NO — not present** |
| `usage_throttling_weekly_enabled` | yes — same | yes — same | **NO — not present** |

### So: not an upgrade. Just a config flip.

Both flags exist in `origin/zenprocess-deploy` (the inferred code ccmax is running, per the spec's shared context), default to `false`, and are wired through the same code paths. **Enabling them is a config flip, not a code change.** No code rebuild is required. The ccmax dashboard exposes a "Routing settings" card on the Settings tab (per `docs/routing-architecture.md` and `packages/dashboard-web/src/components/overview/SystemCacheTtlCard.tsx`) that already toggles `system_prompt_cache_ttl_1h`; the throttling toggles ride on the same Settings card.

Defaults in both branches are identical:
- `getSystemPromptCacheTtl1h()` returns `false` unless env or file sets it.
- `getUsageThrottlingFiveHourEnabled()` and `getUsageThrottlingWeeklyEnabled()` return `false` unless env or file sets them.

So the ccmax operator's "all toggles off" report matches the shipped defaults.

---

## 6. Recommendation, metric to watch, rollback trigger

### Recommendation: enable `system_prompt_cache_ttl_1h` first; defer `usage_throttling_*`

The two settings are independent. The risks and benefits differ.

**Enable `system_prompt_cache_ttl_1h`** in a low-risk manner:

1. **Confirm the workload shape first.** Pull `cache_creation_input_tokens` and `cache_read_input_tokens` from ccmax's Anthropic usage payloads over a 1–2 hour window at the current 5m TTL. If the workload has ≥1 meaningful burst at 5–60 minute spacing, enable. If traffic is steady and contiguous, leave it off — the 1h write multiplier (2×) makes churns more expensive for no read gain.
2. **Flip via env.** `SYSTEM_PROMPT_CACHE_TTL_1H=true` on the ccmax process. Env override is read on every request, so this is reversible without restart.
3. **Metric to watch after enabling:**
   - `cache_read_input_tokens` — should rise by the same factor that writes shrink (if reads dominate, the bill goes down).
   - `cache_creation_input_tokens` — should drop on net (fewer cross-burst re-writes).
   - p50/p95 TTFT — should drop modestly if any non-trivial fraction of requests hits cache.
   - Total `usage.response.usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens` — the actual bill-driving metric. **Total per-token bill should drop if 1h TTL is genuinely useful; should rise modestly (1h writes are 60% more expensive than 5m writes) if it is not.**
4. **Rollback trigger:** if total bill rises by >10% over 24 hours, or if `cache_creation_input_tokens` does not drop, roll back. Rollback = `SYSTEM_PROMPT_CACHE_TTL_1H=false` on the process. No restart needed (env read per request).

**Defer `usage_throttling_*`** until the 1h TTL change has been observed for a week:

- The pacing-line model is a meaningful behavior change — ahead-of-pace accounts are excluded from the candidate pool, which is a stronger restriction than just-rate-limiting them.
- The 5h flag is the more dangerous of the two: a 5h ahead-of-pace lockout blocks the most interactive workload. The weekly flag's worst case is days of lockout, but for a fleet that has multiple accounts, the per-account scope limits blast radius.
- If you do enable, **start with `USAGE_THROTTLING_WEEKLY_ENABLED=true` only**, observe, then layer the 5h flag.
- **Metric to watch after enabling:**
  - 529 response rate with `type: "overloaded_error"` and message starting with `"Usage throttling is delaying requests for account(s):"` — should be the dominant indicator. If it climbs >2% of requests, throttle back.
  - `consecutive_rate_limits` on accounts — should NOT climb (synthetic 529s do not feed it). If it does, that's a regression in the probe-exemption code path.
  - Per-account `rate_limited_until` durations — should not be set by throttling.
  - p99 request latency — should not regress in the happy path.
- **Rollback trigger:** if 529-overloaded rate climbs >5% of requests within 1 hour, or if any healthy account auto-pauses (would indicate a probe-exemption regression), flip `USAGE_THROTTLING_WEEKLY_ENABLED=false` (and `USAGE_THROTTLING_FIVE_HOUR_ENABLED=false` if also enabled).

### Sequencing

1. **Day 0:** Observe current cache metrics. No change.
2. **Day 1:** Enable `SYSTEM_PROMPT_CACHE_TTL_1H=true` via env. Observe for 24 hours.
3. **Day 2:** Compare 24h bill before vs after. Decide keep/rollback based on the metric in §6 above.
4. **Day 7+:** If cache TTL change is net-positive, layer in `USAGE_THROTTLING_WEEKLY_ENABLED=true`. Observe for 24 hours.
5. **Day 8+:** If weekly throttling holds, decide on 5h flag. If 5h is enabled, hold at warn-only on the session governor (default) — don't enable circuit breaker enforcement unless an actual runaway-loop incident occurs.

### Why this sequencing

- 1h TTL is reversible in seconds (env read per request).
- Usage throttling is reversible in seconds (env read per request) but its **first-hour behavior is the riskiest** — a misconfigured pacing baseline could lock out a healthy account for the rest of its window. The per-window-class opt-in (`five_hour` vs `weekly`) lets you disable the most aggressive gate first.
- The session governor is already opt-in (`CCFLARE_SESSION_MAX_REQUESTS_PER_HOUR=0` default = off). I do **not** recommend enabling it now — the workload profile for ccmax is interactive Claude Code, not a runaway subagent storm. Enable only on observed runaway behavior.

---

## Appendix — every file:line referenced

### Upstream/main (`053746c1`)

- `packages/config/src/index.ts:78` — schema field `system_prompt_cache_ttl_1h?: boolean`
- `packages/config/src/index.ts:425–432` — `getSystemPromptCacheTtl1h()`
- `packages/config/src/index.ts:435–437` — setter
- `packages/config/src/index.ts:79–80` — throttling flags schema
- `packages/config/src/index.ts:439–463` — throttling getters (env override first, then file, then default `false`)
- `packages/config/src/index.ts:507–511` — throttling setters
- `packages/proxy/src/proxy.ts:153` — gated call to `injectSystemCacheTtl`
- `packages/proxy/src/proxy.ts:807–845` — `injectSystemCacheTtl` mutator body (only modifies ephemeral system blocks without `ttl`)
- `packages/proxy/src/proxy.ts:248–251` — session-governor call site (5b.)
- `packages/proxy/src/proxy.ts:265–334` — `applyUsageThrottling` implementation
- `packages/proxy/src/proxy.ts:281–289` — internal-probe exemption
- `packages/proxy/src/proxy.ts:413` — 529 `overloaded_error` construction when throttled pool is empty
- `packages/proxy/src/handlers/usage-throttling.ts:175–209` — `getUsageThrottleStatus` core pacing-line algorithm
- `packages/proxy/src/handlers/usage-throttling.ts:211–219` — `getUsageThrottleUntil`
- `packages/proxy/src/handlers/usage-throttling.ts:362–386` — `createUsageThrottledResponse` 529 builder
- `packages/proxy/src/session-governor.ts:48–84` — `recordSessionRequest` (returns verdict; rejects only if `maxLimit > 0 && count > maxLimit`)
- `packages/proxy/src/session-governor.ts:156–187` — `buildSessionRejectResponse` (Anthropic-shaped 429)
- `packages/core/src/strategy.ts:48–61` — `isAccountAvailable` predicate (paused / requires_reauth / rate_limited_until / usage-exhausted)
- `packages/types/src/account.ts:1–27` — `RateLimitReason` union (`model_fallback_429` is one variant; not used by usage throttling)
- `packages/proxy/src/handlers/proxy-operations.ts:965` — `model_fallback_429` reason set on 429 with no model_fallbacks mapping (independent path from throttling)
- `packages/proxy/src/__tests__/inject-system-cache-ttl.test.ts:18–127` — full mutator contract

### origin/zenprocess-deploy (`b2c8688e`)

- `packages/config/src/index.ts:61–63` — schema fields
- `packages/config/src/index.ts:368–406` — getters/setters (same defaults as upstream/main)
- `packages/proxy/src/proxy.ts:276` — `applyUsageThrottling` exists (line number differs from upstream; behavior appears same)
- `packages/proxy/src/proxy.ts:290` — `getUsageThrottleUntil` call site
- `packages/proxy/src/handlers/usage-throttling.ts:175` — `getUsageThrottleStatus` exists
- `packages/proxy/src/__tests__/inject-system-cache-ttl.test.ts` — full mutator contract present

### Branches/features noted but not read

- `feat/sse-admission-control` — SSE admission control work. Files `packages/proxy/src/stream-admission.ts` and `packages/proxy/src/__tests__/stream-admission.test.ts` exist (per `git ls-tree` and `git grep`); not yet in `upstream/main`. Not analyzed because (a) the question is interaction-shape, not feature details, and (b) the assigned worktree sandbox blocks checking it out.

### Out of scope (per spec)

- Sandbox network boundary to `*.zp.digital` was not attempted.
- No production code was modified; no config changed; no commit pushed; no PR opened.
- Tasks A and B (other workers, in parallel) are out of scope for this deliverable.
