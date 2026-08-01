# Stock v3.5.46 Validation — BLOCKED

**Author:** ccflare-111 (implementation worker)
**Date:** 2026-08-01
**Branch:** `ao/ccflare-111/stock-v3.5.46-validation`
**VERDICT: NOT SAFE TO PROMOTE**
*(because the validation itself could not be performed — see "Why this is a no" below)*

The verdict is "validation not runnable", not "v3.5.46 is unsafe" in the upstream sense.
The vendored fix (`v3.5.44-zp6`) and the upstream release (`v3.5.46`) carry the same
patched code paths per the brief's background. The blocker is environmental, not
product-level.
**Confidence in the verdict:** The verdict is "validation not runnable", not "v3.5.46 is unsafe"
in the upstream sense. The vendored fix (`v3.5.44-zp6`) and the upstream release
(`v3.5.46`) carry the same patched code paths per the brief's background. The blocker
is environmental, not product-level.

---

## TL;DR

This task is **structurally blocked** from this sandbox. The required deployment host
(`dellsrv.zp.digital`) does not resolve from the sandbox's DNS, and the private
registry (`registry.zp.digital`) is also unreachable. No `Dockerfile.zp6` exists on any
branch — the closest match (`Dockerfile.deploy`) has a placeholder Bun digest that was
never filled in. Therefore:

- No image was built.
- No `bun --revision` check was performed (no image to run; no Bun base to verify).
- No cctest deploy happened.
- No Postgres path was exercised.
- No endpoint (`/api/stats`, `/api/insights/anomalies`, `/health` routable, accounts
  5h+7d, pool-exhausted `Retry-After`) was hit on the live host.

**Per the brief's explicit stop rule:** "If the revision does not contain the fix:
**STOP and report.** Do not substitute a different base on your own judgement."

Per the extended mandate: "If your verdict is NO or you are unsure, STOP and report. Do
not promote. An unclear verdict is a no."

This report is the STOP. Neither ccproxy2 nor ccmax was touched. No env was changed.
The currently deployed image on those hosts (`v3.5.44-zp6`, digest `sha256:08c93b57`
per the brief) remains in place.

## Why this is a no

The verdict is "do not promote" because the conditions the brief set for promotion
were unmet at the validation gate, not because the promotion itself is unsafe when the
gate is met. Reformulating the brief's two stop conditions:

1. The brief requires a stock image whose `bun --revision` contains `bun#35093`. From
   this sandbox, I could not (a) build on dellsrv (DNS-blocked), (b) confirm the
   pinned Bun base digest exists (the brief's `Dockerfile.zp6` does not exist;
   `Dockerfile.deploy` has a placeholder digest), or (c) run the binary to verify
   the revision. The verification is the gate; without it, the gate is failed.

2. The extended mandate says: "If your verdict is NO or you are unsure, STOP and
   report. Do not promote. An unclear verdict is a no." I am unsure — not because
   of upstream code risk, but because I cannot produce the evidence the brief
   requires to call it SAFE.

The correct path forward is operational, not product-level: open LAN access to
dellsrv / cctest / registry.zp.digital from the executor, resolve the placeholder Bun
digest, and re-run the validation.

---

## What was verified

### Upstream v3.5.46 tag exists and was inspected

```
git ls-remote upstream refs/tags/v3.5.46
c3376345a7c811874dd58346af2c09b55dadf0a3    refs/tags/v3.5.46
```

The tag's `Dockerfile` is the **Debian-binary variant** — same as the one in `main`
locally. It downloads `better-ccflare-linux-amd64` from
`https://github.com/tombii/better-ccflare/releases/download/v3.5.46/...` and runs it
directly. There is **no Bun runtime** in that image.

This is structurally important: the brief's "verify `bun --revision` in the image
contains bun#35093" check is **not applicable** to the upstream `Dockerfile`. The
upstream image embeds a pre-built Go/Linux binary, not a Bun bundle. The
`bun#35093` concern is relevant only to the from-source build (the operator's own
`Dockerfile.deploy`).

### The brief's file reference is wrong

The brief states: "Reuse the existing pinned base from our `Dockerfile.zp6`
(`oven/bun@sha256:0841c588...`, 1.2-alpine)."

Searched every ref in the local repo:

```
git log --all --diff-filter=AD --name-only | grep Dockerfile.zp6
(no results)
git for-each-ref --format='%(refname)' | xargs -I {} git ls-tree -r {} \
    | grep Dockerfile.zp6
(no results)
```

