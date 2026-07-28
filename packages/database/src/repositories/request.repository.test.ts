import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ensureSchema, runMigrations } from "../migrations";
import { RequestRepository } from "./request.repository";

function encode(value: string): string {
	return Buffer.from(value, "utf8").toString("base64");
}

function createPayload(options: {
	requestId: string;
	responseId: string;
	previousResponseId?: string;
}): {
	id: string;
	request: { headers: Record<string, string>; body: string };
	response: { status: number; headers: Record<string, string>; body: string };
	meta: {
		trace: { timestamp: number };
		account: { id: null };
		transport: { success: boolean };
	};
} {
	return {
		id: options.requestId,
		request: {
			headers: {},
			body: encode(
				JSON.stringify({
					type: "response.create",
					input: `message-${options.requestId}`,
					...(options.previousResponseId
						? { previous_response_id: options.previousResponseId }
						: {}),
				}),
			),
		},
		response: {
			status: 200,
			headers: {},
			body: encode(
				[
					"event: response.created",
					`data: ${JSON.stringify({
						type: "response.created",
						response: { id: options.responseId },
					})}`,
					"",
				].join("\n"),
			),
		},
		meta: {
			trace: { timestamp: Date.now() },
			account: { id: null },
			transport: { success: true },
		},
	};
}

