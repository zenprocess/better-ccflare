# Adversarial review: `scripts/verify-live-build.sh`

- **Reviewed**: `scripts/verify-live-build.sh` at `origin/ao/ccflare-113/provenance` (commit `65d5bc97`, branch tip `2ab14f37`)
- **Reviewer**: ccflare-120 (this session)
- **Intended use**: one-shot, manual, against the operator's live production CCMAX instance
- **Reviewed against**: `set -euo pipefail` bash 4+ semantics; docker daemon semantics; the `/health` contract documented in `packages/api/src/handlers/health.ts` (commit `48234f67`); the build-time provenance injected by `Dockerfile` lines 171–173, 221–233
- **NOT yet compared to**: ccflare-119's hardening branch — `ao/ccflare-119/root` exists locally but has not yet committed changes to `verify-live-build.sh`; this review is against the pre-hardening tip only

## TL;DR

**The strict-read-only claim is technically PROVEN** (no `docker pull | restart | exec-with-writes | cp | commit | prune | rmi | tag` and no `tee > /var/lib/docker | > ~/.config | > /proc | > /sys | > /var/log`); but the script is **functionally unsafe for production use** for three independent reasons:

1. **Exit-code semantics are broken.** `STATUS: PARTIAL` and `STATUS: OK` both exit 0. The header documents exit 1 for "missing or unexpected" and promises "Partial output is not a passing run." Both promises are silently false. Any operator pipeline that gates on `$?` will treat PARTIAL as success.
2. **The script is non-deterministic in several ways.** `head -n 1` over `docker ps` output, regex anchor `/` with metacharacter-unescaped names, and a literal `<no value>` Go-template fallback for empty `RepoDigests` can each pick the wrong artifact.
3. **The SSH/Docker wrapper has a remote-shell-injection path** via the `--container` value (verified, HIGH). Several other HIGH findings (port-mapping namespace bug, hardcoded `--health-url` curls locally in SSH mode, `accept-new` host-key trust) compound the risk for a one-shot production run.

**Verifier overall verdict**: `WRITES_SOMETHING` — strictly speaking it writes to the operator-supplied `-o` path and to `~/.ssh/known_hosts`, both expected, neither production. But "writes something" is the only non-PROVEN category the verifier permitted.

**Missing-fields handling verdict**: `BROKEN` — see Finding C-1.

This script should **not be run against CCMAX in its current form**. ccflare-119's hardening branch must land before it does.

---

## Severity legend

- **CRITICAL** — would produce a wrong verdict on a misbuilt/compromised image, or would misreport the existing pre-#109 fleet as success.
- **HIGH** — silently misreports under realistic conditions, or opens a path the operator cannot detect.
- **MEDIUM** — wrong answer in a narrow but reachable scenario, or leaks infrastructure naming.
- **LOW** — code-quality or defense-in-depth issue with no current wrong-answer path.
- **INFO** — non-defect observation worth recording.

---

## C — CRITICAL findings (must block production use)

### C-1. STATUS: PARTIAL exits 0, contradicting the documented contract

- **Evidence lines**: 71–75, 99–101, 450–466
- **Verifier verdict**: CONFIRMED (severity retained)
- **Failure scenario**: Operator runs the script against CCMAX. The image was built before PR #109 wired `CCFLARE_GIT_SHA` into the Dockerfile, so `packages/api/src/handlers/health.ts` substitutes `"unknown"` for `git_sha` (and `git_ref` and `build_date`). The script:
  1. Captures `HEALTH_GIT_SHA: unknown`.
  2. Prints `STATUS:              PARTIAL — /health did not report git_sha`.
  3. **Exits 0** (the final command, line 466 `echo "OK"`, has exit status 0).
  4. The header at lines 71–75 documents exit code 1 for "at least one captured value is missing or unexpected".
  5. The header at lines 99–101 says "Partial output is not a passing run."
  6. **Both promises are false.**

  The operator (or any CI gate that runs the script and checks `$?`) reads `STATUS: PARTIAL` and treats the run as success. The CI chain `bash verify-live-build.sh && deploy` deploys on a partial-verification run.

  The same shape applies to the other two PARTIAL branches (lines 454–455 "no RepoDigest" and 460–461 "bun --revision not captured") and to the `--no-container` mode which always prints PARTIAL because `BUN_REVISION` is set to the literal `"<skipped: --no-container>"` at line 406.

