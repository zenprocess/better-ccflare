/**
 * Best-effort cancel of a discarded response body to release off-heap backing
 * storage (issue #273 — Bun's fetch leaks ~100KB of native body per
 * abandoned `Response`; the upstream fix is oven-sh/bun#35093 and is not yet
 * shipped).
 *
 * Must be called on every `Response` ccflare obtained via `makeProxyRequest`
 * and then decided not to forward — 429/529/401 failover `return null` paths
 * and every retry-loop overwrite. Failover correctness takes precedence: a
 * cancel that throws must not be allowed to mask the real reason we
 * abandoned the body, so we skip null bodies and bodies that are already
 * locked (a locked body means another consumer is holding it, and the
 * underlying buffer will be released through their drain). The cancel
 * promise itself is fire-and-forget — its rejection (if any) cannot route
 * back here without rewriting the failover path.
 *
 * Lives in its own module so the regression test can import the helper
 * directly without pulling in the proxy-operations.ts transitive
 * dependency chain (which loads cacheBodyStore → @better-ccflare/database,
 * and that module fails to initialise in worktrees where `bun install`
 * has not run). The 12 discard sites in proxy-operations.ts import this
 * helper and call it before each `return null;`.
 */
export function cancelDiscardedResponseBody(
	response: Response | null | undefined,
): void {
	if (!response) return;
	const body = response.body;
	if (!body || body.locked) return;
	try {
		// body.cancel() schedules ReadableStream close; resolution frees the
		// backing store. We deliberately do NOT await — failing over fast is
		// more important than waiting for the cancel to settle, and the
		// ReadableStream spec guarantees the cancel still releases the store
		// after the call returns.
		body.cancel().catch(() => {});
	} catch {
		// Synchronous throws (rare, but possible if state races between the
		// locked check and the cancel call) are swallowed — same correctness
		// argument as the .catch above.
	}
}
