import { describe, expect, it } from "bun:test";
import { ProviderRegistry } from "@ccflare/providers";
import type { ProxyContext } from "@ccflare/proxy";
import { createServerFetchHandler, createStartupBanner } from "./server";

function createProxyContext(): ProxyContext {
	return {
		providerRegistry: new ProviderRegistry(),
		strategy: {
			select() {
				return [];
			},
		},
		dbOps: {
			getAllAccounts() {
				return [];
			},
			getAccountsByProvider() {
				return [];
			},
		},
		runtime: {
			clientId: "test-client",
			retry: {
				attempts: 1,
				delayMs: 0,
				backoff: 1,
			},
			sessionDurationMs: 0,
			port: 8080,
		},
		refreshInFlight: new Map(),
		asyncWriter: {
			enqueue() {},
		},
		usageWorker: {
			postMessage() {},
		} as unknown as Worker,
	} as unknown as ProxyContext;
}

describe("createServerFetchHandler", () => {
	it("describes multi-provider routing in the startup banner", () => {
		const banner = createStartupBanner({
			version: "1.0.0",
			port: 8080,
			withDashboard: true,
			strategy: "session",
			providers: ["anthropic", "openai"],
		});

		expect(banner).toContain("/v1/{provider}/*");
		expect(banner).toContain("Proxy native provider APIs");
		expect(banner).toContain("Supported providers: anthropic, openai");
		expect(banner).not.toContain("Claude API");
	});

	it("routes provider-prefixed requests to the proxy handler", async () => {
		let proxyCalls = 0;
		const fetchHandler = createServerFetchHandler({
			apiRouter: {
				handleRequest: async () => null,
			},
			proxyContext: createProxyContext(),
			withDashboard: true,
			handleProxyRequest: async () => {
				proxyCalls += 1;
				return new Response("proxied");
			},
			serveDashboardAsset: () => null,
		});

		const response = await fetchHandler(
			new Request("http://localhost:8080/v1/anthropic/v1/messages", {
				method: "POST",
			}),
		);

		if (!response) {
			throw new Error("Expected an HTTP response");
		}

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("proxied");
		expect(proxyCalls).toBe(1);
	});

	it("routes /v1/ccflare compatibility requests before the provider proxy", async () => {
		let compatibilityCalls = 0;
		let proxyCalls = 0;
		const fetchHandler = createServerFetchHandler({
			apiRouter: {
				handleRequest: async () => null,
			},
			proxyContext: createProxyContext(),
			withDashboard: true,
			handleCompatibilityRequest: async () => {
				compatibilityCalls += 1;
				return new Response("compat");
			},
			handleProxyRequest: async () => {
				proxyCalls += 1;
				return new Response("proxied");
			},
			serveDashboardAsset: () => null,
		});

		const response = await fetchHandler(
			new Request("http://localhost:8080/v1/ccflare/openai/chat/completions", {
				method: "POST",
				body: JSON.stringify({ model: "openai/gpt-4o-mini" }),
				headers: { "content-type": "application/json" },
			}),
		);

		if (!response) {
			throw new Error("Expected an HTTP response");
		}

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("compat");
		expect(compatibilityCalls).toBe(1);
		expect(proxyCalls).toBe(0);
	});

	it("routes websocket upgrade requests through the websocket upgrader", async () => {
		let proxyCalls = 0;
		let upgradeCalls = 0;
		const fetchHandler = createServerFetchHandler({
			apiRouter: {
				handleRequest: async () => null,
			},
			proxyContext: createProxyContext(),
			withDashboard: true,
			handleProxyRequest: async () => {
				proxyCalls += 1;
				return new Response("proxied");
			},
			handleWebSocketUpgrade: () => {
				upgradeCalls += 1;
				return undefined;
			},
			serveDashboardAsset: () => null,
		});

		const response = await fetchHandler(
			new Request("http://localhost:8080/v1/codex/responses", {
				method: "GET",
				headers: {
					connection: "Upgrade",
					upgrade: "websocket",
				},
			}),
			{
				upgrade() {
					return true;
				},
			} as unknown as Bun.Server<unknown>,
		);

		expect(response).toBeUndefined();
		expect(upgradeCalls).toBe(1);
		expect(proxyCalls).toBe(0);
	});

	it("returns 404 for non-v1 proxy-like routes instead of falling back", async () => {
		let proxyCalls = 0;
		let dashboardCalls = 0;
		const fetchHandler = createServerFetchHandler({
			apiRouter: {
				handleRequest: async () => null,
			},
			proxyContext: createProxyContext(),
			withDashboard: true,
			handleProxyRequest: async () => {
				proxyCalls += 1;
				return new Response("proxied");
			},
			serveDashboardAsset: () => {
				dashboardCalls += 1;
				return new Response("dashboard");
			},
		});

		const response = await fetchHandler(
			new Request("http://localhost:8080/v2/messages", {
				method: "POST",
			}),
		);

		if (!response) {
			throw new Error("Expected an HTTP response");
		}

		expect(response.status).toBe(404);
		expect(proxyCalls).toBe(0);
		expect(dashboardCalls).toBe(0);
	});
});
