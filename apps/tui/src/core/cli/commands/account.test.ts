import { describe, expect, it } from "bun:test";
import type { AccountDisplay } from "@ccflare/ui";
import { formatAccountsTable } from "./account";

const account: AccountDisplay = {
	id: "acct_1",
	name: "work",
	provider: "openai",
	auth_method: "oauth",
	base_url: null,
	weight: 1,
	weightDisplay: "1x",
	created: new Date("2026-01-01T00:00:00.000Z"),
	lastUsed: null,
	requestCount: 2,
	totalRequests: 4,
	paused: false,
	tokenStatus: "valid",
	rateLimitStatus: "OK",
	sessionInfo: "-",
	rateLimit: {
		code: "ok",
		isLimited: false,
		until: null,
		resetAt: null,
		remaining: null,
	},
	session: {
		active: false,
		startedAt: null,
		requestCount: 0,
	},
};

describe("formatAccountsTable", () => {
	it("includes provider and auth_method columns", () => {
		const lines = formatAccountsTable([account]);

		expect(lines[1]).toContain("Provider");
		expect(lines[1]).toContain("Auth");
		expect(lines[1]).toContain("Weight");
		expect(lines[3]).toContain("openai");
		expect(lines[3]).toContain("oauth");
		expect(lines[3]).toContain("1x");
	});
});