- **Concrete trigger state**: any one of {no RepoDigest, unknown git_sha, empty/skipped bun --revision} in a single run. Exit code is 0 in all three.

- **Fix shape (for ccflare-119)**: set `exit 1` (or non-zero) on any STATUS != OK branch. Remove the trailing `echo OK`. The header already documents the contract; the implementation just needs to honor it.

### C-2. The script cannot distinguish a passing image from three mutually inconsistent captured values

- **Evidence lines**: 382–390, 397–408, 414–428, 454–464
- **Verifier verdict**: HIGH retained (after I downgraded P2-011 to refuted; the underlying inconsistency this would cause is independently re-confirmed by findings C-2a, C-2b, C-2c below)
- **Failure scenario**: The bun#35093 followup — the canonical scenario the script header says it was written to detect — is **labels-vs-binary disagreement**. Labels claimed `8afcd4b45d31`; the binary reported `9b678b407`. The script:
  1. Prints `OCI_LABEL: org.opencontainers.image.revision=8afcd4b45d31` (line 426).
  2. Prints `BUN_REVISION: 9b678b407` (line 408).
  3. **Does not compare them.** Both are non-empty non-MISSING, so all three summary branches at lines 454–463 skip, and the script prints `STATUS: OK` with exit 0.
- **Related sub-findings**:
  - **C-2a — Labels never validated** (verifier P2-008, CONFIRMED MEDIUM): the header at lines 93–95 promises labels "corroborate the /health values" and that disagreement "identifies a mis-build or has been re-tagged." The code at lines 413–427 prints labels and exits. No code path extracts or compares `org.opencontainers.image.revision` against `HEALTH_GIT_SHA`, or `org.opencontainers.image.created` against `HEALTH_BUILD_DATE`. A label/header-baked provenance and a runtime provenance can be arbitrarily inconsistent without the script noticing.
  - **C-2b — IMAGE_REF resolves to current tag, not the running image** (verifier P2-007, CONFIRMED HIGH): line 269 reads `Config.Image` from the container, which is the mutable tag. Line 288 then runs `inspect --format '{{index .RepoDigests 0}}'` on that tag. If `docker pull ccproxy/ccflare:latest` was re-run between container start and script invocation, the digest is for the freshly-pulled image, not for what the container is actually running. The container's immutable `.Image` ID is never read.
  - **C-2c — Most "non-negotiable" values are not actually checked** (verifier V-005, HIGH): the header at lines 83–98 says "Each captured value is non-negotiable" and lists seven checks. The summary at lines 454–463 tests only three: `RAN_WITHOUT_DIGEST`, `HEALTH_GIT_SHA`, `BUN_REVISION`. A response missing `version`, `git_ref`, `build_date`, or a label/layer set of `(none)` can still produce `STATUS: OK`.

- **Fix shape**: at minimum, compare `org.opencontainers.image.revision` against `HEALTH_GIT_SHA` and exit non-zero on mismatch. Capture the container's `.Image` ID (immutable) and compare it against `IMAGE_ID` from the tag-based inspect. Exit non-zero on internal inconsistency.

---

## H — HIGH findings (would misreport under realistic conditions)

### H-1. SSH Docker wrapper loses argument quoting → remote-shell injection via `--container`

- **Evidence lines**: 140, 227–231, 239, plus run_remote at 186–194
- **Verifier verdict**: V-001, HIGH (CONFIRMED)
- **Failure scenario**: In `--ssh` mode, `DOCKER` is the array `(ssh -p ... -o ... user@host docker)`. The script then calls `"${DOCKER[@]}" ps --filter "name=^/${CONTAINER}$" ...`. Locally, the array expansion and double-quoted `${CONTAINER}` are safe — bash treats `CONTAINER` as one argv element. **But the resulting command is `ssh user@host docker ps --filter name=^/<value>$ ...`**, and OpenSSH serializes everything after the destination into a single remote-shell command string. The remote shell parses `--filter name=^/<value>$` as shell tokens: if `<value>` is `ccflare; rm -rf /var/lib/docker; #`, the remote shell sees two commands.

  Concretely, an operator (or a CI matrix that interpolates an environment variable) typing `--container 'ccflare; touch /tmp/pwn'` runs `touch /tmp/pwn` on the deploy host via the SSH session the script just opened. The script then prints `FATAL: no running container named 'ccflare; touch /tmp/pwn'` — a clean failure that hides the side effect.

  The current operator is the asset owner, so this is not a remote-exploitation path. But it is a **CI injection path** if the script is ever wired into a pipeline that interpolates untrusted input.

