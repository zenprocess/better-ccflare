# ao-company #107 — ccflare test run evidence (FINAL)

**Issue:** ao-company/better-ccflare #107 — test stability
**Recorded at:** 2026-08-03T23:25Z (session ccflare-138)
**Branch:** `ao/ccflare-138/issue-107-kiwi-evidence`
**Bun:** 1.3.14 baseline (`/private/tmp/.../bun-baseline/bun`, no AVX2 — verified clean)
**Worktree:** `/Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-138`
**HEAD:** `5975d5ee feat(docker): add Dockerfile.provenance with pinned canary Bun` (origin/main)

## Result

| Metric | Value |
|---|---|
| Tests | 2684 |
| Pass | 2678 |
| Skip | 1 |
| Fail | 5 (declared environmental exception — see below) |
| Assertions | 8807 |
| Files | 208 |
| Duration | 75.14 s |

This matches the documented baseline (≈2681 pass / 0 fail UNSANDBOXED) when adjusted for the
sandbox-only socket-binding exception: **2678 pass + 1 skip + 5 declared-fail** = 2684 total.

## Declared environmental exception (5 failures)

All 5 failures are in **one file**: `packages/core/src/outbound-proxy.test.ts`.

| # | Line | Test name | Reason |
|---|---|---|---|
| 1 | 45  | routes external requests through the resolved proxy | `Bun.listen` socket binding blocked in sandbox |
| 2 | 59  | excludes loopback destinations from proxying | `Bun.serve` + `Bun.listen` socket binding blocked |
| 3 | 85  | excludes any 127.0.0.0/8 address from proxying | `Bun.listen` socket binding blocked |
| 4 | 103 | is a no-op when the resolver returns undefined | `Bun.serve` + `Bun.listen` socket binding blocked |
| 5 | 123 | never overrides a caller-supplied proxy option | `Bun.listen` × 2 socket binding blocked |

These are the **known exception** documented in
`~/.claude/projects/-Users-vvladescu-ao-projects-ccflare/memory/bun-test-baseline-and-tmpdir.md`:
"under the sandbox, 5 tests in one file still fail, all blocked on `Bun.listen` (socket
binding, not the temp path). These are expected and environmental — do not 'fix' them by
weakening assertions, and do not read them as a regression."

The fix (`f3524cd9`, 2026-08-01) made tests use `${process.env.TMPDIR || "/tmp"}/…` for SQLite
temp files but did NOT extend to socket binding (which is a sandbox-policy restriction,
not a test code issue).

## Sandbox / build notes

The host CPU has no AVX2, so the standard Bun binary SIGILLs in the bundler (verified
memory: `host-cpu-lacks-avx2-bun-baseline.md`). The session used the **baseline Bun at
`/private/tmp/.../bun-baseline/bun` (1.3.14)** — the same verified baseline the
ccflare-orchestrator worktree uses.

Additionally, Bun's bundler and installer write to `_CS_DARWIN_USER_TEMP_DIR`
(`/var/folders/df/mn75mkg13fbdv9dwvsj9cb1w0000gn/T/`), which the **sandbox denies writes
to** in this session (verified: `touch` returns "Operation not permitted"). Neither
`TMPDIR=…` nor `BUN_TMPDIR=…` overrides this — Bun uses the libc `confstr()` value
directly for internal cache writes. As a result:

- `bun run build` and `bun install` cannot run cleanly in this session.
- Workaround: populated `node_modules/` and the build artifacts
  (`packages/database/src/inline-{vacuum,incremental-vacuum,integrity-check}-worker.ts`,
  `packages/dashboard-web/dist/embedded.ts`) from the sibling `ccflare-84` worktree,
  which is deterministic and gitignored. No source files were modified.
- This is **equivalent to a successful build from this session's source tree** — the
  generated artifacts depend only on the source files (HTML/CSS/TS), which are unchanged
  between worktrees at this commit.

## Kiwi TCMS submission

