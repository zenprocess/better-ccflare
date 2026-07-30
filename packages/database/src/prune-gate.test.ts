import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "./database-operations";
import {
	countUndistilledOldPayloads,
	DISTILLED_TABLE,
	distilledTableExists,
	runPruneGate,
} from "./prune-gate";

/**
 * FIXTURE tests for the distilled-first fail-closed prune gate.
 * Everything runs against throwaway temp-dir sqlite files — never a live DB.
 */

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop() as string, { force: true, recursive: true });
	}
});

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const OLD_TS = NOW - 100 * HOUR; // far past any cutoff used below
const FRESH_TS = NOW - 1 * HOUR; // inside retention
const CUTOFF = NOW - 24 * HOUR; // retention boundary

interface Fixture {
	dbOps: DatabaseOperations;
	db: Database;
	dbPath: string;
}

function makeFixture(): Fixture {
	const tempDir = mkdtempSync(join(tmpdir(), "ccflare-prune-gate-"));
	tempDirs.push(tempDir);
	const dbPath = join(tempDir, "fixture.db");
	const dbOps = new DatabaseOperations(dbPath);
	return { dbOps, db: dbOps.getDatabase(), dbPath };
}

/** Simulate the distiller's marker table (owned by the distiller, not ccflare). */
function createDistilledTable(db: Database): void {
	db.run(
		`CREATE TABLE IF NOT EXISTS ${DISTILLED_TABLE} (
			id TEXT PRIMARY KEY,
			distilled_at INTEGER NOT NULL DEFAULT 0
		)`,
	);
}

function insertRequest(db: Database, id: string, timestamp: number): void {
	db.run(
		`INSERT INTO requests (id, timestamp, method, path) VALUES (?, ?, 'POST', '/v1/messages')`,
		[id, timestamp],
	);
}

function insertPayload(
	db: Database,
	id: string,
	json = '{"fixture":true}',
): void {
	db.run(`INSERT INTO request_payloads (id, json) VALUES (?, ?)`, [id, json]);
}

function markDistilled(db: Database, id: string): void {
	db.run(`INSERT INTO ${DISTILLED_TABLE} (id, distilled_at) VALUES (?, ?)`, [
		id,
		Date.now(),
	]);
}

function payloadIds(db: Database): string[] {
	return db
		.query<{ id: string }, []>(`SELECT id FROM request_payloads ORDER BY id`)
		.all()
		.map((r) => r.id);
}

function requestIds(db: Database): string[] {
	return db
		.query<{ id: string }, []>(`SELECT id FROM requests ORDER BY id`)
		.all()
		.map((r) => r.id);
}

describe("prune gate — distilled-first deletion", () => {
	it("(1) deletes a payload that is old AND distilled", () => {
		const { dbOps, db } = makeFixture();
		try {
			createDistilledTable(db);
			insertRequest(db, "old-distilled", OLD_TS);
			insertPayload(db, "old-distilled");
			markDistilled(db, "old-distilled");

			const result = runPruneGate(db, { payloadCutoffTs: CUTOFF });

			expect(result.failClosed).toBe(false);
			expect(result.deletedPayloads).toBe(1);
			expect(result.keptUndistilledPayloads).toBe(0);
			expect(payloadIds(db)).toEqual([]);
			// request row untouched (no requestCutoffTs given)
			expect(requestIds(db)).toEqual(["old-distilled"]);
		} finally {
			dbOps.close();
		}
	});

	it("(2) KEEPS a payload that is old but NOT distilled, and counts it for alerting", () => {
		const { dbOps, db } = makeFixture();
		try {
			createDistilledTable(db);
			insertRequest(db, "old-undistilled", OLD_TS);
			insertPayload(db, "old-undistilled");

			const result = runPruneGate(db, { payloadCutoffTs: CUTOFF });

			expect(result.failClosed).toBe(false);
			expect(result.deletedPayloads).toBe(0);
			expect(result.keptUndistilledPayloads).toBe(1);
			expect(payloadIds(db)).toEqual(["old-undistilled"]);
		} finally {
			dbOps.close();
		}
	});

	it("never deletes a distilled payload that is still inside retention", () => {
		const { dbOps, db } = makeFixture();
		try {
			createDistilledTable(db);
			insertRequest(db, "fresh-distilled", FRESH_TS);
			insertPayload(db, "fresh-distilled");
			markDistilled(db, "fresh-distilled");

			const result = runPruneGate(db, { payloadCutoffTs: CUTOFF });

			expect(result.deletedPayloads).toBe(0);
			expect(payloadIds(db)).toEqual(["fresh-distilled"]);
		} finally {
			dbOps.close();
		}
	});

	it("(3) FAILS CLOSED when the distiller marker table is missing: deletes nothing, reports", () => {
		const { dbOps, db } = makeFixture();
		try {
			// NO payload_distilled table created.
			insertRequest(db, "old-a", OLD_TS);
			insertPayload(db, "old-a");
			insertRequest(db, "old-b", OLD_TS);
			insertPayload(db, "old-b");

			expect(distilledTableExists(db)).toBe(false);

			const result = runPruneGate(db, {
				payloadCutoffTs: CUTOFF,
				requestCutoffTs: CUTOFF,
			});

			expect(result.failClosed).toBe(true);
			expect(result.reason).toContain("PRUNE_GATE_FAIL_CLOSED");
			expect(result.reason).toContain("payload_distilled");
			expect(result.deletedPayloads).toBe(0);
			expect(result.deletedRequests).toBe(0);
			expect(result.keptUndistilledPayloads).toBe(2);
			// nothing at all was deleted — not even request rows
			expect(payloadIds(db)).toEqual(["old-a", "old-b"]);
			expect(requestIds(db)).toEqual(["old-a", "old-b"]);
		} finally {
			dbOps.close();
		}
	});

	it("fails closed on a mid-run SQL error (corrupt marker table) without deleting", () => {
		const { dbOps, db } = makeFixture();
		try {
			// Marker table exists but with the wrong shape -> phase-1 SQL errors.
			db.run(`CREATE TABLE ${DISTILLED_TABLE} (wrong_column TEXT)`);
			insertRequest(db, "old-x", OLD_TS);
			insertPayload(db, "old-x");

			const result = runPruneGate(db, { payloadCutoffTs: CUTOFF });

			expect(result.failClosed).toBe(true);
			expect(result.reason).toContain("PRUNE_GATE_FAIL_CLOSED");
			expect(payloadIds(db)).toEqual(["old-x"]);
		} finally {
			dbOps.close();
		}
	});
});

