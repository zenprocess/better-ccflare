import { describe, expect, it } from "bun:test";
import { AsyncDbWriter } from "./async-writer";

async function waitFor(
	condition: () => boolean,
	timeoutMs = 250,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if (condition()) {
			return;
		}

		await Bun.sleep(5);
	}

	throw new Error("Timed out waiting for condition");
}

describe("AsyncDbWriter", () => {
	it("tracks failed jobs and exposes an unhealthy state", async () => {
		const writer = new AsyncDbWriter();

		writer.enqueue(async () => {
			throw new Error("boom");
		});

		await waitFor(() => writer.getFailureCount() === 1);
		await writer.dispose();

		expect(writer.isHealthy()).toBe(false);
		expect(writer.getFailureCount()).toBe(1);
	});

	it("flushes queued jobs during disposal", async () => {
		const writer = new AsyncDbWriter();
		let completed = false;

		writer.enqueue(async () => {
			await Bun.sleep(10);
			completed = true;
		});

		await writer.dispose();

		expect(completed).toBe(true);
		expect(writer.getQueueSize()).toBe(0);
		expect(writer.getFailureCount()).toBe(0);
	});
});