- **Fix shape**: stop building remote shell commands from operator input. Either (a) avoid `name=^/${CONTAINER}$` and look up the container ID first, then use the container's full hex ID for subsequent commands, or (b) shell-escape every interpolated value before composing the remote command (`printf %q`).

### H-2. `--health-url` in SSH mode curls locally, contradicting the header

- **Evidence lines**: 52–57, 312–339, 342–354
- **Verifier verdict**: V-002, HIGH (CONFIRMED)
- **Failure scenario**: The header at lines 52–57 says "if `--ssh` is set, the script will curl from the remote host". But the implementation only enters the `run_remote` block when `HEALTH_URL` is empty (lines 312–339). When the operator passes `--ssh ccmax --health-url http://127.0.0.1:8080/health`, line 312's `if [ -z "$HEALTH_URL" ]` is false, so the remote block is skipped. Line 342's `if [ "$HEALTH_URL" != "(queried inside remote host)" ]` is true, so line 350 runs `curl -sS --max-time 10 "$HEALTH_URL"` **from the operator's host**, not from `ccmax`.

  Three downstream problems:
  1. `127.0.0.1:8080` from the operator is not necessarily reachable at all.
  2. If the operator's host also has something on port 8080 (a development ccflare, a stale proxy), it returns **the operator's provenance**, which is silently reported as CCMAX's.
  3. If the URL is reachable from both, the operator has no way to know which one was actually queried.

  Combined with **H-1**, an operator who passes `--health-url $(cat somefile)` and `--ssh ccmax` may unintentionally curl a URL that the deploy host would reject.

- **Fix shape**: when `SSH_HOST` is set, always curl from the remote host regardless of `--health-url`. Treat `--health-url` as "the path inside the container, not the URL the operator curls" (which is the actual semantic the header implies).

### H-3. Local port discovery uses host port inside the container namespace

- **Evidence lines**: 314–320, 342–347
- **Verifier verdict**: V-003, HIGH (CONFIRMED, independently re-verified)
- **Failure scenario**: When `--local` is set with a container ID, the script discovers `HOST_PORT` from `HostConfig.PortBindings["8080/tcp"].HostPort` — the host-side mapping (e.g. `18080`). It then constructs `HEALTH_URL="http://127.0.0.1:${HOST_PORT}/health"` and at line 344 runs `docker exec $CONTAINER_ID curl ... "$HEALTH_URL"`.

  Inside the container's network namespace, `127.0.0.1` is the container's own loopback, not the host's. Curl tries to reach `127.0.0.1:18080/health` from inside the container; if the container's own service binds 8080 (not 18080), this fails. The script then prints `FATAL: /health curl inside container failed`.

  The fallback at line 318 (`if [ -z "$HOST_PORT" ]; then HOST_PORT=8080`) only fires if `HostConfig.PortBindings` returned empty. If the container is published as `18080:8080`, the script uses 18080, fails, and the operator gets a non-actionable FATAL.

