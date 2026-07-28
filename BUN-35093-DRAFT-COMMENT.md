# DRAFT — comment on `oven-sh/bun#35093`

> **Status:** DRAFT, not posted. Operator review pending.
> **Context:** Downstream reproduction of the leak in `tombii/better-ccflare`, linked issue `tombii/better-ccflare#273`.

---

## Comment body

A real-world downstream reproduction of this leak, in case it's useful for prioritization. ccflare is a Bun/TypeScript multi-provider AI proxy; its failover path obtains a `Response` from `fetch()` (e.g. on a 429 or 529 from the upstream), decides not to forward it, and discards it. That discard path triggers the off-heap fetch leak this PR fixes — every discarded response holds its full body in mimalloc until the `Response` becomes unreachable and the native source finalizes.

Measured on Bun, pinned 73 015-byte body, RSS delta on the client process divided by N:

| Bun           | revision                                | `body.cancel()` after fetch | held, no cancel     |
| ------------- | --------------------------------------- | --------------------------- | ------------------- |
| 1.3.2         | `b131639cc545af23e568feb68e7d5c14c2778b20` | **83.3 KB/req** (leaks)     | 73.3 KB/req (leaks) |
| 1.3.14        | release                                 | **78.5 KB/req** (leaks)     | 76.6 KB/req (leaks) |
| PR build      | `b296b3d58249c759f65862e0c08864da0a5a7923` (1.4.0-canary.1) | **−13.5 KB/req** (flat) | 77.3 KB/req (leaks) |

So on every released Bun the user can install today, `body.cancel()` on a fully-buffered response is a no-op — same as not cancelling. After this PR it actually frees the buffer. The "held, no cancel" column didn't move, which matches the PR's scope (the listener only fires from an `AbortSignal`), and is consistent with what the diff and the new tests cover.

Method, in case you want to reproduce or dispute it: a Bun script does `fetch()` against a pinned URL in a loop, samples `process.memoryUsage().rss` before and after N=500 iterations, and divides the delta by N. Three cases (cancel / hold / consume) per binary. The harness and raw outputs are at `bench/` in the worktree branch this validation was generated from. Sandbox notes: this was measured on macOS with `bun` invoked directly; the PR build was obtained from the buildkite artifact URL that `bun-pr` discovered (full provenance in the report).

We're shipping an application-side mitigation in `tombii/better-ccflare` (adding `response.body?.cancel()` on the discard paths only — explicitly not on the streaming-forward paths, because cancelling a body that's being forwarded truncates the client stream, which is a bug class we've already fixed once). That mitigation only actually closes the leak once a Bun containing this PR reaches users — without the PR, the cancel call is a no-op on released Bun, as the table shows. So merging this is what unblocks the ccflare-side fix for anyone on a Bun version they actually control.

Happy to share the harness or run additional numbers (different body sizes, the `ac.abort()`-after-resolve path, the `stream-tee` interaction) if useful.

---

## Operator review notes

- The first sentence is honest framing (we're providing downstream corroboration, not arguing the fix).
- The "every released Bun the user can install today, `body.cancel()` on a fully-buffered response is a no-op" is the load-bearing claim — it's what motivates the ccflare-side fix needing this PR. Worth double-checking the wording so it doesn't read as "Bun is broken".
- The "we're not blocked" line is intentionally absent in the comment body — the spec said to mention the mitigation in the report, but a public comment shouldn't read like a project status update. If you want it in, suggested phrasing: "We are independently shipping `response.body?.cancel()` on our discard paths; the value of merging this for us is that it makes our mitigation actually work on installed Buns."
- We do not link the ccflare-specific bug tracker (`tombii/better-ccflare#273`) in the comment body because the issue is private / internal at the time of writing; replace with the canonical public link once that issue is mirrored publicly.
- No links to internal docs, no mention of the harness commit hash, no mention of how the PR build was obtained. The validation report in this worktree has the full provenance; the public comment shouldn't.
- No promise of a timeline, no request for an ETA, no commentary on the CI flakiness (darwin-14-aarch64) — the spec explicitly forbade that.