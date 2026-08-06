# Issue #144 — Least-privilege brokered pull executor

Status: **design**. No implementation in this branch. Closes the design portion
of issue #144 acceptance; the "build it?" decision is left to the operator and
is recorded in §7.

This document records what the executor would be, what it would refuse to be,
and what stays operator-only regardless. It is paired with issue #110
(provenance canary) and upstream PR #380 (the `git_sha` fields the canary
relies on); the three must stay in lock-step on the meaning of "the intended
version".

## 1. Threat model

**Who is untrusted.**

1. **Sandboxed automation** — an agent session (or any tool that runs out of a
   network-restricted sandbox) is the principal caller. It cannot reach the
   deployment host today and is not trusted to be reconfigured to do so.
   Treating the caller as untrusted is the whole point.
2. **A co-tenant on the host** — another workload sharing the executor's
   machine. It must not be able to piggy-back on the executor's credential.
3. **A future maintainer who forgets the scope** — drift happens. The deny
   list (§3) is a fail-safe against the executor being quietly extended past
   its original remit.

**What they want.**

- **Sandboxed automation:** prove the running instance is the version the
  operator intended. That is the whole of issue #110. It only needs to *read*.
- **A buggy or malicious co-tenant:** use the executor's reach to mutate the
  host, exfiltrate config, or pivot to anything else reachable from it.
- **A future maintainer:** convenience. "Just add a verb to fix this one
  thing." Each convenience extension is a privilege the executor is no longer
  least.

**What over-privilege is being removed.**

Today, anything that wants to verify or roll back a deploy needs a credential
broad enough to do far more than that. Two practical examples:

- A deploy-side operator with shell on the host can read every account token,
  rotate them, drain the pool, edit the DB, rewrite the image, and push code
  to any repo with write access.
- A canary job that needs the deployment host's `/health` plus `git ls-remote`
  against the public fork today cannot be run from the sandbox at all, so it
  is either done by hand or skipped.

The executor is the thing that turns the second workload into "needs read-only
reach to two specific endpoints" instead of "needs a shell." It does not turn
the first into anything safer — the first workload stays operator-only (§6).

**What this design does not protect against.**

- An attacker who controls the operator endpoint (the host) itself. If they
  win, they can lie about `/health`. Out of scope; the comparator's value is
  *non*-control-plane corruption, not adversary-on-host.
- A bug in the runtime that runs the executor. Software bugs are not solved
  by threat models.
- Secrets the operator has already pasted into the running image's env.

## 2. What the executor must do

A single, narrow verb set. Each verb is named, parameter-bounded, and audited.

| Verb | Inputs | Effect |
| --- | --- | --- |
| `read-health` | `host_id` (from allowlist) | `GET {host}/health` (auth-exempt), parse the four-tuple, return it. No state change. |
| `resolve-intended-sha` | `host_id`, `ref_pattern` (from allowlist) | `git ls-remote {source-of-truth} {ref_pattern}`, return the matched tip SHA(s). No state change. |
| `compare` | output of the two above | Local-only computation. Returns one of `verified` / `drift` / `unknown`. |
| `restart-image` *(optional, see §7)* | `image_digest` (full SHA256, not a tag) | Pull the image, restart the unit, do not change what is being requested. Optional — gated by the operator's policy, never by the caller. |

No other verbs. "Run a command", "edit a file", "open an HTTP socket to an
arbitrary host", "talk to a registry I did not bake in" — none of these exist.

## 3. Explicit deny list

Even with attacker-controlled inputs, the executor must refuse:

1. **Tags instead of digests for image references.** A tag like `latest` is a
   moving pointer; the executor accepts only a 64-char SHA256 digest, and
   only one on the allowlist baked at deploy time. A caller passing a tag
   gets back `unknown` and an audit entry; it does not get a pull.
2. **Image refs outside the allowlist.** The allowlist is a fixed set of
   digest → registry tuples. A caller can request "restart the unit with
   image X" only if X is in the allowlist. Any other input is rejected.
3. **Shell, exec, eval, or any Turing-complete surface.** The executor is not
   a job runner. It has no `run(cmd)` function. There is no REPL.
4. **Egress to anything other than the two endpoints it knows.** Network
   policy at the executor host (firewall, container egress, or equivalent)
   whitelists the deployment host and the public source-of-truth and
   drops everything else. The executor cannot *try* to reach anywhere else.
