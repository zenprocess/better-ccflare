import {
	ANTHROPIC_OAUTH_SCOPES,
	ANTHROPIC_OAUTH_TOKEN_URL,
	buildAnthropicAuthUrl,
	exchangeAnthropicCode,
} from "../../oauth/anthropic-family-oauth";
import type {
	OAuthProvider,
	OAuthProviderConfig,
	PKCEChallenge,
	TokenResult,
} from "../../types";

export class AnthropicOAuthProvider implements OAuthProvider {
	getOAuthConfig(): OAuthProviderConfig {
		return {
			authorizeUrl: "https://console.anthropic.com/oauth/authorize",
			tokenUrl: ANTHROPIC_OAUTH_TOKEN_URL,
			clientId: "", // Will be passed from config
			scopes: ANTHROPIC_OAUTH_SCOPES,
			redirectUri: "https://console.anthropic.com/oauth/code/callback",
		};
	}

	generateAuthUrl(config: OAuthProviderConfig, pkce: PKCEChallenge): string {
		return buildAnthropicAuthUrl(config, pkce);
	}

	async exchangeCode(
		code: string,
		verifier: string,
		config: OAuthProviderConfig,
	): Promise<TokenResult> {
		return exchangeAnthropicCode(code, verifier, config, "anthropic");
	}
}
