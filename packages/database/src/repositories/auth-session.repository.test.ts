import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { ensureSchema, runMigrations } from "../migrations";
import { AuthSessionRepository } from "./auth-session.repository";

describe("AuthSessionRepository", () => {
	it("creates, retrieves, deletes, and round-trips state_json", () => {
		const db = new Database(":memory:");

		try {
			ensureSchema(db);
			runMigrations(db);

			const repository = new AuthSessionRepository(db);
			const state = {
				verifier: "pkce-verifier",
				nested: {
					values: [1, 2, 3],
				},
			};
			const expiresAt = Date.now() + 60_000;

			const sessionId = repository.createSession(
				"claude-code",
				"oauth",
				"test-account",
				JSON.stringify(state),
				expiresAt,
			);
			const session = repository.getSession(sessionId);
			const expectedExpiresAt = new Date(expiresAt).toISOString();

			expect(session).toEqual(
				expect.objectContaining({
					id: sessionId,
					provider: "claude-code",
					authMethod: "oauth",
					accountName: "test-account",
					stateJson: JSON.stringify(state),
					expiresAt: expectedExpiresAt,
				}),
			);
			expect(session?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			expect(JSON.parse(session?.stateJson ?? "{}")).toEqual(state);

			repository.deleteSession(sessionId);
			expect(repository.getSession(sessionId)).toBeNull();
		} finally {
			db.close();
		}
	});

	it("looks up sessions by OAuth state and updates completion state", () => {
		const db = new Database(":memory:");

		try {
			ensureSchema(db);
			runMigrations(db);

			const repository = new AuthSessionRepository(db);
			const expiresAt = Date.now() + 60_000;
			const initialState = {
				verifier: "pkce-verifier",
				state: "oauth-state-token",
				status: "pending",
			};

			const sessionId = repository.createSession(
				"codex",
				"oauth",
				"callback-account",
				JSON.stringify(initialState),
				expiresAt,
			);

			expect(repository.getSessionByState("oauth-state-token")).toEqual(
				expect.objectContaining({
					id: sessionId,
					accountName: "callback-account",
				}),
			);

			repository.updateSessionState(
				sessionId,
				JSON.stringify({
					...initialState,
					status: "completed",
				}),
				expiresAt + 60_000,
			);

			expect(
				JSON.parse(repository.getSession(sessionId)?.stateJson ?? "{}"),
			).toEqual(
				expect.objectContaining({
					state: "oauth-state-token",
					status: "completed",
				}),
			);
		} finally {
			db.close();
		}
	});

	it("ignores malformed state_json rows when looking up by OAuth state", () => {
		const db = new Database(":memory:");

		try {
			ensureSchema(db);
			runMigrations(db);

			const repository = new AuthSessionRepository(db);
			const expiresAt = Date.now() + 60_000;
			repository.createSession(
				"codex",
				"oauth",
				"broken-session",
				"{invalid-json",
				expiresAt,
			);
			const validSessionId = repository.createSession(
				"codex",
				"oauth",
				"valid-session",
				JSON.stringify({ state: "oauth-state-token" }),
				expiresAt,
			);

			expect(repository.getSessionByState("oauth-state-token")).toEqual(
				expect.objectContaining({
					id: validSessionId,
					accountName: "valid-session",
				}),
			);
		} finally {
			db.close();
		}
	});

	it("does not retrieve expired sessions and deletes them during cleanup", () => {
		const db = new Database(":memory:");

		try {
			ensureSchema(db);
			runMigrations(db);

			const repository = new AuthSessionRepository(db);

			const expiredSessionId = repository.createSession(
				"codex",
				"oauth",
				"expired-account",
				JSON.stringify({ verifier: "expired" }),
				Date.now() - 1,
			);
			const validSessionId = repository.createSession(
				"claude-code",
				"oauth",
				"valid-account",
				JSON.stringify({ verifier: "valid" }),
				Date.now() + 60_000,
			);

			expect(repository.getSession(expiredSessionId)).toBeNull();
			expect(repository.getSession(validSessionId)).toEqual(
				expect.objectContaining({
					id: validSessionId,
					accountName: "valid-account",
				}),
			);

			expect(repository.deleteExpiredSessions()).toBe(1);
			expect(repository.getSession(expiredSessionId)).toBeNull();
			expect(repository.getSession(validSessionId)).not.toBeNull();
		} finally {
			db.close();
		}
	});
});
