import { describe, expect, it } from "bun:test";
import { CLAUDE_CODE_OAUTH_SCOPES, ClaudeCodeOAuthProvider } from "./oauth";

describe("ClaudeCodeOAuthProvider", () => {
	const provider = new ClaudeCodeOAuthProvider();

	it("uses the hosted Claude callback and Claude Code scopes", () => {
		expect(CLAUDE_CODE_OAUTH_SCOPES).toEqual([
			"org:create_api_key",
			"user:profile",
			"user:inference",
			"user:sessions:claude_code",
			"user:mcp_servers",
			"user:file_upload",
		]);

		const authUrl = new URL(
			provider.generateAuthUrl(provider.getOAuthConfig(), {
				challenge: "test-challenge",
				verifier: "test-verifier",
			}),
		);

		expect(`${authUrl.origin}${authUrl.pathname}`).toBe(
			"https://claude.ai/oauth/authorize",
		);
		expect(authUrl.searchParams.get("redirect_uri")).toBe(
			"https://platform.claude.com/oauth/code/callback",
		);
		expect(authUrl.searchParams.get("scope")).toBe(
			"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
		);
		expect(authUrl.searchParams.get("state")).toBe("test-verifier");
	});
});
