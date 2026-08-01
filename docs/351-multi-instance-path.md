# Multi-instance deployment of better-ccflare — staged implementation path

> Companion analysis to issue #351 and PR #376. Drafted in response to maintainer
> feedback (“Wouldn’t mind a PR or a suggested implementation path :)”). Not a PR.
> Distilled from current `upstream/main` and the issue’s seven enumerated
> categories. All findings reference files that exist on that branch at the time
> of writing.

---

## TL;DR

better-ccflare today is **single-instance-by-design** in a way that is not
obvious from the outside. Running two instances behind one hostname on a shared
database is unsafe for reasons that are silent and easy to misattribute.
PR #376 lands Stage 0 (a startup-time heartbeat guard) and is enough to make
the failure mode loud instead of silent. Whether the maintainer wants to invest
in distributed-state Stages 1–4 is the actual open question. **This document
argues that Stages 1–4 are mostly undesirable and that the honest gift to a
solo maintainer is “do not build Stages 2–4”: a clearer deployment-doc
statement plus the existing guard, nothing more.** A staged path is included
so that, if that argument fails, the smallest sufficient design is one jump
ahead rather than five.

If the maintainer reads only one section, read **§8 Recommendation** and
**§7 Adversarial lens: don’t build this**.

---

## 1. Context

Issue #351 enumerates seven categories of in-process state that a shared
database does **not** fix, and lists three practical consequences
(gradual-cutover impossibility, missing drain story, rollback asymmetry). It
is filed as documentation/enancement and explicitly *not* a bug report. The
triage bot and the maintainer independently accepted the diagnosis.

The maintainer’s follow-up comment asked why three instances are in use:

- One hostname per provider family (Anthropic / a second commercial
  provider / local models).
- Each instance has its own provider set and its own upstream credentials.
- They do **not** share a hostname, and they do **not** share the unsafe
  configuration the issue warns about.

That detail matters. Three instances on three hostnames with disjoint
account sets is **segregation**, not high availability. None of the
seven failure modes in the issue manifest between them. The unsafe
configuration the issue actually warns against — two instances behind
*one* hostname on a shared DB — is not what is deployed. **The
problem in the issue is real; we are not currently exposed to it.** Anyone
attempting a blue/green or HA topology would be, and that is why the
issue is worth addressing at all.

The maintainer’s invitation, quoted verbatim: *“Wouldn’t mind a PR or
a suggested implementation path :)”*

The intent of this document is to give the maintainer a path that does
not over-promise. Anything Stage 2 and beyond should not be undertaken
lightly.

---

## 2. What already shipped (Stage 0)

PR #376 (`fix/multi-instance-guard`, +927 LoC, open at time of writing)
implements the only thing that is right *regardless of how the rest of
the debate resolves*:

- A startup-time guard that detects another live instance pointing at the
  same database and warns the operator.
- A new `instance_heartbeats` table; each instance writes/refreshes its
  row on a 5-second tick; rows older than 30s are treated as dead and
  purged at startup.
- Default behaviour is **warn** (no behaviour change for existing
  single-instance deployments).
- Opt-in hard fail via `BETTER_CCFLARE_MULTI_INSTANCE=refuse`.
- Wired into `DatabaseOperations.initializeAsync()` / `close()`.
- Works on SQLite and PostgreSQL with a static-parity test keeping both
  schemas in lockstep.

This is Stage 0. It makes the unsafe topology *visible* and gives
operators an opt-in kill switch. **It does not make multi-instance
correct** — only survivable enough to detect the deployment error
quickly. That distinction matters for the rest of this document; if
Stage 0 is conflated with “multi-instance support”, the same mistake
that produced #351 will recur.

---

## 3. The seven categories, verified on `upstream/main`

Each category was located and re-read against current `main` so the
issue’s diagnosis matches what is actually deployed. File paths use the
repo-relative form; line numbers are illustrative (drift over time).

