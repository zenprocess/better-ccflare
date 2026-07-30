import { requestEvents } from "@ccflare/core";
import {
	sanitizeRequestHeaders,
	withSanitizedProxyHeaders,
} from "@ccflare/http";
import type { Account, HttpMethod } from "@ccflare/types";
import { trackProxyBackgroundTask } from "./background-tasks";
import type { ResolvedProxyContext } from "./handlers";
import type { ChunkMessage, EndMessage, StartMessage } from "./worker-messages";

/**
 * Check if a response should be considered successful/expected
 * Treats certain well-known paths that return 404 as expected
 */
function isExpectedResponse(path: string, response: Response): boolean {
	// Any .well-known path returning 404 is expected
	if (path.startsWith("/.well-known/") && response.status === 404) {
		return true;
	}

	// Otherwise use standard HTTP success logic
	return response.ok;
}

export interface ResponseHandlerOptions {
	requestId: string;
	method: HttpMethod;
	path: string;
	account: Account | null;
	requestHeaders: Headers;
	requestBody: ArrayBuffer | null;
	response: Response;
	timestamp: number;
	upstreamRequestStartedAt?: number;
	responseHeadersReceivedAt?: number;
	retryAttempt: number;
	failoverAttempts: number;
	preExtractedModel?: string;
}

/**
 * Unified response handler that immediately streams responses
 * while forwarding data to worker for async processing.
 */
