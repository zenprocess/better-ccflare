import { OAuthError } from "@ccflare/core";
import type { OAuthProviderConfig, PKCEChallenge, TokenResult } from "../types";

/**
 * Shared helpers for the Anthropic-family OAuth flow (Anthropic + Claude Code).
 *
 * Both providers use identical auth URL assembly, code.split("#") handling,
 * JSON token-exchange body, and OAuth error parsing. The only differences are
 * the endpoint URLs, redirect URIs, and provider label for error messages.
 */

// Shared Anthropic-family OAuth constants
// Used by both AnthropicOAuthProvider and ClaudeCodeOAuthProvider.

/** Token endpoint shared by all Anthropic-family providers. */
export const ANTHROPIC_OAUTH_TOKEN_URL =
	"https://console.anthropic.com/v1/oauth/token";

/** Scopes shared by all Anthropic-family providers. */
export const ANTHROPIC_OAUTH_SCOPES = [
	"org:create_api_key",
	"user:profile",
	"user:inference",
];

/**
 * Build an Anthropic-family authorization URL with PKCE and the "code=true"
 * parameter. Shared by AnthropicOAuthProvider and ClaudeCodeOAuthProvider.
 */
export function buildAnthropicAuthUrl(
	config: OAuthProviderConfig,
	pkce: PKCEChallenge,
): string {
	const url = new URL(config.authorizeUrl);
	url.searchParams.set("code", "true");
	url.searchParams.set("client_id", config.clientId);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("redirect_uri", config.redirectUri);
	url.searchParams.set("scope", config.scopes.join(" "));
	url.searchParams.set("code_challenge", pkce.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", pkce.verifier);
	return url.toString();
}

/**
 * Exchange an authorization code for tokens using the Anthropic-family JSON
 * token endpoint. Handles `code.split("#")` for state extraction and parses
 * standard Anthropic OAuth error payloads.
 *
 * @param providerLabel - Provider name used in OAuthError (e.g. "anthropic", "claude-code")
 */
export async function exchangeAnthropicCode(
	code: string,
	verifier: string,
	config: OAuthProviderConfig,
	providerLabel: string,
): Promise<TokenResult> {
	const splits = code.split("#");
	const response = await fetch(config.tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			code: splits[0],
			state: splits[1],
			grant_type: "authorization_code",
			client_id: config.clientId,
			redirect_uri: config.redirectUri,
			code_verifier: verifier,
		}),
	});

	if (!response.ok) {
		let errorDetails: { error?: string; error_description?: string } | null =
			null;
		try {
			errorDetails = await response.json();
		} catch {
			// Failed to parse error response
		}

		const errorMessage =
			errorDetails?.error_description ||
			errorDetails?.error ||
			response.statusText ||
			"OAuth token exchange failed";

		throw new OAuthError(errorMessage, providerLabel, errorDetails?.error);
	}

	const json = (await response.json()) as {
		refresh_token: string;
		access_token: string;
		expires_in: number;
	};

	return {
		refreshToken: json.refresh_token,
		accessToken: json.access_token,
		expiresAt: Date.now() + json.expires_in * 1000,
	};
}
