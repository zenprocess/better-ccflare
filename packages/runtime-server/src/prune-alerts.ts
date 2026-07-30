import type { CleanupResult } from "@ccflare/database";
import { Logger } from "@ccflare/logger";

/**
 * Alert sink for the fail-closed prune gate.
 *
 * Two channels, both fire-and-forget:
 *  1. A stable, monitor-greppable log token: PRUNE_GATE_ALERT. Any log
 *     watcher (docker logs | grep PRUNE_GATE_ALERT) can key on it.
 *  2. Optional ntfy push when CCFLARE_PRUNE_NTFY_URL is set (full topic URL,
 *     e.g. https://ntfy.sh/ccflare-prune). Errors are swallowed: alerting
 *     must never break the maintenance path.
 *
 * Also keeps a process-lifetime counter of alert events so repeated
 * fail-closed runs are visible as a monotonically increasing number in the
 * log line itself (a monitor can detect "still broken" vs "one-off").
 */

const log = new Logger("PruneGate");

let alertCount = 0;

/** Process-lifetime number of prune-gate alerts emitted (for tests/metrics). */
export function getPruneAlertCount(): number {
	return alertCount;
}

/** Test seam: reset the counter. */
export function resetPruneAlertCount(): void {
	alertCount = 0;
}

export type PruneAlertSink = (message: string) => void;

function defaultNtfySink(message: string): void {
	const url = process.env.CCFLARE_PRUNE_NTFY_URL;
	if (!url) return;
	// Fire-and-forget; never await, never throw.
	fetch(url, {
		method: "POST",
		headers: {
			Title: "ccflare prune gate",
			Priority: "high",
			Tags: "warning,ccflare",
		},
		body: message,
	}).catch((err) => {
		log.warn(`ntfy alert delivery failed (alert still logged): ${err}`);
	});
}

/**
 * Inspect a cleanup result and emit alerts when the gate held data back.
 * Returns true when an alert was emitted.
 */
export function alertOnPruneResult(
	result: CleanupResult,
	sink: PruneAlertSink = defaultNtfySink,
): boolean {
	const problems: string[] = [];
	if (result.failClosed) {
		problems.push(
			`fail-closed: ${result.reason ?? "unknown reason"} (deleted nothing this run)`,
		);
	}
	if (result.keptUndistilledPayloads > 0) {
		problems.push(
			`${result.keptUndistilledPayloads} payload(s) past retention are NOT distilled — retained, accumulating`,
		);
	}
	if (problems.length === 0) {
		return false;
	}
	alertCount += 1;
	const message = `PRUNE_GATE_ALERT #${alertCount}: ${problems.join("; ")}`;
	log.error(message);
	try {
		sink(message);
	} catch (err) {
		log.warn(`prune alert sink threw (alert still logged): ${err}`);
	}
	return true;
}