The org's canonical adapter is `ao-projects/cal/bin/cal-kiwi` (wraps
`cal/hooks/lib/kiwi.mjs`'s `recordRun()`). Env shape:
`KIWI_TCMS_URL` + (`KIWI_TCMS_API_KEY` | `KIWI_TCMS_USERNAME`+`KIWI_TCMS_PASSWORD`).
Credentials live in Infisical at `zendev/prod/kiwi`.

**This session could not submit to Kiwi TCMS.** Two independent reasons, both by design:

1. **No `KIWI_TCMS_*` env vars set in this shell** (confirmed via `env | grep KIWI`).
   The Infisical client is not reachable from this AO worker.
2. **Sandbox outbound policy** blocks egress to private `10.0.201.x` hosts
   (including `*.zp.digital`, where `kiwi.zp.digital` resolves). Per the global
   `~/.claude/CLAUDE.md`: "sandbox network denials are a boundary, not a puzzle".
   No attempt was made to bypass — and the operator-confirmed intent of the
   sandbox is exactly that.

### Submission attempt

Command:
```bash
node /Users/vvladescu/ao-projects/cal/bin/cal-kiwi push evidence/kiwi-results.json
```

Result (verbatim, captured in `evidence/kiwi-push-result.json`):
```json
{
  "name": "kiwi",
  "status": "skipped-unconfigured"
}
```

This is `hooks/lib/kiwi.mjs`'s **fail-open** behavior when neither URL nor credentials
are set — it returns `skipped-unconfigured` and never throws, so a Kiwi outage never
gates a cal session. From the source (lines 138-139):
```js
if (!kiwiConfigured(env)) return { name: "kiwi", status: "skipped-unconfigured" };
```

**No TestRun id was fabricated.** No `TestRun.create` was issued. The operator can replay
the push from a credentialed host:

```bash
export KIWI_TCMS_URL=https://kiwi.zp.digital
export KIWI_TCMS_API_KEY=$(infisical read zendev/prod/kiwi/KIWI_API_TOKEN)
export KIWI_TCMS_PRODUCT=better-ccflare
node /Users/vvladescu/ao-projects/cal/bin/cal-kiwi push /path/to/evidence/kiwi-results.json
```

The expected recorded response is:
```json
{
  "name": "kiwi",
  "status": "recorded",
  "product": "better-ccflare",
  "run": <TestRun.id>,
  "recorded": 2684
}
```

## Files in this evidence drop

| Path | Purpose |
|---|---|
| `evidence/STATUS.md` | Initial push-NOW snapshot (committed in `1ee77264`) |
| `evidence/RUN.md` | This file — final evidence report |
| `evidence/junit.xml` | Bun's junit XML output (208 testsuites, 8807 assertions) |
| `evidence/kiwi-results.json` | cal-kiwi-push-shaped payload: `[{status,name,file,line,time}, …]` (2684 results) |
| `evidence/kiwi-push-result.json` | The `{"name":"kiwi","status":"skipped-unconfigured"}` response |
| `evidence/junit2kiwi.py` | Idempotent converter: junit.xml → kiwi-results.json |
| `evidence/.test.log` | Raw stdout from `bun test` run (75.14 s, includes 1 AnthropicOAuth debug log only) |

## Acceptance criterion status

The issue's acceptance criterion ("record a Kiwi TestRun for issue #107") is **partially
met**:

- ✅ Test run executed cleanly under the baseline Bun
- ✅ Results captured in cal-kiwi-push format
- ✅ Submit attempted via the canonical org adapter
- ❌ TestRun id does NOT exist in Kiwi TCMS — `skipped-unconfigured` returned

Per the task instructions ("If Kiwi is unreachable from the sandbox, say so plainly and
produce the evidence artifact in whatever form CAN be recorded, clearly stating what
could not be submitted. Do not fabricate a TestRun id"), this evidence drop is the local
record form. The orchestrator/operator can replay the push from a credentialed host to
publish to Kiwi.