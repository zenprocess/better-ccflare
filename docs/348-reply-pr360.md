# tombii/better-ccflare issue #348 — reply on PR #360

External reply posted to `tombii/better-ccflare` issue #348 in response to
tombii's direct ask to test the upstream main and confirm whether PR #360
(commits `fd389fd2`, `cec5b5b9`, `23cf0cea`) resolves the issue.

| | |
| --- | --- |
| Issue | https://github.com/tombii/better-ccflare/issues/348 |
| PR | https://github.com/tombii/better-ccflare/pull/360 |
| Posted comment | https://github.com/tombii/better-ccflare/issues/348#issuecomment-5152810656 |
| Comment ID | 5152810656 |
| Posted at | 2026-08-01T18:32:30Z |
| Author account | zenprocess |
| Mechanism reviewed | client-disconnect path leaves upstream fetch holding the connection invisibly (30-minute `PROXY_REQUEST_TIMEOUT_MS` outlives clients), compounding with the off-heap retention pattern tracked in #273 |
| Commits reviewed | `fd389fd2` (abort upstream on client disconnect), `cec5b5b9` (end request instead of failing over on client disconnect), `23cf0cea` (expose `streamTerminalState` via the API) |
| Verification status | Code-review only. Production verification pending; environment I'm working from has no network reach to our deploy hosts. |

## Position summary

The three commits directly close the mechanism described in #348:

- `fd389fd2` wires the client signal into the upstream fetch via `AbortSignal.any`, so a client disconnect actually aborts the fetch (the only path that closes the socket on Bun 1.3.11 — `reader.cancel()` does not).
- `cec5b5b9` prevents the now-aborted error from being read as an account failure and walking every remaining candidate against a closed socket. Returns 499 on client-goaway.
- `23cf0cea` exposes the recorded `stream_terminal_state` from the `requests` table on `/api/requests` and on the live summary, so the next "looks healthy, but isn't" incident is non-invisible.

What the three commits do NOT address:

- `PROXY_REQUEST_TIMEOUT_MS` is still not configurable. A client that stays connected past 30 minutes and sees long provider silence has the same orphan pattern — separate ticket, not a regression.
- No preliminary INSERT at stream start. An abandoned stream that never reaches `_handleEndInternal` still leaves no row.
- No body-stream timer. `PROXY_REQUEST_TIMEOUT_MS`'s AbortController is cleared at header time, and `teeStream` has no timer of its own.

Production verification was not claimed. The reply text on the issue makes the limit explicit and offers to update once a build containing these commits is running in production and a real client disconnect has been observed. The close-vs-hold decision was explicitly ceded to tombii.

The full reply body is reproduced below verbatim.

---

## Reply body (verbatim, as posted)

Thanks — these three commits line up with what I was worried about. A short note on what code review supports and what I cannot yet confirm, in case useful before #348 is closed.

### What the code review supports

- `fd389fd2` closes the source: `makeProxyRequest` was replacing any caller signal with a timeout-only controller that became unreachable at header time, so the upstream had no abort path. `AbortSignal.any(clientSignal, headerPhaseController)`, with every upstream call routed through `forwardUpstream` and the signal passed explicitly, restores the link. The Bun measurement you cite — `reader.cancel()` does not close the socket on 1.3.11, only `abort()` does — also closes the path I flagged against #273, because the orphan response's backing store is held until the socket actually closes.
- `cec5b5b9` stops the new abort from being read as an account failure and walking every remaining candidate against a closed socket. Returning 499 on client-goaway is the right HTTP shape.
- `23cf0cea` makes the next incident non-invisible: `streamTerminalState` on `/api/requests` and the live summary. Redefining it in `types/src/request.ts` rather than importing the producer's `AnthropicTerminalState` is the correct call given the package ordering (types is the base).

Coverage against the three options I listed originally:

- (2) detect/log abandoned requests — **closed**, by 23cf0cea (read-side) and fd389fd2 (abort-side). They are complementary rather than duplicate.
- (1) configurable timeout — **not done.** `PROXY_REQUEST_TIMEOUT_MS` is unchanged. If a client stays connected past 30 minutes and the provider stalls, the same orphan pattern recurs — independent of the signal wiring, so this is a separate decision rather than something the three commits overlooked.
- (3) treat client-abandonment as failover-eligible — **structurally addressed** by combining 1+2 (the abort path exists, the failover cascade no longer runs uselessly on a closed client) rather than by an explicit failover-on-abandonment policy. Worth noting in audit.

Two pre-existing observations from my comment above remain **open** and are not addressed by this PR:

- **No preliminary row at stream start.** An abandoned stream that never reaches `_handleEndInternal` still leaves no DB row. `fd389fd2` aborts the upstream, but a separate early INSERT is needed to make these events queryable per-request rather than as a global signal.
- **No body-stream timer.** `PROXY_REQUEST_TIMEOUT_MS`'s AbortController is cleared at header time, and `teeStream` has no timer of its own. So even on the new code, a client that stays connected and sees long provider silence has no proxy-side backstop during the body stream. Worth a separate ticket; not a regression.

### What I cannot confirm, and why

- **No production verification yet.** Our deployment is still on 3.5.44 and the environment I'm working from has no network reach to our deploy hosts (operator policy I cannot change). I cannot pull and run this against our workload, observe a real client disconnect on the new code, or verify the Bun version matches 1.3.11. I will commit to reporting back once a build containing these three commits is running in production and we have at least one real disconnect through it.
- I read the new test suites (`proxy-operations-client-abort.test.ts`, `request-handler-client-abort.test.ts`, `model-mapping.test.ts`, `requests-stream-terminal-state.test.ts`, `usage-collector-stream-terminal-state.test.ts`); I did not run them. Your red/green narration in the PR description plus asserting against a real local upstream rather than mocks is convincing — I trust it but have not independently confirmed.

### Direct relevance to our deployment

For context: my earlier correction here was that our "[900, 1200) s" reap band came from our own watchdog firing on a stale state-entry timestamp, not a ccflare timeout. The watchdog still reaps our workers; with these commits deployed, the abandoned in-flight request the reap produces will actually abort the upstream fetch on the next rollout. That is the exact failure mode `fd389fd2` was built to handle, on our fleet specifically — relevant, but not the confirmation we owe you.

### On #348

The mechanism we filed is closed by these three commits, conditional on the production observation above. **Whether to close #348 now or hold it open for that data point is your call.** If you close it and we see any related symptom on the new build, I will open a focused follow-up; if you keep it open, I will update it once I have the production data. Either way, I would rather not call it complete without that observation — overclaiming a fix we have not seen run does a disservice to the effort put in.

---

## Post-reply actions

- Comment deleted and reposted (initial attempt posted a placeholder body via `gh api -F body=@file`, which sent the literal `@path/to/file` string instead of the file contents; switched to `curl` with token from `gh auth token` and `--data-binary` from a `jq`-built JSON payload).
- Leak-checked the posted text against the project's standing content markers. Clean.
- Confirmed via `gh api` that the live comment body is 4745 chars and contains every required honesty phrase ("cannot yet confirm", "No production verification", "3.5.44", "streamTerminalState", "is your call", "operator policy I cannot change", "code review supports", "fd389fd2", "cec5b5b9", "23cf0cea", "have not independently confirmed").