describe("prune gate — orphan payloads", () => {
	it("deletes distilled orphans, keeps undistilled orphans", () => {
		const { dbOps, db } = makeFixture();
		try {
			createDistilledTable(db);
			// Orphans: payload rows with no requests row. FK is enforced, so
			// create parent rows first, then delete them with FKs off to
			// simulate the historical orphan state found in the live DBs.
			db.run("PRAGMA foreign_keys = OFF");
			insertPayload(db, "orphan-distilled");
			insertPayload(db, "orphan-undistilled");
			db.run("PRAGMA foreign_keys = ON");
			markDistilled(db, "orphan-distilled");

			const result = runPruneGate(db, { payloadCutoffTs: CUTOFF });

			expect(result.deletedOrphanPayloads).toBe(1);
			expect(result.keptUndistilledOrphans).toBe(1);
			expect(payloadIds(db)).toEqual(["orphan-undistilled"]);
		} finally {
			dbOps.close();
		}
	});
});

describe("prune gate — cascade-safe request deletion", () => {
	it("deletes old requests only when payload is absent or distilled; never cascades an undistilled payload away", () => {
		const { dbOps, db } = makeFixture();
		try {
			createDistilledTable(db);
			// old request, no payload -> deletable
			insertRequest(db, "req-no-payload", OLD_TS);
			// old request, distilled payload -> payload deleted (phase 1), then request deleted
			insertRequest(db, "req-distilled", OLD_TS);
			insertPayload(db, "req-distilled");
			markDistilled(db, "req-distilled");
			// old request, UNDISTILLED payload -> BOTH kept (cascade guard)
			insertRequest(db, "req-undistilled", OLD_TS);
			insertPayload(db, "req-undistilled");
			// fresh request -> kept
			insertRequest(db, "req-fresh", FRESH_TS);

			const result = runPruneGate(db, {
				payloadCutoffTs: CUTOFF,
				requestCutoffTs: CUTOFF,
			});

			expect(result.deletedRequests).toBe(2); // no-payload + distilled
			expect(result.deletedPayloads).toBe(1); // the distilled one
			expect(result.keptUndistilledPayloads).toBe(1);
			expect(requestIds(db)).toEqual(["req-fresh", "req-undistilled"]);
			expect(payloadIds(db)).toEqual(["req-undistilled"]);
		} finally {
			dbOps.close();
		}
	});
});