| # | Category | Verified on `main` | Symptom under shared DB | Severity if unguarded |
|---|----------|--------------------|-------------------------|-----------------------|
| 1 | `SessionAffinityStrategy` sticky map | `packages/load-balancer/src/strategies/session-affinity.ts` (class at 72; `private affinity = new Map<...>()`; `private lastPickedAt = new Map<>()` keyed on account) | Client pinned on instance A gets a *different* account on instance B. Defeats the prompt-cache locality the strategy exists to preserve. | High — silent cache-miss inflation. |
| 2 | `LeastUsed` / `SessionDrainSoonest` recency-penalty Map | `packages/load-balancer/src/strategies/least-used.ts` and `session-drain-soonest.ts` (constants `RECENT_PICK_PENALTY = 100`, `RECENT_PICK_WINDOW_MS = 500`, in-process Maps) | Each instance only penalises its own recent picks. Anti-clustering degrades ≈ proportionally to instance count. | Medium — load imbalance becomes visible only under sustained traffic. |
| 3 | `UsageCache` singleton | `packages/providers/src/usage-fetcher.ts` (`class UsageCache` ~ line 586; exported singleton `usageCache` at the bottom of the file) | Each instance polls upstream independently, holds a divergent util view, and votes with that view against the same DB row. Routing decisions diverge. | Medium — divergence is bounded by poll interval but never zero. |
| 4 | `CacheBodyStore` keepalive cache | `packages/proxy/src/cache-body-store.ts` (class at 104; `staging`, `lastCachedRequest` Maps) | Keepalive replay becomes instance-local. Warm body is unavailable to peers. | Low — keepalive is an availability nicety, not a correctness invariant. |
| 5 | `AutoRefreshScheduler` mutex + counters | `packages/proxy/src/auto-refresh-scheduler.ts` (private `refreshMutex`, `consecutiveFailures: Map<...>`, `lastFailureProbeAt: Map<...>`) | Two instances refresh the **same account’s OAuth token** concurrently. This is the sharpest category: not just a duplicate request, a token-refresh race against the provider. | **Critical.** Possible provider-side token invalidation; also possible double-write of the new refresh token. |
| 6 | Recovery-probe `probeLeases` | `packages/proxy/src/handlers/rate-limit-cooldown.ts` (module-scope `const probeLeases = new Map<string, number>()`) | N instances each send N recovery probes for the same account after a mature 429 streak expires. Defeats the single-flight guarantee the lease was written to enforce. | High — exactly the stampede the gate exists to prevent. |
| 7 | `SessionGovernor` volume circuit breaker | `packages/proxy/src/session-governor.ts` | Per-process session-volume accounting. Two instances each allow their share of the per-account session budget, breaking the limit. | Medium — usually self-corrects; problem is silent. |

Categories 5 and 6 are the load-bearing ones the issue’s author flags.
Both exist specifically to enforce single-flight semantics that a second
process silently breaks. Every other category degrades quality; these
two degrade *correctness*.

---

## 4. Documentation drift (recommended fix)

Independent of the staged path below, the existing deployment
documentation already implies multi-pod Kubernetes is supported:

- `docs/deployment.md:803` — “SQLite is unsuitable for Kubernetes
  deployments with multiple replicas”
- `docs/deployment.md:818` — “SQLite is unsuitable for Kubernetes
  deployments with multiple replicas because …” (rephrasing)
- `docs/deployment.md:834` — “For multi-pod Kubernetes deployments,
  you **must** use PostgreSQL”
- `README.md:47` — “supporting Kubernetes multi-pod deployments”
- `README.md:60` — same claim in feature list

The Stage-0 guard in #376 closes that gap only partially — Postgres
multi-pod remains the documented happy path. A pure-doc PR that
replaces those mentions with an explicit single-instance statement
(plus a link to the new guard env var) is the **cheapest single
deliverable** and arguably the highest-leverage one. It is independent
of every other stage and can ship ahead of any code change.

---

## 5. Stages ranked by blast radius

Stages below are ordered by blast radius / cost-of-being-wrong, smallest
first. Each stage is independently shippable and is a strict no-op on
single-instance deployments.

### Stage 0 — Loud guard *(shipped by PR #376)*

- **What:** Startup heartbeat table; default warn; opt-in refuse.
- **Effort:** S — already done.
- **Risk:** Low. Stale-row handling matters (heartbeat purges its own
  ghost rows; verified by tests).
- **Desirability:** Mandatory. Without it the rest of this document is
  risk theatre.

### Stage 1 — Ingress-level sticky routing *(zero ccflare changes)*

- **What:** Operators put a load balancer (HAProxy / Nginx / Envoy /
  Cloudflare LB) in front of ccflare and pin a client to one backend
  instance by source IP / cookie / TLS fingerprint. Stickiness is at the
  TCP/HTTP layer, not the proxy layer. Within an instance, ccflare’s
  own sticky-map works correctly.
- **What it fixes:** Category 1 (session affinity) fully. Category 2
  (recency penalty) per-instance, which is sufficient since the
  incoming client population is split, not duplicated. Category 4
  (cache body) partially — warm body may be missing on the second
  instance’s first hit after failover, but that is a one-request cost.
- **What it does NOT fix:** Categories 5 and 6 (refresh mutex and
  probe leases). Two ingress-routed instances still hit the same
  providers concurrently for OAuth refresh and recovery probes. *If
  that is unacceptable, do not proceed past Stage 1.*
