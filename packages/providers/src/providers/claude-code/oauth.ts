import {
	buildAnthropicAuthUrl,
	exchangeAnthropicCode,
} from "../../oauth/anthropic-family-oauth";
import type {
	OAuthProvider,
	OAuthProviderConfig,
	PKCEChallenge,
	TokenResult,
} from "../../types";

export const CLAUDE_CODE_OAUTH_AUTHORIZE_URL =
	"https://claude.ai/oauth/authorize";
export const CLAUDE_CODE_OAUTH_TOKEN_URL =
	"https://platform.claude.com/v1/oauth/token";
export const CLAUDE_CODE_OAUTH_REDIRECT_URI =
	"https://platform.claude.com/oauth/code/callback";
export const CLAUDE_CODE_OAUTH_SCOPES = [
	"org:create_api_key",
	"user:profile",
	"user:inference",
	"user:sessions:claude_code",
	"user:mcp_servers",
	"user:file_upload",
];

export class ClaudeCodeOAuthProvider implements OAuthProvider {
	getOAuthConfig(): OAuthProviderConfig {
		return {
			authorizeUrl: CLAUDE_CODE_OAUTH_AUTHORIZE_URL,
			tokenUrl: CLAUDE_CODE_OAUTH_TOKEN_URL,
			clientId: "",
			scopes: CLAUDE_CODE_OAUTH_SCOPES,
			redirectUri: CLAUDE_CODE_OAUTH_REDIRECT_URI,
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
		return exchangeAnthropicCode(code, verifier, config, "claude-code");
	}
}
