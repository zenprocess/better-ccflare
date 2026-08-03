# ao-company #107 — Kiwi TestRun evidence (status snapshot)

- **Recorded at:** 2026-08-03T20:12:44Z
- **Branch:** `ao/ccflare-138/issue-107-kiwi-evidence`
- **Session:** ccflare-138 (AO worker)
- **Source:** `ao/ccflare-138/root` (clean, no pre-existing uncommitted work)
- **Purpose:** Pushed early per orchestrator directive — proves work exists even if this worker is reaped before the TestRun is fully captured.

## Headline

**Kiwi TCMS is NOT reachable from this AO worker session.** This is the expected outcome
per the operator decision documented in `~/.claude/CLAUDE.md`: the sandbox outbound policy
is a deliberate boundary, not a bug to route around. No TestRun id is fabricated.

## What was done

1. **Discovery** — Identified the canonical org submission mechanism: the `cal-kiwi` CLI at
   `ao-projects/cal/bin/cal-kiwi`, wrapping `ao-projects/cal/hooks/lib/kiwi.mjs`'s
   `recordRun()`. Auth shape: `KIWI_TCMS_URL` + (`KIWI_TCMS_API_KEY` |
   `KIWI_TCMS_USERNAME`+`KIWI_TCMS_PASSWORD`); credentials live in Infisical at
   `zendev/prod/kiwi`. Submission shape: `cal-kiwi push <results.json>` with
   `[{status: "pass"|"fail"|"skip"}, ...]` per result.

2. **Probe** — `cal-kiwi ping` (no env override) returned:
   `kiwi: not configured — set KIWI_TCMS_URL + KIWI_TCMS_API_KEY (or USERNAME/PASSWORD)`
   No `KIWI_*` env vars are set in this shell. No Infisical client is reachable from the
   sandbox. Kiwi TCMS at `https://kiwi.zp.digital` (per argus's documented config) is on
   the sandbox deny-list by operator policy.

3. **Build** — Attempted `bun run build` with the verified baseline Bun at
   `/private/tmp/.../bun-baseline/bun` (1.3.14, no-AVX2). The dashboard bundler
   (`packages/dashboard-web/build.ts`) failed with `bun is unable to access tempdir:
   AccessDenied` even with `TMPDIR` exported to a sandbox-writable path. **Build is being
   debugged separately** — the failure is in the bundler's internal cache dir, not in test
   code.

4. **Test discovery** — Located the 5-test file that fails under sandbox per the known
   exception: `packages/core/src/outbound-proxy.test.ts` (lines 45, 59, 85, 103, 123 —
   every case calls `Bun.listen` or `Bun.serve` on `127.0.0.1`). Memory
   `bun-test-baseline-and-tmpdir.md` confirms these are environmental (sandbox socket
   binding), not regressions.

## What could not be submitted

| Step | Status | Reason |
|---|---|---|
| `cal-kiwi ping` | FAIL | No `KIWI_TCMS_*` env in this shell |
| Kiwi API call | NOT ATTEMPTED | Would fail at the network layer anyway (sandbox deny) |
| Kiwi TestRun creation | NOT ATTEMPTED | Depends on the above |
| TestRun id | **NONE FABRICATED** | — |

## Acceptance criterion not yet met

Issue ao-company #107 acceptance requires a Kiwi TestRun recording the run. Per the
task instructions ("If Kiwi is unreachable from the sandbox, say so plainly and produce
the evidence artifact in whatever form CAN be recorded, clearly stating what could not
be submitted. Do not fabricate a TestRun id."), this snapshot is the local-record form.

## Next steps in this session

1. Make the build pass (debug the bundler tempdir AccessDenied — likely a separate
   `BUN_TMPDIR` or a sandbox config gap, not the test `/tmp` path).
2. Run the full suite under TMPDIR + baseline Bun.
3. Capture per-test results as JSON.
4. Re-attempt `cal-kiwi push` with whatever env is available. Expect
   `skipped-unconfigured` — record that as the official outcome.
5. Update this STATUS.md with the full pass/fail counts + the 5 declared socket-binding
   exceptions. Commit + push again.

The operator can then replay the recorded push from a credentialed box to actually
publish to Kiwi.