- **Effort:** S — config-only. Outside the ccflare codebase.
- **Risk:** Near-zero. The only failure mode is a misconfigured
  stickiness policy that ends up load-balancing anyway, which the
  Stage-0 guard catches.
- **Desirability:** **Highly recommended.** This is the ceiling for
  most realistic use cases. If the maintainer wants to do nothing
  beyond Stage 0, operators can still get a useful HA-from-the-client’s-
  perspective deployment by combining Stage 0 + Stage 1.
- **Honest disclosure:** Stage 1 also does *not* heal category 7
  (session governor) — if ccflare is configured with a per-account
  session-volume limit, the limit becomes per-instance and the global
  limit effectively doubles (or N-tuples). Operators must accept or
  raise that limit.

### Stage 2 — Externalise UsageCache + leader-elected auto-refresh *(medium effort)*

The smallest correct fix for categories 5 and 6.

- **What it does:**
  - Replace the in-process `UsageCache` Maps with a short-TTL DB view
    (≤ ~5s polling) and have all instances read from it. Cache lookup
    is now O(1) against shared state.
  - Replace `AutoRefreshScheduler.refreshMutex` (and the consecutive-
    failure counters that justify the refresh) with a DB-backed
    leader election: only the elected leader runs refreshes and
    recovery probes; followers serve traffic only.
  - Implement leader election as a lease row in the same database,
    reusing the heartbeat table from Stage 0 (no new infrastructure
    dependency).
- **Effort:** M. Adds DB-driven coordination; ~700–1000 LoC plus tests;
  a binary leader-election primitive; a fail-over path (drain leases
  on heartbeat loss; immediate re-election with small jitter).
- **Risk:** Medium. Leader-fail-over windows are a new failure mode
  (during which refresh is skipped). Concretely: if a leader crashes
  mid-refresh, a 30-second gap before the next refresh is the
  expected worst case. Operational tooling needs a heartbeat-watcher.
- **Desirability:** **Conditional.** Only valuable if the maintainer
  is willing to commit to operating leader-election support forever.
  tombii is a solo maintainer; this is a meaningful new responsibility
  class.

### Stage 3 — Distributed session affinity *(high effort, marginal return)*

- **What it does:** Move `SessionAffinityStrategy.affinity` and
  `lastPickedAt` into the database or into a separate Redis-shaped
  store. Each instance consults the shared map on every sticky pick.
- **Effort:** L. The existing affinity TTL was tuned for in-memory
  read latency, not DB round-trip latency; new sub-millisecond read
  budget required. Compression or partition-by-accountId likely.
- **Risk:** Higher. The stored map must remain correct under concurrent
  writers; incorrect writes inflate cache-miss rate silently.
- **Desirability:** **Probably not worth it.** For the only published
  use case (one hostname, two instances, equal share), Stage 1’s
  ingress stickiness achieves the same observable behaviour without
  CCflare-level coordination.

### Stage 4 — Cross-process recovery-probe single-flight *(very high effort, weak case)*

- **What it does:** Replace the module-scope `probeLeases` Map with a
  coordinated lease (`probeLeases` is the proximate source of N-fold
  probe stampedes under category 6). Without Stage 2’s leader
  election, this is its own distributed lock with all the
  complications that implies.
- **Effort:** L–XL. New coordination primitive; clock-skew handling;
  failure-counter liveness on a leased lock.
- **Risk:** High. The recovery probe is a hot-path microsecond
  operation during 429 storms; introducing any DB / Redis round-trip
  to that path is a measurable latency regression even when no
  coordination is actually needed.
- **Desirability:** **Almost certainly not.** Stage 2 already solves
  this category by serialising refresh through the leader. A
  standalone Stage 4 is only worth it if the maintainer explicitly
  rejects leader election and is willing to pay the latency tax.

---

## 6. Cross-stage table

