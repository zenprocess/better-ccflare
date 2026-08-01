# ccmax provenance verification — operator decision guide

This is the 2 a.m. guide for the AO executor and the on-call operator
when asked: *"is what is running on ccmax actually what we built?"*

There are two scripts. They answer two different questions. Pick the
right one — they have different exit-code meanings.

| Script | Question it answers | Run from | Exit codes |
|---|---|---|---|
| `scripts/verify-live-build.sh` | What is actually inside the running container? (read-only capture) | a host that can reach the ccmax docker daemon | `0` OK · `1` partial · `2` prerequisites missing · `64` bad args |
| `scripts/provenance-canary.sh` | Does the running build match the deploy branch HEAD? (comparator) | a host that can reach both `/health` *and* the git repo | `0` `VERIFIED_MATCH` · `1` `VERIFIED_DRIFT` · `2` `COULD_NOT_CHECK` · `64` bad args |

Both are read-only. Neither pulls, restarts, or stops anything.

---

## Part A — capture-only (use `verify-live-build.sh`)

When you just need to know *what is in there* — image digest, /health
fields, `bun --revision`, OCI labels, layer digests — run:

```bash
# On the deploy host itself, against the local daemon:
scripts/verify-live-build.sh --local --container ccflare \
    -o /tmp/ccmax-provenance.txt

# OR from a bastion with SSH access to the deploy host:
scripts/verify-live-build.sh --ssh ccmax \
    --container ccflare \
    -o /tmp/ccmax-provenance.txt
```

The script prints `KEY: value` lines, one per captured field, plus a
`STATUS: OK | PARTIAL ...` summary. Paste the whole output into the bug
report — it is self-describing.

### Decision table — `verify-live-build.sh` output

| What you see | Conclusion | What to do next |
|---|---|---|
| `STATUS: OK` AND every field present | `VERIFIED CAPTURE` — the probe ran clean; this is the *raw material* for Part B | Pipe `/tmp/ccmax-provenance.txt` into the canary comparator (Part B) |
| `HEALTH_GIT_SHA: MISSING` or `unknown`, `STATUS: PARTIAL — /health did not report git_sha` | **Expected on ccmax today.** The image was built *before* the `/health` provenance fields were added (`#109`). The image is unprovable *by construction*. | Capture the rest of the report (digest, labels, layers, `bun --revision`) anyway. Then answer "what's running" by comparing layer digests to a registry you control, OR by re-tagging the deploy to a build that includes `#109`. |
| `HEALTH_GIT_SHA: <40-hex>` but `STATUS: PARTIAL — image had no RepoDigest` | The image was pulled by tag, not digest. Tag can move under you. | Re-pull by digest, redeploy, re-run. Until then, treat the SHA as a *suggestion*, not a fingerprint. |
| `BUN_REVISION: <skipped: --no-container>` | You used `--no-container`; we couldn't ask the binary. | Re-run *without* `--no-container` — `bun --revision` is the ground truth; the image label lies. |
| `FATAL: docker not found on remote host ...` / `FATAL: no running container named '...'` / `FATAL: /health unreachable ...` | `COULD NOT DETERMINE` — the script could not run. | Re-run with `--ssh ccmax --container <actual-name>`; confirm the docker daemon is up; confirm port 8080 is published. |
| `FATAL: 'bun --revision' failed inside the container` | The image isn't based on `oven/bun` *or* the ccflare user can't exec bun. | `docker exec -u root <ctr> which bun` — fix the image, then re-run. |
| `FATAL: /health body is not JSON` | `/health` contract is broken on the running build. | Compare `HEALTH_VERSION` against the source: if it's much older than `#109`, the contract was different then — `COULD NOT DETERMINE` until you redeploy. |
| `LAYERS:` followed by digests, **and the image was never committed to the registry** | The layer digests are the only true content fingerprint. Save them. | This is the legitimate "matches no known source" finding — the Dockerfile that built it was never committed, so the registry has nothing to match against. **This is the answer we are trying to establish, not an error.** |

### What the legacy-build outputs are *supposed* to look like

On a ccmax build that predates `#109`, you will see:

```
HEALTH_GIT_SHA:      MISSING
HEALTH_GIT_REF:      MISSING
HEALTH_BUILD_DATE:   MISSING
HEALTH_VERSION:      0.x.y            (some pre-provenance version)
STATUS:              PARTIAL — /health did not report git_sha
```

**This is correct, not a script bug.** The script is reporting exactly
what `#109` was added to fix. Read it as: "the build is older than the
provenance contract." Do not chase it as a failure.

Likewise, "matches no known source" for the Dockerfile is a *legitimate
finding* — it is the question we are trying to answer. The image was
built with a Dockerfile that was never committed, so the registry has
nothing to match. The script cannot lie about that.

---

## Part B — match-or-drift (use `provenance-canary.sh`)

When you need a verdict — *is what's running the same as what we
intended to deploy?* — run the canary, not the capture script:

