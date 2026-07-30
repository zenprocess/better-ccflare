import { beforeEach, describe, expect, it } from "bun:test";
import type { CleanupResult } from "@ccflare/database";
import {
	alertOnPruneResult,
	getPruneAlertCount,
	resetPruneAlertCount,
} from "./prune-alerts";

function cleanResult(overrides: Partial<CleanupResult> = {}): CleanupResult {
	return {
		removedRequests: 0,
		removedPayloads: 0,
		keptUndistilledPayloads: 0,
		failClosed: false,
		reason: null,
		batches: 0,
		exhausted: true,
		...overrides,
	};
}

describe("prune gate alerts", () => {
	beforeEach(() => {
		resetPruneAlertCount();
	});

	it("stays silent on a clean run", () => {
		const messages: string[] = [];
		const alerted = alertOnPruneResult(
			cleanResult({ removedPayloads: 5, removedRequests: 3 }),
			(m) => messages.push(m),
		);
		expect(alerted).toBe(false);
		expect(messages).toEqual([]);
		expect(getPruneAlertCount()).toBe(0);
	});

	it("alerts and increments the counter when undistilled payloads are retained", () => {
		const messages: string[] = [];
		const alerted = alertOnPruneResult(
			cleanResult({ keptUndistilledPayloads: 42 }),
			(m) => messages.push(m),
		);
		expect(alerted).toBe(true);
		expect(messages.length).toBe(1);
		expect(messages[0]).toContain("PRUNE_GATE_ALERT #1");
		expect(messages[0]).toContain("42 payload(s)");
		expect(getPruneAlertCount()).toBe(1);
	});

	it("alerts on fail-closed runs with the reason, counter accumulates across runs", () => {
		const messages: string[] = [];
		alertOnPruneResult(
			cleanResult({
				failClosed: true,
				reason:
					"PRUNE_GATE_FAIL_CLOSED: marker table 'payload_distilled' missing",
				keptUndistilledPayloads: 7,
			}),
			(m) => messages.push(m),
		);
		alertOnPruneResult(cleanResult({ keptUndistilledPayloads: 8 }), (m) =>
			messages.push(m),
		);
		expect(messages.length).toBe(2);
		expect(messages[0]).toContain("fail-closed");
		expect(messages[0]).toContain("payload_distilled");
		expect(messages[1]).toContain("#2");
		expect(getPruneAlertCount()).toBe(2);
	});

	it("a throwing sink cannot break the maintenance path", () => {
		const alerted = alertOnPruneResult(
			cleanResult({ keptUndistilledPayloads: 1 }),
			() => {
				throw new Error("ntfy down");
			},
		);
		expect(alerted).toBe(true); // alert recorded (logged) despite sink failure
		expect(getPruneAlertCount()).toBe(1);
	});
});