| Stage | Categories fixed | Effort | Risk | New infra | Desirability |
|-------|------------------|--------|------|-----------|--------------|
| 0 (#376) | All seven, *visibility only* | S | L | One new table | **Mandatory** |
| 0b (doc) | n/a — operator awareness | XS | Very low | — | **Strongly recommended** |
| 1 (ingress) | 1, 2, 4, 7 (partial); **not 5, 6** | S | Near-zero | Ingress LB only | **Recommended ceiling** |
| 2 (leader) | 5, 6, 7 (full), 3 (full), 4 (full) | M | Medium | Reuses DB | Conditional |
| 3 (affinity) | 2 (full), 1 (replaces Stage 1 stickiness) | L | High | DB or Redis | Probably not |
| 4 (probe) | 6 (standalone) | L–XL | High | Coordination primitive | Almost certainly not |

Bolded rows are the only ones I would recommend.

---

## 7. Adversarial lens: do not build Stages 2–4

The strongest argument runs as follows:

1. **The failure modes are diffuse, not damaging.** Aside from
   categories 5 and 6 (token refresh race; recovery-probe stampede),
   every other category causes routing quality degradation that users
   would read as “occasionally a bit slower” or “the second account
   gets used more than I expect”. No data loss, no provider ban risk,
   no auth failure.

2. **Categories 5 and 6 are caused by Stage 2, not by adding more
   stages.** The honest fix for the load-bearing categories is
   **leader election on the refresh and probe path**, which is one
   stage, not a four-stage roadmap. Marketing Stages 3 and 4 as
   “completion” misrepresents the engineering. They exist because
   they are interesting, not because they are needed.

3. **Stage 1 already buys the behaviour most operators want.** If an
   operator configures ingress stickiness and the operator accepts
   that category 5/6 still happens, their deployment is observably
   safer than today and is one config file change away from
   opt-in hard-fail on `#376`. That is a complete answer to the
   “someone will hit this and be confused” worry in the issue.

4. **Leader election is a forever-support burden.** It is not a
   one-shot change; it is a class of operational behaviour the
   maintainer must care about for the lifetime of the project.
   Heartbeat drops, network partitions, clock skew between replicas,
   schema migrations while a leader is in flight — each is a
   new failure mode that needs diagnostics. tombii is a solo
   maintainer with merged-only commit cadence high enough that
   adding a forever-on-call subsystem is a poor gift.

5. **Stage 2 forces a design choice that the maintainer should make
   consciously.** Adding the *infrastructure* for distributed state
   (heartbeat lease, leader handoff, refresh-with-during-elections
   semantics) commits to an architecture. Once committed, undoing
   it because the maintainer decided multi-instance was a bad idea
   is its own large PR. The cheapest moment to say “don’t build
   this” is before the infrastructure exists.

6. **Nobody known to be running the unsafe configuration.** The
   author of the issue is running three segregated instances, not
   two-ha. The maintainer is not running it. Other readers of the
   issue have asked questions but have not filed follow-ups reporting
   damage in the wild. The design pressure is theoretical, not
   observed.

If that argument is stronger — and I think it is — the right
deliverable to the maintainer is:

- Land PR #376 (or its successor).
- Land the documentation fix in §4 of this document.
- Stop there.

A clear “not building this; here is the deployment-doc statement and
the loud guard” is more valuable to the project than an ambitious
roadmap the maintainer must own forever.

---

## 8. Recommendation

**Ship Stage 0; ship the Stage-0b doc fix; recommend Stage 1
operationally; decline Stages 2–4 as a feature.** If a Stage-2 PR
appears from outside, review it on its merits but do not feel
obligated to absorb its operational burden.

If the maintainer disagrees with §7 and asks for Stage 2:

- **Lease-based leader election** is preferred over lock-based.
- The leader holds a single row; heartbeats refresh it on the
  same 5-second tick that Stage 0 already established.
- Leader loss must trigger an immediate but **debounced** re-election
  — re-electing on every transient heartbeat blip is the new failure
  mode.
- Recovery probes and OAuth refresh are the only leader-only
  responsibilities. Everything else (request handling, session
  affinity, usage cache reads) stays per-instance.
- Configuration: `BETTER_CCFLARE_LEADER_ELECTION=elected` (opt-in).
  Default off, preserving single-instance semantics for everyone else.

But I would not pre-build the opt-in flag if asked — the maintainer’s
“no” is cheaper to give before there is code to maintain.

---

## 9. What this document is, and is not

**Is:**
- A staging proposal ranked by blast radius.
- An honest comparison against the “do not build this” position.
- A verified enumeration of the seven categories against current
  `upstream/main`.

**Is not:**
- A PR. There is no code change here.
- A claim that we have any data on real-world multi-instance users.
- A recommendation to proceed past Stage 0.
- A claim about commercial-SLA reliability of leader election under
  any specific network topology.

**Inputs:** issue #351, PR #376, current `upstream/main`. **No
internal identifiers** are present in this document; all references
are to source-tree pathnames or to public issue/PR numbers.

---

## 10. Suggested follow-up (review-only)

If helpful to the maintainer, the next concrete action item is a
small PR that does only the §4 documentation fix:

- Replaces the multi-pod K8s guidance in `docs/deployment.md:803–834`
  and `README.md:47,60` with an explicit single-instance statement.
- Cross-references the new `BETTER_CCFLARE_MULTI_INSTANCE` env var.
- Notes that ingress-level stickiness *is* a viable topology despite
  the limitation.

That PR is independent of every other stage, reviewable in five
minutes, and converts the issue’s “someone will hit this and be
confused” worry into a hard preflight failure.
