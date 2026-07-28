import type { AccountProvider, AuthMethod } from "@ccflare/types";
import { BaseRepository } from "./base.repository";

export interface AuthSession {
	id: string;
	provider: AccountProvider;
	authMethod: AuthMethod;
	accountName: string;
	stateJson: string;
	createdAt: string;
	expiresAt: string;
}

export class AuthSessionRepository extends BaseRepository<AuthSession> {
	private getActiveRowById(id: string): {
		id: string;
		provider: AccountProvider;
		auth_method: AuthMethod;
		account_name: string;
		state_json: string;
		created_at: string;
		expires_at: string;
	} | null {
		return this.get(
			`
			SELECT
				id,
				provider,
				auth_method,
				account_name,
				state_json,
				created_at,
				expires_at
			FROM auth_sessions
			WHERE id = ? AND expires_at > ?
		`,
			[id, new Date().toISOString()],
		);
	}

	private getActiveRowByState(state: string): {
		id: string;
		provider: AccountProvider;
		auth_method: AuthMethod;
		account_name: string;
		state_json: string;
		created_at: string;
		expires_at: string;
	} | null {
		return this.get(
			`
			SELECT
				id,
				provider,
				auth_method,
				account_name,
				state_json,
				created_at,
				expires_at
			FROM auth_sessions
			WHERE expires_at > ?
				AND json_valid(state_json) = 1
				AND json_extract(state_json, '$.state') = ?
		`,
			[new Date().toISOString(), state],
		);
	}

	private toAuthSession(row: {
		id: string;
		provider: AccountProvider;
		auth_method: AuthMethod;
		account_name: string;
		state_json: string;
		created_at: string;
		expires_at: string;
	}): AuthSession {
		return {
			id: row.id,
			provider: row.provider,
			authMethod: row.auth_method,
			accountName: row.account_name,
			stateJson: row.state_json,
			createdAt: row.created_at,
			expiresAt: row.expires_at,
		};
	}

	createSession(
		provider: AccountProvider,
		authMethod: AuthMethod,
		accountName: string,
		stateJson: string,
		expiresAt: number,
	): string {
		const id = crypto.randomUUID();
		const createdAt = new Date().toISOString();
		const expiresAtIso = new Date(expiresAt).toISOString();

		this.run(
			`
			INSERT INTO auth_sessions (
				id,
				provider,
				auth_method,
				account_name,
				state_json,
				created_at,
				expires_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`,
			[
				id,
				provider,
				authMethod,
				accountName,
				stateJson,
				createdAt,
				expiresAtIso,
			],
		);

		return id;
	}

	getSession(id: string): AuthSession | null {
		const row = this.getActiveRowById(id);

		if (!row) {
			return null;
		}

		return this.toAuthSession(row);
	}

	getSessionByState(state: string): AuthSession | null {
		const row = this.getActiveRowByState(state);

		if (!row) {
			return null;
		}

		return this.toAuthSession(row);
	}

	updateSessionState(id: string, stateJson: string, expiresAt?: number): void {
		if (typeof expiresAt === "number") {
			this.run(
				"UPDATE auth_sessions SET state_json = ?, expires_at = ? WHERE id = ?",
				[stateJson, new Date(expiresAt).toISOString(), id],
			);
			return;
		}

		this.run("UPDATE auth_sessions SET state_json = ? WHERE id = ?", [
			stateJson,
			id,
		]);
	}

	deleteSession(id: string): void {
		this.run("DELETE FROM auth_sessions WHERE id = ?", [id]);
	}

	deleteExpiredSessions(): number {
		return this.runWithChanges(
			"DELETE FROM auth_sessions WHERE expires_at <= ?",
			[new Date().toISOString()],
		);
	}
}
