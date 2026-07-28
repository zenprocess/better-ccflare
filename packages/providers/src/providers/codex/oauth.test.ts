import { describe, expect, it } from "bun:test";
import { CODEX_OAUTH_SCOPES, CodexOAuthProvider } from "./oauth";

describe("CodexOAuthProvider", () => {
	const provider = new CodexOAuthProvider();

	it("uses Codex connector scopes and CLI auth params", () => {
		expect(CODEX_OAUTH_SCOPES).toEqual([
			"openid",
			"profile",
			"email",
			"offline_access",
			"api.connectors.read",
			"api.connectors.invoke",
		]);

		const authUrl = new URL(
			provider.generateAuthUrl(provider.getOAuthConfig(), {
				challenge: "test-challenge",
				verifier: "test-verifier",
			}),
		);

		expect(`${authUrl.origin}${authUrl.pathname}`).toBe(
			"https://auth.openai.com/oauth/authorize",
		);
		expect(authUrl.searchParams.get("scope")).toBe(
			"openid profile email offline_access api.connectors.read api.connectors.invoke",
		);
		expect(authUrl.searchParams.get("codex_cli_simplified_flow")).toBe("true");
		expect(authUrl.searchParams.get("originator")).toBe("codex_cli_rs");
	});
});
