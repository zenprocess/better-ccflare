import { OAuthError } from "@ccflare/core";
import type {
	OAuthProvider,
	OAuthProviderConfig,
	PKCEChallenge,
	TokenResult,
} from "../../types";

export const OPENAI_OAUTH_AUTHORIZE_URL =
	"https://auth.openai.com/oauth/authorize";
export const OPENAI_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_OAUTH_SCOPES = [
	"openid",
	"profile",
	"email",
	"offline_access",
];
export const OPENAI_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";

export class OpenAIOAuthProvider implements OAuthProvider {
	getOAuthConfig(): OAuthProviderConfig {
		return {
			authorizeUrl: OPENAI_OAUTH_AUTHORIZE_URL,
			tokenUrl: OPENAI_OAUTH_TOKEN_URL,
			clientId: OPENAI_OAUTH_CLIENT_ID,
			scopes: OPENAI_OAUTH_SCOPES,
			redirectUri: OPENAI_OAUTH_REDIRECT_URI,
		};
	}

	generateAuthUrl(config: OAuthProviderConfig, pkce: PKCEChallenge): string {
		const url = new URL(config.authorizeUrl);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("client_id", config.clientId);
		url.searchParams.set("redirect_uri", config.redirectUri);
		url.searchParams.set("scope", config.scopes.join(" "));
		url.searchParams.set("code_challenge", pkce.challenge);
		url.searchParams.set("code_challenge_method", "S256");
		url.searchParams.set("state", pkce.verifier);
		return url.toString();
	}

	async exchangeCode(
		code: string,
		verifier: string,
		config: OAuthProviderConfig,
	): Promise<TokenResult> {
		const response = await fetch(config.tokenUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: config.redirectUri,
				client_id: config.clientId,
				code_verifier: verifier,
			}).toString(),
		});

		if (!response.ok) {
			let errorDetails: { error?: string; error_description?: string } | null =
				null;
			try {
				errorDetails = await response.json();
			} catch {
				// Ignore malformed OAuth error payloads.
			}

			const errorMessage =
				errorDetails?.error_description ||
				errorDetails?.error ||
				response.statusText ||
				"OAuth token exchange failed";

			throw new OAuthError(errorMessage, "openai", errorDetails?.error);
		}

		const json = (await response.json()) as {
			access_token: string;
			refresh_token?: string;
			expires_in?: number;
			expires_at?: number;
		};

		return {
			accessToken: json.access_token,
			refreshToken: json.refresh_token ?? "",
			expiresAt:
				json.expires_at ?? Date.now() + (json.expires_in ?? 3600) * 1000,
		};
	}
}