```bash
# From any host that can reach both /health AND the git repo.
# Easiest: a one-shot docker on the deploy host itself.
docker run --rm --network=host \
    ccflare-provenance-canary:latest \
    --host http://127.0.0.1:8080/health \
    --repo https://github.com/zenprocess/better-ccflare.git \
    --branch deploy/2026-07-30
```

Add `--json` for log-aggregator ingestion. The exit code is the verdict;
do not parse the text.

### Decision table — canary verdicts (the three unambiguous states)

| Verdict | Exit | When | What to do |
|---|---|---|---|
| `VERIFIED_MATCH` | `0` | `/health.git_sha` equals the SHA that `git rev-parse refs/heads/<deploy-branch>` reports | The running image is provably the deploy branch HEAD. Stop. |
| `VERIFIED_DRIFT` | `1` | `/health` returned a real SHA, and that SHA exists in the repo, and it is *not* the deploy branch HEAD | The image is provably stale or wrong. Roll back to the deploy-branch HEAD, or fast-forward the deploy branch and re-build — but do not leave the canary in `VERIFIED_DRIFT` and call it green. |
| `COULD_NOT_CHECK` | `2` | any of: host unreachable, HTTP non-200, body not JSON, `/health` missing `git_sha` or reporting `"unknown"`, git clone/fetch failed, git rev-parse failed | **Never green.** Fix the precondition (deploy host down → restart it; missing `git_sha` → rebuild with `#109`; missing deploy branch → re-tag the deploy) and re-run. A canary that says green when it could not actually check is worse than no canary. |

There is no fourth state. If the script printed "OK" with exit 0, the
running image is provably the deploy branch HEAD. If it printed anything
else with exit 0, you are misreading the output — *there is no "OK but
..."*; the comparator is fail-closed by design.

### The `git_sha absent from /health` case on ccmax

The build currently running on ccmax almost certainly predates `#109`,
so `/health` does not report `git_sha`. The canary's `git_sha == "unknown"`
check then exits **`COULD_NOT_CHECK`**. Read that as:

> *"The running image was built without `CCFLARE_GIT_SHA` injected. The
> image is unprovable by construction. A re-deploy that includes
> `#109` is the only fix."*

This is *not* `VERIFIED_DRIFT` and it is *not* `VERIFIED_MATCH`. Do not
treat it as a pass.

---

## Bun revision ancestry — the "is the fix in this build?" check

The bun#35093 followup burned a digest whose label claimed a SHA while
the binary inside reported a different one. **Labels lie; binaries do
not.** Always check the actual `bun --revision` inside the running
container (Part A, step `[5/7]`), and verify it is a descendant of the
upstream fix commit.

The bun#35093 fix landed in **`oven-sh/bun` @ `789be97db9b746533cf692e8367146e2d3c0d7cb`**
on **2026-07-28** ("fetch: error the response body stream when a
fully-buffered response is aborted", `#35093`).

### One-liner to check ancestry

```bash
gh api repos/oven-sh/bun/compare/789be97db9b746533cf692e8367146e2d3c0d7cb...<revision> \
    --jq '"status=\(.status) ahead_by=\(.ahead_by) behind_by=\(.behind_by)"'
```

Substitute `<revision>` with the value of `BUN_REVISION` from the
Part A capture.

| `status` | Meaning | Verdict |
|---|---|---|
| `ahead` or `identical` | `<revision>` is a descendant of (or equal to) `789be97d` | **Fix is contained.** This binary cannot have the bun#35093 bug. |
| `behind` | `<revision>` is an ancestor of `789be97d` — i.e. it is older | **Fix is NOT contained.** This binary is *vulnerable* to the bug the followup burned. |
| `diverged` | `<revision>` and `789be97d` have no common ancestor relationship in the compare range (e.g. a fork point) | **Cannot determine from this check alone.** Re-check with the merge-base: `gh api repos/oven-sh/bun/compare/<merge-base>...<revision>` and treat "behind" as not-contained. |

Do **not** trust the OCI image label or any digest-from-a-PR-comment. The
`BUN_REVISION` line from Part A and the ancestry check above are the
only ground truth we have.

---

## When to use which script — short version

- *"I just need to know what's in the running container"* → Part A (`verify-live-build.sh`).
- *"I need a yes/no on whether ccmax matches the deploy branch"* → Part B (`provenance-canary.sh`).
- *"Did the bun#35093 fix make it into the binary that's running?"* → run Part A, take `BUN_REVISION`, run the ancestry one-liner.
- *"The output says `PARTIAL` and `git_sha MISSING`"* → expected for any build older than `#109`; capture the rest, then either re-deploy with provenance fields or compare layer digests against a registry you control.

## When *not* to use these scripts

- **The AO executor sandbox.** The sandbox cannot reach `*.zp.digital`
  by design and the Docker socket is permission-denied from inside the
  worker. Run the scripts from a host that can reach the deploy daemon
  and the git repo — e.g. on the deploy host itself, on a LAN bastion,
  or in a self-hosted CI runner on the LAN. Wrap them in the
  `provenance-canary.Dockerfile` image (5 MB alpine + `git`/`curl`/`jq`).
- **When the deploy host is in maintenance.** `COULD_NOT_CHECK` is the
  right answer then; do not chase it as a script bug.