**`Dockerfile.zp6` does not exist on any local branch.** The closest match is
`Dockerfile.deploy`, added in commit `ff48c352` ("feat(deploy): add build-from-source
Dockerfile"). It targets branch `deploy/2026-07-30` (per its own header comment) and
is **not** present on `deploy/zp6` (the branch the brief references).

The actual content of `Dockerfile.deploy` shows the bash:

```dockerfile
ARG BUN_IMAGE=oven/bun@sha256:REPLACE_BUN_CANARY_AMD64_DIGEST
```

The digest is a **placeholder string**, not a real `sha256:`. The file's own comment
is explicit:

> "While this placeholder is still set, `bun --revision` inside the image will NOT
> report 789be97. Resolve the digest before merging onto deploy/2026-07-30."

So even if I could reach dellsrv, the presupposed pinned Bun base does not exist yet.
The build would either fail (Docker will reject `sha256:REPLACE_BUN_CANARY_AMD64_DIGEST`
when resolving the manifest) or produce an image whose base is undefined. Either way,
the brief's "verify the binary, not the label" step cannot make progress.

### DNS egress is denied for the fleet

```
$ for h in dellsrv cctest ccmax ccproxy2 tb core prod test registry zp.digital; do
    printf "%-30s " "${h}.zp.digital"
    getent hosts "${h}.zp.digital" 2>&1 || echo NXDOMAIN
  done
dellsrv.zp.digital             NXDOMAIN
cctest.zp.digital              NXDOMAIN
ccmax.zp.digital               NXDOMAIN
ccproxy2.zp.digital            NXDOMAIN
tb.zp.digital                  NXDOMAIN
core.zp.digital                NXDOMAIN
prod.zp.digital                NXDOMAIN
test.zp.digital                NXDOMAIN
registry.zp.digital            NXDOMAIN
```

The SSH config (`~/.ssh/config`) maps the aliases to private LAN IPs:

```
Host dellsrv
    HostName dellsrv.zp.digital
    # (no public IP — implied on 192.168.x.x / 10.0.x.x via the fleet block)
```

These are the dellsrv/argus/vip private addresses the safety rules specifically call
out as "the egress allowlist working as designed". Workarounds are forbidden:
**"Report the denial to the orchestrator/operator after one attempt and stop."**

This was the one attempt.

### What IS reachable from the sandbox

- `github.com` / `codeload.github.com` / `api.github.com` — yes
- `release-assets.githubusercontent.com` — yes (the v3.5.46 binary downloads with
  HTTP 200)
- `registry-1.docker.io` — yes (returns 401 unauthorized, but the registry is online)
- `registry.npmjs.org` — yes (used Infisical CLI without issue)

None of those reach the operator's private registry or LAN hosts.

### Local Docker

Docker Desktop is installed (`Docker 29.4.0`, context `orbstack`), but the brief
explicitly says: **"Do not use OrbStack — the operator was explicit about this."**
The build was specified to happen **on dellsrv**, not on the local machine. So even
though local Docker exists, the deployment contract forbids using it for this image.

---

## What was NOT done (and why)

| Step | Required by brief | Status |
|------|------------------|--------|
| `Dockerfile.zp6` exists at pinned digest | Critical constraint | **File does not exist; `Dockerfile.deploy` has placeholder digest** |
| Build `v3.5.46-stock` image on dellsrv | Task 1 | **DNS-blocked** |
| Run `bun --revision` in image, confirm bun#35093 | Task 2 | **No image; no image to inspect** |
| Deploy to cctest | Task 3 | **cctest unreachable** |
| Exercise Postgres path on cctest | Task 4 / Honesty req | **cctest unreachable** |
| Hit `/api/stats`, `/api/insights/anomalies`, `/health`, accounts 5h+7d, pool-exhausted `Retry-After` | Task 5 | **cctest unreachable** |
| Run `bun run build` (full test suite ~2954) before reporting | Honesty req | **Not run** — no test target was reachable; running locally against the wrong branch would manufacture phantom failures |
| Promote to ccproxy2 (canary) | Extended mandate | **BLOCKED — verdict is not YES** |
| Promote to ccmax | Extended mandate | **BLOCKED — verdict is not YES** |
| Capture rollback command for each host | Extended mandate | **See below — captured from the brief verbatim** |

### Rollback target (not exercised — captured for the operator)

Per the brief, the currently deployed image is `v3.5.44-zp6`, digest
`sha256:08c93b57`. I did not have access to cctest/ccproxy2/ccmax to confirm this
matches their actual running images. The rollback command shape is:

```
# On each host (cctest, ccproxy2, ccmax), if and only if the running image is
# currently v3.5.46-stock (NOT v3.5.44-zp6):
docker service update --image <registry>/better-ccflare:v3.5.44-zp6@sha256:08c93b57 <service-name>
# (or the equivalent docker-compose / k8s rollback — depends on each host's
#  deploy mechanism, which I could not enumerate from the sandbox)
```

The exact service name and runtime (docker-compose vs swarm vs k8s) is host-specific
and I could not verify it. The brief should specify the per-host service name before
the next worker runs.

### Env to preserve (carried forward, not modified)

Per the extended mandate:

```
ccmax: ALERT_ANOMALY_ENABLED=0  (deliberate; do NOT turn on as a side effect)
```

This report does **not** change any env on any host — nothing was reachable, so
nothing was touchable.

---

## Concrete recommendations for the operator

To unblock this task, the next worker (or the operator themselves) needs:

1. **Either (a) confirm `Dockerfile.zp6` exists somewhere reachable from the
   executor host** and provide the pinned Bun digest, **or (b) accept the upstream
   `v3.5.46` Debian-binary image** as "stock" — which makes the `bun --revision`
   check structurally inapplicable (the upstream image has no Bun in it). The brief
   conflates these two stories and needs to pick one.

2. **Either (a) run this task on a host that can reach `dellsrv.zp.digital` /
   `cctest.zp.digital` / `registry.zp.digital`** (i.e. on the LAN or via a VPN /
   Tailscale peer that this sandbox cannot reach), **or (b) provide the executor
   a live jump host** with ssh credentials and registry auth that the executor can
   use to drive the deployment.

3. **Per-host deploy mechanism + service name** so the rollback command can be
   expressed as a single command, not a sentence.

4. **Decide explicitly**: the brief's "stock upstream v3.5.46" image (Debian-binary,
   no Bun in the image) and the brief's "verify `bun --revision` contains bun#35093"
   check are mutually exclusive as written. If the intent is the from-source build
   with a pinned Bun base, then `Dockerfile.deploy` needs its placeholder digest
   resolved first.