describe("RequestRepository", () => {
	let db: Database;
	let repository: RequestRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		repository = new RequestRepository(db);
	});

	afterEach(() => {
		db.close();
	});

	it("tracks in-flight rows without marking them as failures and preserves the original timestamp on completion", () => {
		repository.saveMeta(
			"request-1",
			"POST",
			"/v1/openai/responses",
			"openai",
			"/responses",
			"account-1",
			200,
			1_000,
		);

		const inFlightRow = db
			.query(
				`SELECT timestamp, success, response_time_ms FROM requests WHERE id = ?`,
			)
			.get("request-1") as {
			timestamp: number;
			success: 0 | 1 | null;
			response_time_ms: number | null;
		};

		expect(inFlightRow).toEqual({
			timestamp: 1_000,
			success: null,
			response_time_ms: null,
		});

		repository.save({
			id: "request-1",
			method: "POST",
			path: "/v1/openai/responses",
			provider: "openai",
			upstreamPath: "/responses",
			accountUsed: "account-1",
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 25,
			failoverAttempts: 0,
			timestamp: 9_999,
			payload: { id: "request-1", ok: true },
		});

		const completedRow = db
			.query(
				`SELECT timestamp, success, response_time_ms FROM requests WHERE id = ?`,
			)
			.get("request-1") as {
			timestamp: number;
			success: 0 | 1 | null;
			response_time_ms: number | null;
		};

		expect(completedRow).toEqual({
			timestamp: 1_000,
			success: 1,
			response_time_ms: 25,
		});
		expect(
			db
				.query(`SELECT json FROM request_payloads WHERE id = ?`)
				.get("request-1"),
		).toEqual({
			json: JSON.stringify({ id: "request-1", ok: true }),
		});
	});

	it("orders request history by request start time instead of completion time", () => {
		repository.saveMeta(
			"older-request",
			"POST",
			"/v1/openai/responses",
			"openai",
			"/responses",
			"account-1",
			200,
			1_000,
		);
		repository.saveMeta(
			"newer-request",
			"POST",
			"/v1/openai/chat/completions",
			"openai",
			"/chat/completions",
			"account-1",
			200,
			2_000,
		);

		const originalNow = Date.now;

		try {
			Date.now = () => 5_000;
			repository.save({
				id: "newer-request",
				method: "POST",
				path: "/v1/openai/chat/completions",
				provider: "openai",
				upstreamPath: "/chat/completions",
				accountUsed: "account-1",
				statusCode: 200,
				success: true,
				errorMessage: null,
				responseTime: 10,
				failoverAttempts: 0,
			});

			Date.now = () => 10_000;
			repository.save({
				id: "older-request",
				method: "POST",
				path: "/v1/openai/responses",
				provider: "openai",
				upstreamPath: "/responses",
				accountUsed: "account-1",
				statusCode: 200,
				success: true,
				errorMessage: null,
				responseTime: 20,
				failoverAttempts: 0,
			});
		} finally {
			Date.now = originalNow;
		}

		expect(repository.listSummaries(2).map((request) => request.id)).toEqual([
			"newer-request",
			"older-request",
		]);
	});

	it("rolls back completion updates when payload persistence fails", () => {
		repository.saveMeta(
			"request-rollback",
			"POST",
			"/v1/openai/responses",
			"openai",
			"/responses",
			"account-1",
			200,
			3_000,
		);

		db.run(`
			CREATE TRIGGER fail_request_payload_insert
			BEFORE INSERT ON request_payloads
			BEGIN
				SELECT RAISE(ABORT, 'payload blocked');
			END;
		`);

		expect(() =>
			repository.save({
				id: "request-rollback",
				method: "POST",
				path: "/v1/openai/responses",
				provider: "openai",
				upstreamPath: "/responses",
				accountUsed: "account-1",
				statusCode: 200,
				success: true,
				errorMessage: null,
				responseTime: 50,
				failoverAttempts: 0,
				payload: { id: "request-rollback" },
			}),
		).toThrow("payload blocked");

		const persistedRow = db
			.query(
				`SELECT timestamp, success, response_time_ms FROM requests WHERE id = ?`,
			)
			.get("request-rollback") as {
			timestamp: number;
			success: 0 | 1 | null;
			response_time_ms: number | null;
		};

		expect(persistedRow).toEqual({
			timestamp: 3_000,
			success: null,
			response_time_ms: null,
		});
		expect(
			db
				.query(`SELECT json FROM request_payloads WHERE id = ?`)
				.get("request-rollback"),
		).toBeNull();
	});

	it("stores conversation linkage and returns ancestor payloads up to the requested row", () => {
		repository.save({
			id: "request-root",
			method: "POST",
			path: "/v1/openai/responses",
			provider: "openai",
			upstreamPath: "/responses",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 10,
			failoverAttempts: 0,
			timestamp: 1_000,
			payload: createPayload({
				requestId: "request-root",
				responseId: "resp-root",
			}),
		});

		repository.save({
			id: "request-child",
			method: "POST",
			path: "/v1/openai/responses",
			provider: "openai",
			upstreamPath: "/responses",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 10,
			failoverAttempts: 0,
			timestamp: 2_000,
			payload: createPayload({
				requestId: "request-child",
				responseId: "resp-child",
				previousResponseId: "resp-root",
			}),
		});

		repository.save({
			id: "request-grandchild",
			method: "POST",
			path: "/v1/openai/responses",
			provider: "openai",
			upstreamPath: "/responses",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 10,
			failoverAttempts: 0,
			timestamp: 3_000,
			payload: createPayload({
				requestId: "request-grandchild",
				responseId: "resp-grandchild",
				previousResponseId: "resp-child",
			}),
		});

		const storedRows = db
			.query(
				`
					SELECT id, response_id, previous_response_id, response_chain_id
					FROM requests
					ORDER BY timestamp ASC
				`,
			)
			.all() as Array<{
			id: string;
			response_id: string | null;
			previous_response_id: string | null;
			response_chain_id: string | null;
		}>;

		expect(storedRows).toEqual([
			{
				id: "request-root",
				response_id: "resp-root",
				previous_response_id: null,
				response_chain_id: "resp-root",
			},
			{
				id: "request-child",
				response_id: "resp-child",
				previous_response_id: "resp-root",
				response_chain_id: "resp-root",
			},
			{
				id: "request-grandchild",
				response_id: "resp-grandchild",
				previous_response_id: "resp-child",
				response_chain_id: "resp-root",
			},
		]);

		expect(
			repository
				.listResponseChainPayloadsWithAccountNames("request-child")
				.map((row) => row.id),
		).toEqual(["request-root", "request-child"]);
	});

	it("returns only the direct ancestor chain and excludes sibling branches", () => {
		repository.save({
			id: "root",
			method: "POST",
			path: "/v1/openai/responses",
			provider: "openai",
			upstreamPath: "/responses",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 10,
			failoverAttempts: 0,
			timestamp: 1_000,
			payload: createPayload({
				requestId: "root",
				responseId: "resp-root",
			}),
		});
		repository.save({
			id: "branch-a",
			method: "POST",
			path: "/v1/openai/responses",
			provider: "openai",
			upstreamPath: "/responses",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 10,
			failoverAttempts: 0,
			timestamp: 2_000,
			payload: createPayload({
				requestId: "branch-a",
				responseId: "resp-a",
				previousResponseId: "resp-root",
			}),
		});
		repository.save({
			id: "branch-b",
			method: "POST",
			path: "/v1/openai/responses",
			provider: "openai",
			upstreamPath: "/responses",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 10,
			failoverAttempts: 0,
			timestamp: 3_000,
			payload: createPayload({
				requestId: "branch-b",
				responseId: "resp-b",
				previousResponseId: "resp-root",
			}),
		});
		repository.save({
			id: "leaf-a",
			method: "POST",
			path: "/v1/openai/responses",
			provider: "openai",
			upstreamPath: "/responses",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 10,
			failoverAttempts: 0,
			timestamp: 4_000,
			payload: createPayload({
				requestId: "leaf-a",
				responseId: "resp-leaf-a",
				previousResponseId: "resp-a",
			}),
		});

		expect(
			repository
				.listResponseChainPayloadsWithAccountNames("leaf-a")
				.map((row) => row.id),
		).toEqual(["root", "branch-a", "leaf-a"]);
	});
});
