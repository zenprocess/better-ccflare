# Task B — Minimax usage fetcher hardening (F5 + F6)

**Branch:** `fix/minimax-usage-hardening` (off `upstream/main` + cherry-picked
PR #347 lineage: `03cc6deb`, `8a779b38`, `42dd946f`).

**Scope:** review findings F5 and F6 only. PR #347 commits are unmodified.
This branch is a separate follow-up; the existing PR #347 stays open and
mergeable-clean per the orchestrator's instruction.

---

## F5 (Medium) — negative-space status check

**Fix:** `parseMinimaxTokenPlanResponse` no longer uses a negative
`statusCode !== 0` test. It validates against a positive allowlist
(`MINIMAX_TOKEN_PLAN_SUCCESS_STATUS_CODES = [0]`) and distinguishes:

- **Success** — status_code is in the allowlist (`0` today). Continue parsing.
- **Known failure** — status_code is in `MINIMAX_TOKEN_PLAN_KNOWN_FAILURE_STATUS_CODES`
  (`{1001, 1004}` today). Log as `known error base_resp.status_code=N`. Return null.
- **Unrecognized non-success** — non-zero and in neither set. Log as
  `unrecognized non-zero base_resp.status_code=N; ...`. Return null.

The 200-with-`base_resp.status_code=1004` case continues to be handled
correctly (it was never the regression — the review confirmed that already);
the change is about preventing a future success code from being silently
misread as a failure.

**Tests added (4):**
- `pins the success status_code allowlist to exactly [0] today`
- `includes 1001 (quota) and 1004 (auth) in the known-failure set`
- `returns null AND logs as a known error when base_resp.status_code is in the known-failure set`
- `returns null AND logs as unrecognized when base_resp.status_code is a non-zero value outside both sets`

---

## F6 (Medium) — poll interval can undercut the request timeout

**Fix:** `bootstrapMinimaxUsagePolling` now clamps the configured interval up
to `MINIMAX_USAGE_REQUEST_TIMEOUT_MS` (5000 ms) before forwarding it to
`usageCache.startPolling`. The clamp lives in an exported helper
`clampMinimaxPollingInterval` and emits a single WARN the first time it
fires in a process. The WARN names both the offending configured value and
the clamp target so an operator tailing logs sees why their setting did not
take effect. A subsequent WARN at the same call site would spam on every
Minimax account on every restart and drown real signals.

The `MINIMAX_USAGE_REQUEST_TIMEOUT_MS` constant is now exported from
`@better-ccflare/providers` so the bootstrap helper imports the same number
the request-side uses — a future bump to the timeout only requires editing
one constant.

**Tests added (5):**
- `clamps an interval below the request timeout up to the timeout`
- `does NOT clamp an interval that is already >= the request timeout`
- `logs WARN exactly once when clamping fires (silent clamping is its own bug)`
- `does NOT log a clamp WARN when the configured interval is already >= the request timeout`
- `clampMinimaxPollingInterval` describe block: returns the timeout for sub-timeout inputs,
  returns the input unchanged for input >= timeout

---

## Acceptance

```
$ bun test packages/providers/src/__tests__/minimax-usage-fetcher.test.ts apps/server/src/server.test.ts
bun test v1.3.2 (b131639c)

apps/server/src/server.test.ts:
⚠️  Dashboard assets not found - dashboard will be disabled

 44 pass
 0 fail
 124 expect() calls
Ran 44 tests across 2 files. [386.00ms]
```

Both files green. Provider suite 19/19 (was 15 — +4 F5 tests). Server suite
25/25 (was 19 — +6 F6 tests, including the standalone clamp helper).

Note: a full `bun test` from repo root shows 3 unrelated pre-existing
failures (CLI Security `should sanitize error messages` 5s timeout;
AgentRegistry workspace persistence tests failing on `private/var` vs `var`
path mismatch on macOS) and 11 unrelated pre-existing database-close
unhandled errors. None of those touch the minimax code path or any file I
modified. They predate this branch.

---

## Mandatory Negative Controls

### F5 (revert → RED → restore → GREEN)

**State 1 — F5 intact (baseline GREEN):**

```
$ bun test packages/providers/src/__tests__/minimax-usage-fetcher.test.ts
bun test v1.3.2 (b131639c)

 19 pass
 0 fail
 56 expect() calls
Ran 19 tests across 1 file. [43.00ms]
```

**State 2 — F5 reverted (RED):**

Reverted the parser branch to `statusCode !== 0` (the pre-fix logic). The
"known error" and "unrecognized" framing disappears; both new tests fail:

```
$ bun test packages/providers/src/__tests__/minimax-usage-fetcher.test.ts
bun test v1.3.2 (b131639c)

packages/providers/src/__tests__/minimax-usage-fetcher.test.ts:
238 | 			const knownWarn = warnEvents.find(
239 | 				(e) =>
240 | 					e.msg.includes("known error") &&
241 | 					e.msg.includes("base_resp.status_code=1001"),
242 | 			);
243 | 			expect(knownWarn).toBeDefined();
                           ^
error: expect(received).toBeDefined()

Received: undefined

      at <anonymous> (/Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-55/packages/providers/src/__tests__/minimax-usage-fetcher.test.ts:243:22)
(fail) Minimax usage fetcher > returns null AND logs as a known error when base_resp.status_code is in the known-failure set [0.84ms]
291 | 			const unrecognizedWarn = warnEvents.find(
292 | 				(e) =>
293 | 					e.msg.includes("unrecognized") &&
294 | 					e.msg.includes("base_resp.status_code=5"),
295 | 			);
296 | 			expect(unrecognizedWarn).toBeDefined();
                                  ^
error: expect(received).toBeDefined()

Received: undefined

      at <anonymous> (/Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-55/packages/providers/src/__tests__/minimax-usage-fetcher.test.ts:296:29)
(fail) Minimax usage fetcher > returns null AND logs as unrecognized when base_resp.status_code is a non-zero value outside both sets [0.32ms]

 17 pass
 2 fail
 54 expect() calls
Ran 19 tests across 1 file. [47.00ms]
```

**State 3 — F5 restored (GREEN):**

```
$ bun test packages/providers/src/__tests__/minimax-usage-fetcher.test.ts
bun test v1.3.2 (b131639c)

 19 pass
 0 fail
 56 expect() calls
Ran 19 tests across 1 file. [43.00ms]
```

### F6 (revert → RED → restore → GREEN)

**State 1 — F6 intact (baseline GREEN):**

```
$ bun test apps/server/src/server.test.ts
bun test v1.3.2 (b131639c)

apps/server/src/server.test.ts:
⚠️  Dashboard assets not found - dashboard will be disabled

 25 pass
 0 fail
 68 expect() calls
Ran 25 tests across 1 file. [363.00ms]
```

**State 2 — F6 reverted (RED):**

Reverted `bootstrapMinimaxUsagePolling` to pass `intervalMs` straight
through (no clamp call). The "logs WARN exactly once" test sees no WARN,
and the "clamps below the timeout" test sees the raw 1000 ms forwarded:

```
$ bun test apps/server/src/server.test.ts
bun test v1.3.2 (b131639c)

apps/server/src/server.test.ts:
⚠️  Dashboard assets not found - dashboard will be disabled
345 | 			const clampWarns = warnEvents.filter(
346 | 				(e) =>
347 | 					e.msg.includes("Minimax usage poll interval") &&
348 | 					e.msg.includes("clamping"),
349 | 			);
350 | 			expect(clampWarns.length).toBe(1);
                                   ^
error: expect(received).toBe(expected)

Expected: 1
Received: 0

      at <anonymous> (/Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-55/apps/server/src/server.test.ts:350:30)
(fail) bootstrapMinimaxUsagePolling > logs WARN exactly once when clamping fires (silent clamping is its own bug) [0.44ms]
381 | 		// finished, stacking in-flight calls.
382 | 		bootstrapMinimaxUsagePolling(accounts, registrar, 1_000);
383 |
384 | 		expect(startPolling).toHaveBeenCalledTimes(1);
385 | 		const forwardedIntervalMs = startPolling.mock.calls[0]?.[3];
386 | 		expect(forwardedIntervalMs).toBe(MINIMAX_USAGE_REQUEST_TIMEOUT_MS);
                                    ^
error: expect(received).toBe(expected)

Expected: 5000
Received: 1000

      at <anonymous> (/Users/vvladescu/.ao/data/worktrees/ccflare/ccflare-55/apps/server/src/server.test.ts:386:31)
(fail) bootstrapMinimaxUsagePolling > clamps an interval below the request timeout up to the timeout [0.19ms]

 23 pass
 2 fail
 66 expect() calls
Ran 25 tests across 1 file. [355.00ms]
```

**State 3 — F6 restored (GREEN):**

```
$ bun test packages/providers/src/__tests__/minimax-usage-fetcher.test.ts apps/server/src/server.test.ts
bun test v1.3.2 (b131639c)

apps/server/src/server.test.ts:
⚠️  Dashboard assets not found - dashboard will be disabled

 44 pass
 0 fail
 124 expect() calls
Ran 44 tests across 2 files. [386.00ms]
```

---

## Files changed

```
M apps/server/src/server.ts                                   (+ ~50 lines: clamp helper + log-once + call site)
M apps/server/src/server.test.ts                              (+ ~160 lines: F6 tests + clamp unit tests)
M packages/providers/src/minimax-usage-fetcher.ts            (+ ~30 lines: allowlist, known-failure set, parser branch; export timeout constant)
M packages/providers/src/__tests__/minimax-usage-fetcher.test.ts  (+ ~115 lines: F5 tests)
```

The 3 PR #347 commits cherry-picked onto the branch are unmodified.