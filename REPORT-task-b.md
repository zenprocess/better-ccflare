# Task B Report — stream-admission `circuit_open` drain

## Branch
`feat/cb-wave2-sse-drain` (from upstream/main @ 053746c1)

## Commits (verified via `git log --oneline -5`)
```
b47ba72e feat(proxy): drain stream-admission waiters on circuit_open
88e4ae0c feat(proxy): per-account SSE stream admission control   (cherry-pick 61825651)
ba699d7e fix(proxy): align circuit breaker to upstream vocabulary and bound cooldown   (cherry-pick 916c473b)
053746c1 fix: repair broken tests and eliminate cross-file mock.module pollution [skip-version]   (upstream/main HEAD)
```

## Files touched (≤2, per spec)
- `packages/proxy/src/stream-admission.ts` (122 lines added, 10 modified)
- `packages/proxy/src/__tests__/stream-admission.test.ts` (222 lines added)

No other files modified. The untracked files in the worktree (e.g. `?? .forgejo/`, `?? apps/web/`, etc.) are
artifacts from the worktree setup (`ao` infrastructure cloned the ccflare v2 restructure and the
`.claude/agents/` sandbox blocked clean checkout of upstream's `.claude/` tree). They are not part of this
commit and are not pushed.

## What changed
1. **Added `{kind: "circuit_open", accountId}` to `AdmissionRejection`** — the typed rejection union now has
   three variants: `queue_full`, `timeout`, and `circuit_open`. The caller (a future SSE wiring task,
   out of scope here) maps `circuit_open` to the same 503 + JSON shape `createPoolExhaustedResponse`
   produces so clients see one uniform error.

2. **Added `breaker` + `provider` options to `StreamAdmissionOptions`** — optional injection. When set,
   the jitter-delay poll consults the breaker.

3. **Added `rejectAllForAccount(accountId, reason): number`** to `StreamAdmission` — drains all queued
   waiters for an account with the given rejection (used by the in-jitter drain to fan out to siblings).

4. **Polled `breaker.shouldAllow(...)` during the jitter delay** (worst-case drain latency = one jitter
   window, default 250ms; well under the typical 30s queue wait). **No subscribe API was added to the
   breaker** — per spec, polling is unworkable is the only acceptable reason to expand the breaker's
   surface.

5. **Fixed a pre-existing held-accounting bug** exposed by the new drain tests: in `releaseOneSlot`,
   `held++` when picking from queue caused `held` to exceed `cap` across release+pick cycles. Replaced
   with `active--` so the slot transitions directly from "active (released stream)" to "in-jitter
   (picked waiter)" without changing the held count. Held now respects cap at every point in the lifecycle.

## Acceptance: `bun test packages/proxy/src/__tests__/stream-admission.test.ts`

### GREEN (final state, with breaker-poll block in place)
```
bun test v1.3.2 (b131639c)
 17 pass
 0 fail
 84 expect() calls
Ran 17 tests across 1 file. [427.00ms]
```

### RED (negative control: only the breaker-poll block temporarily removed)
```
bun test v1.3.2 (b131639c)
packages/proxy/src/__tests__/stream-admission.test.ts:
574 |
575 | 		// Release r1 → releaseOneSlot picks r2 → jitter fires →
576 | 		// breaker poll sees open → drain.
577 | 		if (r1.ok) r1.handle.release();
578 | 		const r2 = await r2Promise;
579 | 		expect(r2.ok).toBe(false);
                       ^
error: expect(received).toBe(expected)
Expected: false
Received: true
(fail) createStreamAdmission — circuit-breaker drain > a queued waiter is drained with circuit_open when the circuit opens while it waits
(fail) createStreamAdmission — circuit-breaker drain > the drained waiter's reserved slot is released (no leaked capacity) [5030ms timeout]
679 |
680 | 		// Release a1: triggers head-pick → jitter → drain for acc-a
681 | 		// (a2 gets circuit_open). acc-b's queue is unaffected.
682 | 		if (a1.ok) a1.handle.release();
683 | 		const a2 = await a2Promise;
684 | 		expect(a2.ok).toBe(false);
                       ^
error: expect(received).toBe(expected)
Expected: false
Received: true
(fail) createStreamAdmission — circuit-breaker drain > waiters for a DIFFERENT account are unaffected when one bad account drains

 14 pass
 3 fail
 67 expect() calls
Ran 17 tests across 1 file. [6.21s]
```

3 of 4 new tests failed (test 4 — "normal admission still works when the circuit is closed" — passed
because with the breaker closed, the missing poll is a no-op). The 3 failures pin exactly the behavior
the breaker-poll block is responsible for. The tests are not silently green over unwired code.

### GREEN (restored)
```
bun test v1.3.2 (b131639c)
 17 pass
 0 fail
 84 expect() calls
Ran 17 tests across 1 file. [108.00ms]
```

## Hard-boundary check
- `stream-admission.ts` and its tests ONLY ✓
- No edits to the proxy's live SSE forwarding path ✓
- No edits to the response handler / wiring layer ✓
- No push, no PR (per spec) ✓
- No sandbox network workaround attempted ✓

## What I did NOT do (per scope)
- Did NOT wire `rejectAllForAccount` into the live SSE forwarding path (separate task, blocked on
  the `fix/silent-stream-truncation` history).
- Did NOT change the load-balancing strategy.
- Did NOT add a `subscribe(...)` API to the circuit breaker.
- Did NOT touch `ccmax.zp.digital` or any live service.

## Worktree state note
The worktree contains untracked v2-restructure files (e.g. `?? apps/web/`, `?? packages/api/`,
`?? .claude/agents/` blocked by sandbox). These are NOT part of my commit. Three prior workers
were bitten by reporting "committed" with untracked files; this report commits everything it claims.

`git log --oneline -3`:
```
b47ba72e feat(proxy): drain stream-admission waiters on circuit_open
88e4ae0c feat(proxy): per-account SSE stream admission control
ba699d7e fix(proxy): align circuit breaker to upstream vocabulary and bound cooldown
```