5. **Mutating the source-of-truth.** `git ls-remote` is read-only. The
   executor never holds a credential with push rights.
6. **Credentials with broad scope.** The auth token (if any is needed at all)
   is provisioned read-only against the specific repo and is rotated
   independently of every other credential. See §4.
7. **Cross-project reach.** A profile for one project must not implicitly
   grant reach to another. Per-project scoping is structural, not
   policy-as-text.
8. **Logging payloads.** The executor logs the *verb*, the *parameters as
   values* (image digest, ref pattern), the *result class* (verified / drift
   / unknown / denied), and the *caller identity*. It does not log response
   bodies, token material, or anything else.

## 4. Trust boundary

**Caller-supplied.**

- `host_id` — a key into the deploy-time allowlist (e.g. `prod-1`). Resolves
  internally to a URL. The caller never names the host itself.
- `ref_pattern` — one of a fixed set the deploy-time config accepts
  (e.g. `refs/heads/main`, `refs/heads/deploy/*`). Caller cannot type an
  arbitrary ref.
- The output of one verb is the only valid input to another. There is no way
  for a caller to feed a SHA it observed elsewhere into `compare` and have it
  count as "verified" against an allowlisted ref.

**Fixed at deploy time and not caller-supplied.**

- The mapping from `host_id` to the deployment-host URL.
- The mapping from `ref_pattern` to the literal `git ls-remote` argument.
- The image-digest allowlist (for the optional `restart-image` verb).
- The registry hostname(s) and credentials.
- The egress policy on the executor host.

**Where the credential lives.**

- The source-of-truth token (if authentication is required — `git ls-remote`
  over `https://` to a public mirror does not need one) is fetched from the
  project secret store *by name*, not by value, at executor startup. It is
  never on the caller's wire, never in the executor's logs, never in its
  config file. Rotation is decoupled from everything else.
- The deployment host `/health` is auth-exempt by design (issue #110) — the
  executor does not need a token for it.
- An image-pull credential, where used, is similarly fetched by name from the
  secret store and scoped to `registry:pull` only.

**Image-ref injection surface.**

The single most dangerous surface is the image reference. The executor must
treat it as untrusted text and constrain it as follows:

- Accept only values that parse as `[a-f0-9]{64}` (SHA256 digest).
- Match the digest against the deploy-time allowlist before doing anything
  else.
- Resolve the digest to a registry URL that the executor's egress policy
  already whitelists. A caller cannot redirect the pull by supplying an
  alternate registry name.
- Reject on the first check that fails. No retry on a different shape, no
  best-effort tag fallback.

A caller passing `ghcr.io/example/foo:latest` gets the same response as a
caller passing an empty string: `unknown` plus an audit entry, never a pull.

## 5. Verification

After pull-and-restart (if the operator enables that verb at all), the
executor must prove the running instance is the intended version. The proof
is *not* "the image ID matches"; it is "the `/health` provenance four-tuple
matches what was requested."

Concrete steps:

1. `GET {host}/health` — read the four top-level fields the upstream
   provenance change made mandatory:
   - `version` — image version (string)
   - `git_sha` — full 40-char commit SHA the image was built from
   - `git_ref` — branch / tag name (e.g. `main`, `deploy/2026-08-01`)
   - `build_date` — RFC 3339 timestamp
   Each field reports `"unknown"` when unset. This contract is what makes
   "anonymous build" detectable as a finding rather than a pass.
2. Reject `unknown` for `git_sha`. An image that does not know where it came
   from is, by definition, not the intended image. Exit class: `unknown`.
3. `git ls-remote {source-of-truth} {ref_pattern}` and resolve the tip SHA
   the requested ref points at.
4. Compare. Three outcomes, only three:
   - `verified` — `git_sha` equals the resolved tip and the build date is
     within the operator's policy window.
   - `drift` — the SHA does not match any allowlisted ref.
   - `unknown` — network failure, auth failure, or the `/health` endpoint
     unreachable. **Never a pass.**

The `/health` four-tuple and the issue #110 canary's three-state outcome
(`verified` / `drift` / `unknown`, with `unknown` distinct from `drift`) are
the same contract. They were designed together. Any change to one is a
change to the other; they live or die as a pair.

## 6. Failure and rollback

| Failure | Executor behaviour |
| --- | --- |
| `git ls-remote` network error, auth error, timeout | Return `unknown`. Audit. Do not retry into a pass. |
| `GET /health` unreachable or non-200 | Return `unknown`. The previous result is still the latest known; nothing is implied. |
| `/health` returns `unknown` for `git_sha` | Return `unknown`. The instance itself is the finding. |
| `git ls-remote` succeeds but the requested ref does not exist | Return `drift`. The intent is unambiguous and unmet. |
| `restart-image` (if enabled): image digest not in allowlist | Refuse. Audit. No state change. |
| `restart-image`: pull succeeds but unit does not return `200 /health` within the operator's window | Stop. The previous unit stays as it was (or the operator's pre-restart snapshot is restored — see §7). Report `drift` with the prior and current SHA. |
| `restart-image`: pull fails | No restart. The previous image is still running. Report `unknown`. |