- **Fix shape**: in `--local` mode, `docker exec` curl should target `http://localhost:8080/health` (or `http://127.0.0.1:8080/health` inside the container's namespace). The host port mapping is irrelevant when curl runs inside the container. Better: `docker exec ... curl http://localhost:8080/health` regardless of `HostConfig`. Even better: use `docker exec --network host` so curl reaches the same loopback as the host sees.

### H-4. Empty `RepoDigests` aborts before the documented `IMAGE_ID` fallback

- **Evidence lines**: 287–302
- **Verifier verdict**: V-004, HIGH (CONFIRMED, independently re-verified)
- **Failure scenario**: For a locally-built image (or any image not pulled with a digest), `.RepoDigests` is an empty array. The Go-template expression `{{index .RepoDigests 0}}` evaluates to the literal string `<no value>` (the canonical Go-template "missing" sentinel). The shell receives `IMAGE_DIGEST="<no value>"`, which is non-empty. The `if [ -z "$IMAGE_DIGEST" ]` check at line 293 is false, so the documented fallback at lines 293–302 (`IMAGE_ID`, `RAN_WITHOUT_DIGEST=1`) never runs.

  In practice this is masked because Go templates with `<no value>` may also cause `docker inspect` to exit non-zero on some template engines; but on modern Docker (≥ 20.10) the template evaluates and the command exits 0, leaving `IMAGE_DIGEST="<no value>"` in the script. The summary check at line 454 evaluates `RAN_WITHOUT_DIGEST=0` and prints `STATUS: OK` with `IMAGE_DIGEST: <no value>`, exit 0. The operator has no way to detect this from the report.

- **Fix shape**: either (a) check `IMAGE_DIGEST` for `<no value>` in addition to empty, or (b) use a template that returns an empty string for missing arrays (e.g. `{{with index .RepoDigests 0}}{{.}}{{end}}`).

### H-5. Container name regex injection via unescaped metacharacters

- **Evidence lines**: 140, 239
- **Verifier verdict**: V-009, MEDIUM (CONFIRMED, I retain MEDIUM — this is one keystroke away from HIGH if Docker Compose ever ships a `.` in a service name)
- **Failure scenario**: Container names may contain `.` (Docker Compose projects often use `<project>.<service>` or `<project>-<service>.1`). The filter regex `name=^/${CONTAINER}$` treats `.` as "any character", so a name like `ccflare.prod` matches `ccflareXprod`. Combined with `head -n 1`, the wrong container is selected with confidence.

  Concrete: operator passes `--container ccflare.prod` to verify the production instance. A non-prod instance `ccflareXprod` (perhaps an old canary) matches first; the script prints `CONTAINER_ID: <old-canary-id>` and proceeds to query that container's health, image, labels, and bun revision.

- **Fix shape**: replace `.` and any other regex metacharacters in `${CONTAINER}` before composing the filter (e.g. `CONTAINER_ESC=$(printf '%s' "$CONTAINER" | sed 's/\./\\./g')`), OR switch to a name lookup that does not use a regex filter (`docker ps --filter "name=$CONTAINER" --format ... --no-trunc | head -n 1` with exact-name matching, or `docker inspect` on a candidate).

### H-6. SSH `StrictHostKeyChecking=accept-new` weakens first-connection provenance authenticity

- **Evidence lines**: 188, 227
- **Verifier verdict**: V-013, MEDIUM (CONFIRMED, I retain MEDIUM — defensible in a LAN-only deployment but worth flagging)
- **Failure scenario**: The script opens two SSH paths (`run_remote` and the `DOCKER` array) to the deploy host with `accept-new`. On a first connection, OpenSSH trusts the presented host key without out-of-band verification. An attacker who can MITM the first SSH session — for example, a compromised LAN switch, a malicious container on a shared bridge, an internal attacker — can return fabricated `docker ps`/`docker inspect`/`curl` output and the script will accept it. The attacker's key is also pinned to `~/.ssh/known_hosts`, so subsequent runs continue to trust it.

  For an operator running this once, manually, against a known LAN host, this is probably acceptable. For a script destined for a CI matrix that may be invoked from any host, it is a real provenance hole.

- **Fix shape**: accept `--known-hosts-file` and `--strict-host-key-checking` arguments (or document that the operator MUST pre-populate `~/.ssh/known_hosts`). At minimum, add a sanity check after the first connection: if the host key was newly accepted (check `~/.ssh/known_hosts` mtime), print a warning.

### H-7. HTTP error responses are accepted as successful `/health` requests

- **Evidence lines**: 329–331, 344, 350, 358–390
- **Verifier verdict**: V-011, MEDIUM (CONFIRMED, I upgrade to HIGH — combined with H-2 this is a clean false-positive path)
- **Failure scenario**: Every curl invocation uses `-sS` (silent, show errors) but neither `--fail` nor `--fail-with-body`. curl returns exit 0 on HTTP 2xx, 3xx, 4xx, and 5xx responses (with `-sS`, only network errors fail). If `/health` returns 503 with a JSON body containing plausible provenance fields (a misconfigured upstream, an upstream proxy returning a cached 503 page), the script parses the body, extracts `git_sha` (whatever it says), and may print `STATUS: OK`.

  Combined with **H-2** (`--health-url` curls locally in SSH mode), the script can return a successful-looking report from a service that was never actually queried.

- **Fix shape**: add `-f` to every curl invocation, or use `-w '%{http_code}'` and require `200` before parsing. The current JSON-validation FATAL does not catch this because the body is JSON either way.

### H-8. `BUN_REVISION` accepted verbatim, no shape validation

- **Evidence lines**: 396–408, 460
- **Verifier verdict**: P2-002, LOW (downgraded from MEDIUM)
- **Failure scenario**: The script checks only `[ -z "$BUN_REVISION" ]` on the captured output. If the binary's stdout is a multi-line banner ("Bun is a fast all-in-one JavaScript runtime\n1.1.34+abcdef"), an error message ("bun: command not found"), or any non-empty string, the script accepts it. `STATUS: OK` can fire with `BUN_REVISION: 1.1.34` (a version, not a revision).

  This is **LOW** because the summary check at line 460 catches the empty case, and a non-empty output is at least a real signal — but the header at lines 88–92 calls this "the ground truth. Labels lie; binaries do not," which overpromises.

- **Fix shape**: validate `BUN_REVISION` matches `^[a-f0-9]{7,40}(\+[a-zA-Z0-9_-]+)?$` (Bun's revision format). Exit non-zero on mismatch.

---

## M — MEDIUM findings

### M-1. Documented required and mutually exclusive arguments are not enforced

- **Evidence lines**: 34–48, 110–114, 170–174
- **Verifier verdict**: V-006, MEDIUM (CONFIRMED)
- **Failure scenario**: The header at lines 34–48 says `--ssh` and `--local` are "one of, required" and that target arguments are "required when --ssh". The implementation at line 170 only checks "at least one of `--ssh` or `--local`". Three reachable footguns:
  1. `--local --ssh ccmax` — accepted; `LOCAL=1` is checked first and wins; the SSH host is silently ignored.
  2. `--ssh ccmax` without `--container` — accepted; `CONTAINER` defaults to `"ccflare"` and the script searches for it; if the actual container is named `ccproxy2` (as on CCMAX per the report), the script reports "no container named 'ccflare'" with a candidate suggestion that the operator must copy-paste back into a second invocation.
  3. `--container ccmax --no-container` — accepted; `--container` is silently ignored because `--no-container` is checked first.

- **Fix shape**: explicit argument-validation function that rejects the three combinations above and prints a clear error with exit 64.

### M-2. `--container <id>` cannot match because the filter searches names only

- **Evidence lines**: 44–45, 239
- **Verifier verdict**: V-007, MEDIUM (CONFIRMED)
- **Failure scenario**: The header at line 44 says `--container NAME` accepts "Docker container name (or id)". The implementation at line 239 uses `docker ps --filter "name=^/${CONTAINER}$"`, which matches names only. A valid full or short container ID passed via `--container` is rejected as "no running container named '<id>'". The candidate suggestion at lines 250–251 is the first ccflare-named container — not the one the operator actually wanted.

- **Fix shape**: detect whether `CONTAINER` looks like a hex ID (`^[a-f0-9]{12,64}$`) and use `docker ps --no-trunc --filter "id=^/${CONTAINER}$"` in that case.

### M-3. `--no-container` is not actually an offline image-audit mode

- **Evidence lines**: 46–48, 311–379, 405–406, 460–466
- **Verifier verdict**: V-008, MEDIUM (CONFIRMED)
- **Failure scenario**: The header at lines 46–48 advertises `--no-container` for "offline registry audits" of the local image cache. The implementation still requires `/health` (step 4 always runs) and requires `jq`. If the cache is genuinely offline, the script fails at step 4 with a non-actionable FATAL. If health is reachable, `BUN_REVISION` is forced to `"<skipped: --no-container>"` at line 406, which trips the PARTIAL branch at line 460, which (per **C-1**) still exits 0. The "offline audit" scenario is impossible to pass cleanly.

- **Fix shape**: when `--no-container` is set, also skip the `/health` step (or make it skippable via `--skip-health`).

### M-4. Multiline values can forge or corrupt the report

- **Evidence lines**: 382–390, 397–407, 422–427, 441–445
- **Verifier verdict**: V-014, MEDIUM (CONFIRMED)
- **Failure scenario**: Health fields are emitted with `jq -r` (raw), bun output captures `2>&1`, and label values are printed raw. A newline in `git_sha` (impossible per OCI label spec, but possible if `/health` is buggy or replaced by a malicious proxy), in bun output (possible if the binary wraps with `\n`-separated banners), or in a label value (impossible by spec but defensively worth guarding) can produce unlabeled lines or inject a second `STATUS:` line.

  Exact-string summary checks treat the multiline value as non-missing, so the report can still end in `STATUS: OK` with the original status on line N and a forged `STATUS: OK` on line N+1.

- **Fix shape**: replace newlines and other control characters with `\n` before printing; or use `jq -j` (joined) and require single-line output.

### M-5. Internal hostnames (ccmax, dellsrv, ccproxy2) and `*.zp.digital` are in the header

- **Evidence lines**: 7, 39, 113–121
- **Verifier verdict**: P1-002, LOW (downgraded from MEDIUM)
- **Failure scenario**: The script header at lines 7 and 39 names three internal hosts (`ccproxy2 / ccmax / dellsrv`) and references the private zone `*.zp.digital`. The `usage()` function at lines 117–120 prints the entire header on `--help`, so every invocation of `--help` exposes these names. If the script is shared in a public PR, an external contributor learns the internal LAN topology.

  This is **LOW** because the names are topology, not credentials, and a public PR reviewer would already see them in commit history — but the script's claim of being a "one-shot manual verifier" implies portability, which the current header contradicts.

- **Fix shape**: generalize the header (`the deploy host`, `the production container`) and move LAN-specific examples to an internal-only comment block that `usage()` skips.

### M-6. `--no-container` image selection can match a stale ccflare image

- **Evidence lines**: 270–272
- **Verifier verdict**: P1-005, LOW (CONFIRMED)
- **Failure scenario**: When `--no-container` is set, `IMAGE_REF=$(docker images --no-trunc --format '{{.Repository}}:{{.Tag}}' | grep -E 'ccflare' | head -n 1)` picks the first `docker images` row whose repository or tag contains `ccflare`. Any stale image (`ccmax/ccflare:backup-2024-01-01`, `ccflare-experimental:latest`) is selected. Subsequent steps report digest, labels, layers for the stale image, not for any specific running container.

  The header at lines 46–48 acknowledges this mode is for "offline registry audits" — so a wrong-but-documentable selection is acceptable. But combined with **M-3** (the mode also runs health and exits 0 on PARTIAL), the operator gets a confident-looking report against a stale image.

---

## L — LOW findings

### L-1. SSH `StrictHostKeyChecking=accept-new` writes to operator's `~/.ssh/known_hosts`

- **Verifier verdict**: P1-003, LOW (CONFIRMED)
- **Failure scenario**: First SSH to a new host appends the host key to the operator's local `~/.ssh/known_hosts`. This is a side effect on the operator's host, not on production. Expected behavior for any SSH-based tool. Worth documenting.

### L-2. `--ssh-key` path is not validated for existence/readability

- **Evidence lines**: 128–130, 188–192
- **Failure scenario**: `--ssh-key /nonexistent/path` is accepted; the failure surfaces inside ssh with `Permissions ... are too open` or `No such file or directory`, after the script has already printed the prelude and started step 1.
- **Fix shape**: `if [ ! -r "$SSH_KEY" ]; then echo "FATAL: --ssh-key $SSH_KEY not readable" >&2; exit 2; fi`.

### L-3. Missing option values exit 1 instead of documented 64

- **Evidence lines**: 71–75, 123–156
- **Verifier verdict**: V-010, LOW (CONFIRMED)
- **Failure scenario**: Invoking a valued flag without its argument (e.g. `verify-live-build.sh --ssh`) triggers bash's `${2:?...}` expansion error under `set -u` and exits 1 before the parser can print usage or exit 64. The header documents exit 64 for invalid arguments.
- **Fix shape**: explicit argument-count check before the `case` block.

### L-4. SSH and authentication failures are misreported as "docker not found"

- **Evidence lines**: 222–225
- **Verifier verdict**: V-012, LOW (CONFIRMED)
- **Failure scenario**: A DNS, network, host-key, or authentication failure in the initial remote probe is stderr-suppressed (line 223 ends with `2>/dev/null`) and enters the same branch as `command -v docker` returning false. The operator sees `FATAL: docker not found on remote host <host>` even when SSH never established a session.
- **Fix shape**: separate the "ssh failed" FATAL from the "docker not on remote" FATAL.

### L-5. `set -e` does not observe jq failures inside process substitutions

- **Evidence lines**: 422–427, 441–445
- **Verifier verdict**: V-015, LOW (CONFIRMED)
- **Failure scenario**: If label or RootFS JSON has an unexpected shape, `jq` in a process substitution (`< <(echo "$LABELS_JSON" | jq -r ...)`) can fail while the parent `while` loop simply receives no rows and returns success. The script proceeds to a summary that does not require labels or layers (per **C-2c**), and the operator has no FATAL signal.
- **Fix shape**: capture the process substitution exit status separately or `set -o pipefail` around the `jq` invocation explicitly.

### L-6. `--no-trunc` flag requires Docker ≥ 1.13

- **Evidence lines**: 239, 248, 272
- **Failure scenario**: `--no-trunc` was added to `docker ps` and `docker images` in Docker 1.13 (Jan 2017). Unlikely to be a real issue on CCMAX, but worth a guard.
- **Fix shape**: at script start, `docker version --format '{{.Server.Version}}'` and warn if `< 1.13`.

### L-7. `jq -r` requires jq 1.5+

- **Evidence lines**: 382–385, 427, 445
- **Failure scenario**: `--raw-output` was the default in jq 1.4. RHEL 7 ships jq 1.4 by default; `jq -r` is a no-op on 1.5+. Unlikely on a modern host but worth a guard.

### L-8. `${USER:-root}` default may pick the wrong ssh user

- **Evidence lines**: 110
- **Failure scenario**: When invoked from a container or as a service, `$USER` may be empty or `node` or `runner`. The default `root` may not have docker access. The operator gets a confusing auth failure.
- **Fix shape**: require `--ssh-user` in `--ssh` mode and exit 64 if missing.

---

## REFUTED findings (verified not present in the current script)

The following were raised by the initial reviewers but re-checking the cited line ranges shows they do not apply to the current implementation:

- **P1-001** (tee -a always appends): REFUTED. Line 180 explicitly truncates with `: > "$OUTPUT_FILE"` before line 181 opens tee with `-a`. The current sequence is functionally correct.
- **P2-001** (grep fallback silently picks wrong container): REFUTED. Lines 244–255 store the candidate in `GUESS` only as a hint printed to the operator; the script always `exit 2`s. It cannot silently continue with a guessed container.
- **P2-004** (entire CCMAX fleet predates #109): REFUTED. This is an external claim about a deployment; the script contains no fleet-version assertion. The underlying PARTIAL-with-exit-0 behavior is captured by **C-1**.
- **P2-005** (IMAGE_ID is not a meaningful fingerprint): REFUTED. IMAGE_ID is the sha256 of the image config, which binds rootfs diff IDs. Two builds with identical content share it intentionally; that is its purpose as a fallback fingerprint. The script explicitly labels it as fallback.
- **P2-009** (layer digests are unfulfilled operator-side comparison): REFUTED. The header at lines 95–97 conditions the comparison on a second source the operator has. Printing the data needed for an external manual comparison fulfills the stated behavior.
- **P2-011** (three values should be textually equal): REFUTED. Manifest digest, source git SHA, and bun revision are identifiers from different namespaces. The promised comparison is OCI-label provenance vs /health (captured by **C-2a**) and mutable-tag-vs-running-container (captured by **C-2b**).
- **P1-008** (Docker-only constraint not documented): REFUTED. The header repeatedly documents Docker-specific invocation, and the script prints a FATAL with `command -v docker` discovery.

---

## Read-only claim — full audit

### Mutating subcommands invoked (verifier-confirmed inventory)

- `docker ps --no-trunc --filter "name=^/${CONTAINER}$" --format ...` (read-only)
- `docker inspect --format ... <image-or-container>` (read-only)
- `docker images --no-trunc --format ...` (read-only)
- `docker exec CONTAINER_ID curl -sS --max-time 10 http://127.0.0.1:8080/health` (read-only HTTP GET inside container)
- `docker exec -u ccflare CONTAINER_ID bun --revision` (read-only; bun --revision prints version and exits)
- `ssh ... 'command -v docker >/dev/null 2>&1'` (read-only)
- `ssh ... docker ps / inspect / images / exec ...` (read-only)
- `curl -sS --max-time 10 $HEALTH_URL` (read-only HTTP GET when operator supplies a URL)
- `jq` (read-only)
- `head`, `grep`, `sed`, `date`, `hostname`, `command -v` (read-only)

### Side effects observed

- Writes to the operator-supplied `$OUTPUT_FILE` path (via `: > "$OUTPUT_FILE"` then `tee -a "$OUTPUT_FILE"`) — operator-chosen, documented.
- Appends to the operator's local `~/.ssh/known_hosts` on first SSH (StrictHostKeyChecking=accept-new) — local to operator's machine, expected behavior.
- The script **does not** write to the production host, container image cache, container filesystem, image labels, `/tmp`, `/var/lib/docker`, `/var/log`, `systemd-journald`, `/proc`, `/sys`, or any docker layer cache.
- The script **does not** restart, pause, kill, stop, rm, rmi, tag, pull, push, build, run, update, network connect/disconnect, or volume-mount any container.

### Read-only verdict

**PROVEN** for the production target. **NOT proven** for the operator's local machine, which gets a known_hosts append and an optional `-o` file write — both expected and documented in the header.

### Internal identifiers found

- `ccmax` (lines 7, 39)
- `dellsrv` (line 7)
- `ccproxy2` (lines 7, 39)
- `*.zp.digital` (line 7)
- `bun#35093` (line 91) — upstream issue reference, OK to share in public
- `ao-company #110` (line 4) — internal tracker reference; OK if the repo is private

### Network targets attempted (from inside the script)

- SSH to `${SSH_USER}@${SSH_HOST}:${SSH_PORT}` — operator-supplied.
- HTTP GET to `${HEALTH_URL}` — operator-supplied or auto-derived.
- The script **does not** attempt to reach any host by name beyond what the operator provides.

---

## Recommended priorities for ccflare-119

If ccflare-119's hardening branch addresses only the top of this list, the rest can wait:

1. **C-1** — Fix the exit-code semantics. Non-negotiable. Without this, the script's contract is broken.
2. **H-1** — Fix the SSH/Docker wrapper injection. One-line fix (`printf %q` on operator input before remote-shell composition).
3. **H-2 + H-7** — In SSH mode, always curl from the remote host, and require HTTP 200 before parsing.
4. **H-3** — Fix the local port-discovery namespace bug.
5. **H-4** — Fix the `<no value>` Go-template fallback (use `{{with index ...}}{{.}}{{end}}`).
6. **C-2a + C-2b + C-2c** — Cross-validate labels vs /health, use container `.Image` ID, require non-trivial label/layer sets.
7. Everything else.

---

## What this review did NOT check

- **The companion script `scripts/provenance-canary.sh`** — different file, different contract (comparator vs capture). Not in scope.
- **The Dockerfile** — provenance labels and env injection are documented and consistent with the /health handler; no review performed.
- **ccflare-119's hardening branch** — does not exist on the remote yet (`ao/ccflare-119/root` exists locally but has not committed any changes to `verify-live-build.sh`). This review is against the pre-hardening tip only.
- **Runtime execution against CCMAX** — explicitly excluded by the task brief ("Do not attempt to reach ccmax or any *.zp.digital host — DNS closed by design, no workarounds"). All findings are static analysis.
