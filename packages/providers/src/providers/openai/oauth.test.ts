import { describe, expect, it } from "bun:test";
import { OPENAI_OAUTH_SCOPES, OpenAIOAuthProvider } from "./oauth";

describe("OpenAIOAuthProvider", () => {
	const provider = new OpenAIOAuthProvider();

	it("uses OpenID Connect scopes in auth URLs", () => {
		expect(OPENAI_OAUTH_SCOPES).toEqual([
			"openid",
			"profile",
			"email",
			"offline_access",
		]);

		const authUrl = new URL(
			provider.generateAuthUrl(provider.getOAuthConfig(), {
				challenge: "test-challenge",
				verifier: "test-verifier",
			}),
		);

		expect(authUrl.searchParams.get("scope")).toBe(
			"openid profile email offline_access",
		);
		expect(authUrl.searchParams.get("state")).toBe("test-verifier");
	});
});