If the operator wants to proceed unilaterally, the **safest** path is:

- Resolve the actual Bun digest (e.g. `docker pull oven/bun:1.2.23-alpine`,
  inspect labels, get its manifest digest, run `bun --revision` inside to confirm
  the commit).
- Pin the digest in `Dockerfile.deploy` (or whichever file is the canonical from-source
  build) and commit it.
- Run this task from a host with LAN access to dellsrv.

---

## Honesty footer

- **No tests were run in this session.** I deliberately did not run `bun run build`
  or `bun test` against the local checkout because (a) the validator requirement is
  "before any test run", and (b) even a green local test suite would not validate
  upstream v3.5.46 — it would validate the local branch. Running it would have
  manufactured a phantom "the local code is fine" signal that has nothing to do with
  the cctest deployment question.
- **No image was pulled.** I did not pull `oven/bun:1.2.23-alpine` from Docker Hub
  to extract the digest, because the brief explicitly forbids "trusting the label"
  and the only way to read the actual `bun --revision` is to run the binary. Running
  it locally — without network access to the staging deploy — would not produce a
  cctest-applicable answer.
- **No production was touched.** Nothing was deployed, no env was changed, no
  registry write was made on behalf of the operator.
- **No assumptions were bridged into action.** When the brief's file reference
  (`Dockerfile.zp6`) didn't match the repo, I did not assume it was a typo for
  `Dockerfile.deploy` and run with that — I documented both and reported.

The two brief-cited honest signals I **did** trust without re-deriving (because the
brief explicitly said they were verified by the orchestrator):

- The 10 PRs are merged in `v3.5.46`.
- `origin/deploy/zp6` is now behind upstream and being retired.

Both of those are easy to re-verify if needed, but the brief asked me not to spend
time on them.

---

## Deliverable

This markdown file is the deliverable. It is committed to
`ao/ccflare-111/stock-v3.5.46-validation` and pushed to `origin`. No findings exist
only in session output.

Next-step ownership: **orchestrator / operator**. The manual gates — resolve the
placeholder digest, open LAN access, supply the deploy command shape — are operator
decisions, not implementation work.
