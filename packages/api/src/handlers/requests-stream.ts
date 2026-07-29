import { requestEvents } from "@ccflare/core";
import { sseResponse } from "@ccflare/http";
import { isRequestStreamEvent, type RequestStreamEvent } from "@ccflare/types";

export function createRequestsStreamHandler() {
	return (): Response => {
		// Store the write handler outside to access it in cancel
		let writeHandler: ((data: RequestStreamEvent) => void) | null = null;

		const stream = new ReadableStream({
			start(controller) {
				const encoder = new TextEncoder();

				// Helper to send SSE formatted data
				writeHandler = (data: RequestStreamEvent) => {
					if (!isRequestStreamEvent(data)) {
						return;
					}
					const message = `data: ${JSON.stringify(data)}\n\n`;
					controller.enqueue(encoder.encode(message));
				};

				// Send initial connection message
				const connectMsg = `event: connected\ndata: ok\n\n`;
				controller.enqueue(encoder.encode(connectMsg));

				// Listen for events
				requestEvents.on("event", writeHandler);
			},
			cancel() {
				// Cleanup only this specific listener
				if (writeHandler) {
					requestEvents.off("event", writeHandler);
					writeHandler = null;
				}
			},
		});

		return sseResponse(stream);
	};
}
