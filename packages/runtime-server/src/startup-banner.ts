import { DEFAULT_STRATEGY } from "@ccflare/core";

export function createStartupBanner(options: {
	version: string;
	port: number;
	withDashboard: boolean;
	strategy: string;
	providers: string[];
}): string {
	const { version, port, withDashboard, strategy, providers } = options;
	const dashboardUrl = withDashboard ? `http://localhost:${port}` : "disabled";
	const supportedProviders = providers.join(", ");

	return `
🎯 ccflare Server v${version}
🌐 Port: ${port}
📊 Dashboard: ${dashboardUrl}
🔗 Management API: http://localhost:${port}/api
🔀 Provider routes: http://localhost:${port}/v1/{provider}/*
🧩 Compatibility routes: http://localhost:${port}/v1/ccflare/*

Available endpoints:
- POST   http://localhost:${port}/v1/{provider}/*      → Proxy native provider APIs
- POST   http://localhost:${port}/v1/ccflare/*         → Translate Anthropic/OpenAI-compatible requests
- GET    http://localhost:${port}/api/accounts         → List accounts
- POST   http://localhost:${port}/api/accounts         → Add account
- DELETE http://localhost:${port}/api/accounts/:id     → Remove account
- GET    http://localhost:${port}/api/stats            → View statistics
- POST   http://localhost:${port}/api/stats/reset      → Reset statistics
- GET    http://localhost:${port}/api/config           → View configuration
- PATCH  http://localhost:${port}/api/config           → Update configuration

Supported providers: ${supportedProviders}
⚡ Ready to proxy requests.
⚙️  Current strategy: ${strategy} (default: ${DEFAULT_STRATEGY})`;
}