export async function forwardToClient(
	options: ResponseHandlerOptions,
	ctx: ResolvedProxyContext,
): Promise<Response> {
	const {
		requestId,
		method,
		path,
		account,
		requestHeaders,
		requestBody,
		response: responseRaw,
		timestamp,
		upstreamRequestStartedAt,
		responseHeadersReceivedAt,
		retryAttempt, // Always 0 in new flow, but kept for message compatibility
		failoverAttempts,
		preExtractedModel,
	} = options;

	// Always strip compression headers *before* we do anything else
	const response = withSanitizedProxyHeaders(responseRaw);

	// Prepare objects once for serialisation - sanitize headers before storing
	const sanitizedReq = sanitizeRequestHeaders(requestHeaders);
	const requestHeadersObj = Object.fromEntries(sanitizedReq.entries());

	const responseHeadersObj = Object.fromEntries(response.headers.entries());

	const isStream = ctx.provider.isStreamingResponse?.(response) ?? false;

	// Send START message immediately
	const startMessage: StartMessage = {
		type: "start",
		requestId,
		accountId: account?.id || null,
		method,
		path,
		upstreamPath: ctx.upstreamPath,
		timestamp,
		upstreamRequestStartedAt,
		responseHeadersReceivedAt,
		requestHeaders: requestHeadersObj,
		requestBody: requestBody
			? Buffer.from(requestBody).toString("base64")
			: null,
		responseStatus: response.status,
		responseHeaders: responseHeadersObj,
		isStream,
		providerName: ctx.providerName,
		retryAttempt,
		failoverAttempts,
	};
	ctx.usageWorker.postMessage(startMessage);

	// Emit request start event for real-time dashboard
	requestEvents.emit("event", {
		type: "start",
		id: requestId,
		timestamp,
		method,
		path,
		accountId: account?.id || null,
		statusCode: response.status,
	});

	/*********************************************************************
	 *  STREAMING RESPONSES — tee with Response.clone() and send chunks
	 *********************************************************************/
	if (isStream && response.body) {
		// Two independent clones: one for the analytics worker (chunks →
		// usage extraction + payload retention), one as the source for the
		// client-facing wrapped body that observes cancel. We do NOT read
		// from `response.body` directly because Bun marks the original
		// ReadableStream as locked the moment response.clone() runs, which
		// silently breaks any subsequent reader attached to it.
		const analyticsClone = response.clone();
		const clientSource = response.clone();
		// Flag set when the consumer cancels the wrapped body. The
		// analytics reader is on a SEPARATE clone, so it cannot see the
		// client cancel — without this flag it would race the cancel
		// handler and overwrite the abandoned row with success=true (derived
		// from upstream HTTP status). The cancel handler wins; the analytics
		// reader short-circuits as soon as it observes the flag.
		let clientCancelled = false;

		// Wrap the body forwarded to the client so a client-side cancel
		// (Esc, tool interrupt, abrupt TCP close) is observable. Chunks are
		// forwarded 1:1 from `clientSource` — the live SSE forward path is
		// untouched. The only added behavior is firing an end message when
		// the consumer cancels.
		let upstreamCancel: (() => void) | null = null;
		const wrappedBody = new ReadableStream<Uint8Array>({
			start(controller) {
				const reader = clientSource.body!.getReader();
				const pump = async () => {
					try {
						while (true) {
							const { value, done } = await reader.read();
							if (done) {
								controller.close();
								return;
							}
							controller.enqueue(value);
						}
					} catch (err) {
						controller.error(err);
					}
				};
				pump();
				// Hold a cancel hook so the wrap's cancel() can propagate to
				// the underlying source. Without this the upstream source
				// keeps pumping chunks into a controller the consumer has
				// already abandoned.
				upstreamCancel = () => {
					clientSource.body!.cancel().catch(() => {
						// Underlying cancel may reject if the source is
						// already locked by an in-flight read; that read
						// will surface the error to the pump above.
					});
				};
			},
			cancel(_reason) {
				if (!clientCancelled) {
					clientCancelled = true;
					// Fire end message synchronously so the worker sees it
					// before the analytics reader's eventual end. The
					// worker's first end message wins (handleEnd deletes
					// state after writing), so the abandoned row is preserved
					// even if the analytics reader completes shortly after.
					ctx.usageWorker.postMessage({
						type: "end",
						requestId,
						preExtractedModel,
						success: false,
						error: "Client cancelled mid-stream",
						streamTerminalState: "client_cancelled",
					} satisfies EndMessage);
				}
				upstreamCancel?.();
			},
		});

		const backgroundTask = (async () => {
			try {
				const reader = analyticsClone.body?.getReader();
				if (!reader) return; // Safety check
				// eslint-disable-next-line no-constant-condition
				while (true) {
					if (clientCancelled) {
						// Stop consuming upstream — the client is gone, so
						// there is no value in reading more. Cancel the
						// analytics reader so the upstream connection also
						// closes promptly instead of staying open for the
						// rest of the stream.
						await reader.cancel();
						return;
					}
					const { value, done } = await reader.read();
					if (done) break;
					if (value) {
						const chunkMsg: ChunkMessage = {
							type: "chunk",
							requestId,
							data: value,
						};
						ctx.usageWorker.postMessage(chunkMsg);
					}
				}
				// If the client cancelled earlier, the cancel handler has
				// already written the row. Skip the upstream-status-derived
				// end message to avoid racing the worker's first end.
				if (clientCancelled) return;
				// Finished without errors
				const endMsg: EndMessage = {
					type: "end",
					requestId,
					preExtractedModel,
					success: isExpectedResponse(path, analyticsClone),
				};
				ctx.usageWorker.postMessage(endMsg);
			} catch (err) {
				if (clientCancelled) return;
				const endMsg: EndMessage = {
					type: "end",
					requestId,
					preExtractedModel,
					success: false,
					error: (err as Error).message,
				};
				ctx.usageWorker.postMessage(endMsg);
			}
		})();
		trackProxyBackgroundTask(backgroundTask);

		// Return a fresh Response whose body is the wrapped (cancel-aware)
		// stream. The chunks are forwarded 1:1 to the client — only the
		// cancel hook is new.
		return new Response(wrappedBody, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}

	/*********************************************************************
	 *  NON-STREAMING RESPONSES — read body in background, send END once
	 *********************************************************************/
	const backgroundTask = (async () => {
		try {
			const clone = response.clone();
			const bodyBuf = await clone.arrayBuffer();
			const endMsg: EndMessage = {
				type: "end",
				requestId,
				responseBody:
					bodyBuf.byteLength > 0
						? Buffer.from(bodyBuf).toString("base64")
						: null,
				preExtractedModel,
				success: isExpectedResponse(path, clone),
			};
			ctx.usageWorker.postMessage(endMsg);
		} catch (err) {
			const endMsg: EndMessage = {
				type: "end",
				requestId,
				preExtractedModel,
				success: false,
				error: (err as Error).message,
			};
			ctx.usageWorker.postMessage(endMsg);
		}
	})();
	trackProxyBackgroundTask(backgroundTask);

	// Return the sanitized response
	return response;
}