describe("prune gate — batching (4)", () => {
	function seedOldDistilled(db: Database, n: number): void {
		createDistilledTable(db);
		for (let i = 0; i < n; i++) {
			const id = `bulk-${String(i).padStart(4, "0")}`;
			insertRequest(db, id, OLD_TS);
			insertPayload(db, id);
			markDistilled(db, id);
		}
	}

	it("deletes in bounded batches, never one giant statement", () => {
		const { dbOps, db } = makeFixture();
		try {
			seedOldDistilled(db, 7);
			const batchDeletes: number[] = [];

			const result = runPruneGate(
				db,
				{ payloadCutoffTs: CUTOFF },
				{
					batchSize: 2,
					onBatch: (info) => {
						if (info.phase === "payloads_old_distilled") {
							batchDeletes.push(info.deleted);
						}
					},
				},
			);

			expect(result.deletedPayloads).toBe(7);
			// 7 rows at batchSize=2 -> 2,2,2,1 : every statement bounded by 2
			expect(batchDeletes).toEqual([2, 2, 2, 1]);
			expect(Math.max(...batchDeletes)).toBeLessThanOrEqual(2);
			expect(result.exhausted).toBe(true);
		} finally {
			dbOps.close();
		}
	});

	it("holds no lock between batches: a second connection can WRITE mid-run", () => {
		const { dbOps, db, dbPath } = makeFixture();
		const other = new Database(dbPath); // busy_timeout defaults to 0: any held write lock throws immediately
		try {
			seedOldDistilled(db, 6);
			let midRunWrites = 0;

			const result = runPruneGate(
				db,
				{ payloadCutoffTs: CUTOFF },
				{
					batchSize: 2,
					onBatch: () => {
						// If the gate wrapped the whole prune in one transaction /
						// giant statement, this would throw SQLITE_BUSY.
						other.run(
							`INSERT INTO requests (id, timestamp, method, path) VALUES (?, ?, 'GET', '/mid-run')`,
							[`mid-run-${midRunWrites}`, Date.now()],
						);
						midRunWrites += 1;
					},
				},
			);

			expect(result.deletedPayloads).toBe(6);
			expect(midRunWrites).toBeGreaterThanOrEqual(3);
			const inserted = db
				.query<{ n: number }, []>(
					`SELECT COUNT(*) AS n FROM requests WHERE path = '/mid-run'`,
				)
				.get();
			expect(inserted?.n).toBe(midRunWrites);
		} finally {
			other.close();
			dbOps.close();
		}
	});

	it("respects maxBatches and reports exhausted=false so the next run resumes", () => {
		const { dbOps, db } = makeFixture();
		try {
			seedOldDistilled(db, 10);

			const first = runPruneGate(
				db,
				{ payloadCutoffTs: CUTOFF },
				{ batchSize: 2, maxBatches: 2 },
			);
			expect(first.deletedPayloads).toBe(4);
			expect(first.exhausted).toBe(false);
			expect(payloadIds(db).length).toBe(6);

			// Next run picks up where the last one stopped — resumable.
			const second = runPruneGate(
				db,
				{ payloadCutoffTs: CUTOFF },
				{ batchSize: 2, maxBatches: 100 },
			);
			expect(second.deletedPayloads).toBe(6);
			expect(second.exhausted).toBe(true);
			expect(payloadIds(db)).toEqual([]);
		} finally {
			dbOps.close();
		}
	});

	it("respects the time budget (a zero budget deletes nothing, fails safe)", () => {
		const { dbOps, db } = makeFixture();
		try {
			seedOldDistilled(db, 4);

			const result = runPruneGate(
				db,
				{ payloadCutoffTs: CUTOFF },
				{ batchSize: 2, timeBudgetMs: 1 },
			);

			// Budget may allow at most the first instants of work; whatever
			// happened, every surviving row is still intact and the run says
			// it did not finish.
			expect(result.exhausted).toBe(false);
			expect(result.deletedPayloads + payloadIds(db).length).toBe(4);
		} finally {
			dbOps.close();
		}
	});
});

describe("DatabaseOperations.cleanupOldRequests (gated wrapper)", () => {
	it("routes through the gate and surfaces fail-closed + kept counts", () => {
		const { dbOps, db } = makeFixture();
		try {
			insertRequest(db, "old-1", OLD_TS);
			insertPayload(db, "old-1");

			// no marker table -> fail closed
			const closed = dbOps.cleanupOldRequests(24 * HOUR, 48 * HOUR);
			expect(closed.failClosed).toBe(true);
			expect(closed.removedPayloads).toBe(0);
			expect(closed.removedRequests).toBe(0);
			expect(closed.keptUndistilledPayloads).toBe(1);

			// distiller appears and marks the payload -> next run deletes it
			createDistilledTable(db);
			markDistilled(db, "old-1");
			const open = dbOps.cleanupOldRequests(24 * HOUR, 48 * HOUR);
			expect(open.failClosed).toBe(false);
			expect(open.removedPayloads).toBe(1);
			expect(open.removedRequests).toBe(1);
			expect(open.keptUndistilledPayloads).toBe(0);
			expect(payloadIds(db)).toEqual([]);
			expect(requestIds(db)).toEqual([]);
		} finally {
			dbOps.close();
		}
	});

	it("helper: countUndistilledOldPayloads matches gate accounting", () => {
		const { dbOps, db } = makeFixture();
		try {
			createDistilledTable(db);
			insertRequest(db, "u1", OLD_TS);
			insertPayload(db, "u1");
			insertRequest(db, "u2", OLD_TS);
			insertPayload(db, "u2");
			markDistilled(db, "u2");

			expect(countUndistilledOldPayloads(db, CUTOFF)).toBe(1);
		} finally {
			dbOps.close();
		}
	});
});