**Rollback.** Because every state-changing verb requires a digest that is in
the deploy-time allowlist, rollback is the same primitive as forward motion:
restart with a digest that *was* running before. The executor does not need
a separate "rollback" verb, and a caller cannot ask for a version that was
never approved. The operator's allowlist is the rollback policy.

The executor never holds a credential broad enough to do anything else, so
"the executor is broken" is recoverable by rotating its single scoped
credential and rebuilding it; nothing else on the host depends on it.

## 7. Is this worth building at all?

Issue #144 explicitly allows "no, manual is fine" as the closing answer. My
recommendation is **split, not all-or-nothing**.

- **Build the read-only half now.** A `read-health` + `resolve-intended-sha`
  + `compare` executor is the entire gap on issue #110, and it carries zero
  deploy credential. This half is small, reversible, and unblocks the
  provenance canary without widening any privilege boundary beyond what
  `/health` already exposes.
- **Defer the `restart-image` half until it has a concrete caller.** Building
  it speculatively creates a credential that nothing currently uses; unused
  credentials are a security liability, not a feature. When an automated
  rollback path becomes a real requirement, build it then, with the same
  shape, and only the verb set from §2 expanded.
- **Do not widen the sandbox.** Issue #144 lists this as an explicit
  non-goal and the boundary has caught real mistakes. Stay closed.

**Open questions for the operator.**

1. **Where does the executor run?** Two realistic options: (a) a dedicated
   container on the same host as the deployment it watches — simplest
   network-wise, but co-tenant risk is highest; (b) a separate small VM
   on the same LAN, with the deployment host as its only egress target —
   stronger isolation at the cost of another box. *Recommend (b) once the
   read-only half is built and load-tested; (a) is acceptable for a first
   cut if it has its own user, its own egress policy, and no shared home
   directory with anything else.*
2. **What does the executor's identity look like to the caller?** A
   well-known URL the canary polls, or a sidecar the canary already talks
   to? *Recommend a stable, allowlisted URL — the canary is already
   polling `/{host}/health`, adding one more well-known endpoint is
   smaller than inventing a new protocol.*
3. **Who signs the deploy-time image-digest allowlist?** If `restart-image`
   is enabled later, every entry in the allowlist is a deploy authorization.
   This needs to be a single, named operator action — not "anyone who can
   edit the executor's config". *Recommend an explicit allowlist PR per
   digest, reviewed and merged by the same operator who would have run the
   deploy by hand. The audit trail is the point.*

## 8. T3 boundary — what stays operator-only

Holding a deploy credential is **T3** under operator policy, and this design
does not change that. The executor reduces blast radius; it does not make
deployment agent-safe.

Concretely:

- The deploy-time allowlist of image digests is operator-only.
- Any network policy that whitelists the executor's egress is operator-only.
- Any secret the executor fetches by name is operator-provisioned.
- The first creation of any host_id → URL binding is operator-only.
- Anything that would extend the verb set beyond §2 is operator-only.
- The first deploy after the executor's allowlist changes is operator-only.

The operator is the trust anchor. The executor is what lets a small, narrow
class of automation *ask* questions of the deployment without *being* the
deployment.

---

**Cross-references.** Issue #110 (provenance canary), upstream PR #380
(`/health` provenance fields). Both are load-bearing; if either changes, this
doc must be re-read.