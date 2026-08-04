import type { OAuthProviderConfig, PKCEChallenge } from "../../types";
import { OpenAIOAuthProvider } from "../openai/oauth";

export const CODEX_OAUTH_AUTHORIZE_URL =
	"https://auth.openai.com/oauth/authorize";
export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_SCOPES = [
	"openid",
	"profile",
	"email",
	"offline_access",
	"api.connectors.read",
	"api.connectors.invoke",
];
export const CODEX_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";

export class CodexOAuthProvider extends OpenAIOAuthProvider {
	override getOAuthConfig(): OAuthProviderConfig {
		return {
			authorizeUrl: CODEX_OAUTH_AUTHORIZE_URL,
			tokenUrl: CODEX_OAUTH_TOKEN_URL,
			clientId: CODEX_OAUTH_CLIENT_ID,
			scopes: CODEX_OAUTH_SCOPES,
			redirectUri: CODEX_OAUTH_REDIRECT_URI,
		};
	}

	override generateAuthUrl(
		config: OAuthProviderConfig,
		pkce: PKCEChallenge,
	): string {
		const url = new URL(super.generateAuthUrl(config, pkce));
		url.searchParams.set("codex_cli_simplified_flow", "true");
		url.searchParams.set("originator", "codex_cli_rs");
		return url.toString();
	}
}
