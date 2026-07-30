import { describe, expect, it } from "bun:test";
import type { Account } from "@ccflare/types";
import type { ResolvedProxyContext } from "../handlers";
import { forwardToClient } from "../response-handler";

/**
 * Build a ReadableStream that produces the given chunks then closes.
 * Mirrors the upstream SSE shape enough for forwardToClient to treat it
 * as a streaming response.
 */
function buildStreamingResponse(
	chunks: string[],
	status = 200,
): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
	return new Response(stream, {
		status,
		headers: { "content-type": "text/event-stream; charset=utf-8" },
	});
}

/**
 * Provider stub that always reports a streaming response — matches the
 * real Anthropic-shaped SSE surface that triggers the streaming branch.
 */
const streamingProvider = {
	name: "openai",
	defaultBaseUrl: "https://api.openai.com",
	buildUrl() {
		return "https://api.openai.com/v1/responses";
	},
	prepareHeaders(headers: Headers) {
		return headers;
	},
	parseRateLimit() {
		return { isRateLimited: false, statusHeader: "allowed" } as const;
	},
	extractUsage() {
		return null;
	},
	isStreamingResponse() {
		return true;
	},
};

function createStreamingContext(messages: unknown[]): ResolvedProxyContext {
	return {
		provider: streamingProvider,
		providerName: "openai",
		upstreamPath: "/responses",
		strategy: {
			select(accounts: Account[]) {
				return accounts;
			},
		},
		dbOps: {
			getAvailableAccountsByProvider() {
				return [];
			},
			updateAccountRateLimitMeta() {},
			markAccountRateLimited() {},
		},
		runtime: {
			clientId: "test-client",
			retry: { attempts: 1, delayMs: 0, backoff: 1 },
			sessionDurationMs: 0,
			port: 8080,
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue() {} },
		usageWorker: {
			postMessage(message: unknown) {
				messages.push(message);
			},
		},
	} as unknown as ResolvedProxyContext;
}

function findEndMessage(messages: unknown[]) {
	return messages.find(
		(message) =>
			typeof message === "object" &&
			message !== null &&
			"type" in message &&
			message.type === "end",
	) as
		| {
				type: "end";
				requestId: string;
				success?: boolean;
				error?: string;
				streamTerminalState?: string | null;
		  }
		| undefined;
}

describe("abandoned stream attribution", () => {
	it("fires an end message with client_cancelled when the consumer aborts mid-stream", async () => {
		const messages: unknown[] = [];
		const response = await forwardToClient(
			{
				requestId: "abandon-1",
				method: "POST",
				path: "/v1/openai/responses",
				account: null,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: null,
				// Plenty of chunks — the test cancels the response body
				// before the producer reaches done.
				response: buildStreamingResponse([
					"event: message_start\n",
					'data: {"type":"message_start"}\n',
					"\n",
				]),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			createStreamingContext(messages),
		);

		expect(response.status).toBe(200);

		// Simulate the consumer (HTTP client) disconnecting mid-stream.
		// The wrapped body's cancel() hook fires the end message; the
		// pre-fix code silently dropped the cancel and the analytics
		// reader kept reading until done — producing a row with
		// success=true (inherited from upstream HTTP status) and no
		// signal that the client was gone.
		await Promise.race([
			response.body!.cancel(),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("cancel timed out")), 1000),
			),
		]).catch((err) => {
			console.log("cancel error:", err);
		});

		// Yield once so the cancel handler microtask can post the message.
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 50));

		const endMessage = findEndMessage(messages);
		expect(endMessage).toBeDefined();
		expect(endMessage?.success).toBe(false);
		expect(endMessage?.streamTerminalState).toBe("client_cancelled");
		expect(endMessage?.error).toContain("cancelled");
	});

	it("does NOT produce a duplicate end from the analytics reader after a client cancel", async () => {
		const messages: unknown[] = [];
		const response = await forwardToClient(
			{
				requestId: "abandon-2",
				method: "POST",
				path: "/v1/openai/responses",
				account: null,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: null,
				response: buildStreamingResponse([
					"event: message_start\n",
					'data: {"type":"message_start"}\n',
					"\n",
				]),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			createStreamingContext(messages),
		);

		await Promise.race([
			response.body!.cancel(),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("cancel timed out")), 1000),
			),
		]).catch(() => {});
		// Give the upstream SSE generator time to reach done and fire the
		// analytics reader's normal completion path. If the cancel guard
		// were missing, this would race the cancel handler and overwrite
		// the abandoned row with success=true.
		await new Promise((resolve) => setTimeout(resolve, 50));

		const endMessages = messages.filter(
			(message) =>
				typeof message === "object" &&
				message !== null &&
				"type" in message &&
				message.type === "end",
		);
		expect(endMessages).toHaveLength(1);
		expect(endMessages[0]).toMatchObject({
			streamTerminalState: "client_cancelled",
			success: false,
		});
	});
});