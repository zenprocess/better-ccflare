import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { ensureSchema, runMigrations } from "../migrations";
import { StatsRepository } from "./stats.repository";

function insertAccount(db: Database): string {
	const accountId = "stats-account";
	db.run(
		`INSERT INTO accounts (
			id, name, provider, auth_method, api_key, created_at, weight
		) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			accountId,
			"Stats Account",
			"anthropic",
			"api_key",
			"sk-test",
			Date.now(),
			1,
		],
	);
	return accountId;
}

function insertRequest(
	db: Database,
	request: {
		id: string;
		timestamp: number;
		accountId: string;
		statusCode: number | null;
		success: number | null;
		responseTimeMs: number | null;
	},
): void {
	db.run(
		`INSERT INTO requests (
			id,
			timestamp,
			method,
			path,
			provider,
			upstream_path,
			account_used,
			status_code,
			success,
			error_message,
			response_time_ms,
			failover_attempts,
			total_tokens,
			cost_usd
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			request.id,
			request.timestamp,
			"POST",
			"/v1/anthropic/v1/messages",
			"anthropic",
			"/v1/messages",
			request.accountId,
			request.statusCode,
			request.success,
			null,
			request.responseTimeMs,
			0,
			8,
			0.15,
		],
	);
}

describe("StatsRepository", () => {
	it("tracks success rates using only completed requests", () => {
		const db = new Database(":memory:");

		try {
			ensureSchema(db);
			runMigrations(db);

			const accountId = insertAccount(db);
			const now = Date.now();

			insertRequest(db, {
				id: "request-success",
				timestamp: now - 3_000,
				accountId,
				statusCode: 200,
				success: 1,
				responseTimeMs: 150,
			});
			insertRequest(db, {
				id: "request-failure",
				timestamp: now - 2_000,
				accountId,
				statusCode: 500,
				success: 0,
				responseTimeMs: 275,
			});
			insertRequest(db, {
				id: "request-inflight",
				timestamp: now - 1_000,
				accountId,
				statusCode: null,
				success: null,
				responseTimeMs: null,
			});

			const repository = new StatsRepository(db);
			const stats = repository.getAggregatedStats();

			expect(stats.totalRequests).toBe(3);
			expect(stats.successfulRequests).toBe(1);
			expect(stats.completedRequests).toBe(2);
			expect(stats.successRate).toBe(50);
		} finally {
			db.close();
		}
	});
});
