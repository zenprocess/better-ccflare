import type { OAuthProvider, Provider } from "./types";

type ProviderWithOAuth = Provider & {
	supportsOAuth: () => boolean;
	getOAuthProvider: () => OAuthProvider;
};

export interface ResolvedProvider {
	provider: Provider;
	upstreamPath: string;
	query: string;
}

function supportsOAuth(provider: Provider): provider is ProviderWithOAuth {
	return (
		"supportsOAuth" in provider &&
		typeof provider.supportsOAuth === "function" &&
		"getOAuthProvider" in provider &&
		typeof provider.getOAuthProvider === "function"
	);
}

export class ProviderRegistry {
	private providers = new Map<string, Provider>();
	private oauthProviders = new Map<string, OAuthProvider>();

	constructor(providers: Provider[] = []) {
		for (const provider of providers) {
			this.registerProvider(provider);
		}
	}

	/**
	 * Register a provider
	 */
	registerProvider(provider: Provider): void {
		this.providers.set(provider.name, provider);

		// Auto-register OAuth provider if supported
		if (supportsOAuth(provider) && provider.supportsOAuth()) {
			this.oauthProviders.set(provider.name, provider.getOAuthProvider());
		}
	}

	/**
	 * Get a provider by name
	 */
	getProvider(name: string): Provider | undefined {
		return this.providers.get(name);
	}

	/**
	 * Get an OAuth provider by name
	 */
	getOAuthProvider(name: string): OAuthProvider | undefined {
		return this.oauthProviders.get(name);
	}

	/**
	 * List all registered provider names
	 */
	listProviders(): string[] {
		return Array.from(this.providers.keys());
	}

	/**
	 * List all providers that support OAuth
	 */
	listOAuthProviders(): string[] {
		return Array.from(this.oauthProviders.keys());
	}

	/**
	 * Resolve a provider-prefixed route into a provider and upstream path.
	 */
	resolveProvider(pathname: string): ResolvedProvider | null {
		const queryIndex = pathname.indexOf("?");
		const path = queryIndex >= 0 ? pathname.slice(0, queryIndex) : pathname;
		const query = queryIndex >= 0 ? pathname.slice(queryIndex) : "";

		if (!path.startsWith("/v1/")) {
			return null;
		}

		const remainder = path.slice("/v1/".length);
		if (!remainder) {
			return null;
		}

		const slashIndex = remainder.indexOf("/");
		const providerName =
			slashIndex >= 0 ? remainder.slice(0, slashIndex) : remainder;

		if (!providerName) {
			return null;
		}

		const provider = this.getProvider(providerName);
		if (!provider) {
			return null;
		}

		const upstreamPath =
			slashIndex >= 0 ? remainder.slice(slashIndex) || "/" : "/";

		return {
			provider,
			upstreamPath,
			query,
		};
	}

	/**
	 * Unregister a provider (useful for testing)
	 */
	unregisterProvider(name: string): boolean {
		this.oauthProviders.delete(name);
		return this.providers.delete(name);
	}

	/**
	 * Clear all providers (useful for testing)
	 */
	clear(): void {
		this.providers.clear();
		this.oauthProviders.clear();
	}
}

// Create singleton registry instance
export const registry = new ProviderRegistry();
export const createProviderRegistry = (providers: Provider[] = []) =>
	new ProviderRegistry(providers);

// Export convenience functions
export const registerProvider = (provider: Provider) =>
	registry.registerProvider(provider);
export const getOAuthProvider = (name: string) =>
	registry.getOAuthProvider(name);
export const resolveProvider = (pathname: string) =>
	registry.resolveProvider(pathname);
