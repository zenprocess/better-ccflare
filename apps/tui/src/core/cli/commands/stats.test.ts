import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "@ccflare/database";
import { resetAllStats } from "./stats";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop() as string, { force: true, recursive: true });
	}
});

describe("resetAllStats", () => {
	it("clears request history and resets session counters consistently", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "ccflare-cli-stats-"));
		tempDirs.push(tempDir);

		const dbOps = new DatabaseOperations(join(tempDir, "ccflare.db"));

		try {
			const account = dbOps.createAccount({
				name: "cli-reset-account",
				provider: "openai",
				auth_method: "api_key",
				api_key: "sk-test",
			});

			dbOps.updateAccountUsage(account.id);
			dbOps.saveRequest(
				"cli-reset-request",
				"POST",
				"/v1/openai/responses",
				"openai",
				"/responses",
				account.id,
				200,
				true,
				null,
				125,
				0,
			);

			resetAllStats(dbOps);

			expect(dbOps.getRecentRequests(10)).toHaveLength(0);
			expect(dbOps.getAccount(account.id)).toEqual(
				expect.objectContaining({
					request_count: 0,
					session_request_count: 0,
					session_start: null,
				}),
			);
		} finally {
			dbOps.close();
		}
	});
});
