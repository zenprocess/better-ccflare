import { sseResponse } from "@ccflare/http";
import { Logger, logBus } from "@ccflare/logger";
import { isLogEvent, type LogEvent } from "@ccflare/types";

const log = new Logger("LogsHandler");

/**
 * Create a logs stream handler using Server-Sent Events
 */
export function createLogsStreamHandler() {
	return (): Response => {
		const encoder = new TextEncoder();
		let closed = false;
		let unsubscribe: (() => void) | null = null;

		const closeStream = (): void => {
			if (closed) {
				return;
			}

			closed = true;
			unsubscribe?.();
			unsubscribe = null;
		};

		const readable = new ReadableStream<Uint8Array>({
			start(controller) {
				try {
					const initialData = `data: ${JSON.stringify({ connected: true })}\n\n`;
					controller.enqueue(encoder.encode(initialData));
				} catch (error) {
					log.error("Error sending initial message:", error);
					closeStream();
					controller.error(error);
					return;
				}

				const handleLogEvent = (event: LogEvent) => {
					if (closed || !isLogEvent(event)) {
						return;
					}

					try {
						const data = `data: ${JSON.stringify(event)}\n\n`;
						controller.enqueue(encoder.encode(data));
					} catch (error) {
						closeStream();
						controller.close();
						log.debug("Closed logs stream after client disconnect", {
							error: error instanceof Error ? error.message : String(error),
						});
					}
				};

				logBus.on("log", handleLogEvent);
				unsubscribe = () => logBus.off("log", handleLogEvent);
			},
			cancel() {
				closeStream();
			},
		});

		return sseResponse(readable);
	};
}
