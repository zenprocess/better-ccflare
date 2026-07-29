import { Config } from "@ccflare/config";
import type { StrategyName, StrategyResponse } from "@ccflare/types";

async function getPort(): Promise<number> {
	const config = new Config();
	const runtime = config.getRuntime();
	return runtime.port || 8080;
}

export async function getStrategy(): Promise<StrategyName> {
	const port = await getPort();
	const baseUrl = `http://localhost:${port}`;
	const res = await fetch(`${baseUrl}/api/config/strategy`);
	if (!res.ok) throw new Error("Failed to fetch strategy");
	const data = (await res.json()) as StrategyResponse;
	return data.strategy;
}

export async function listStrategies(): Promise<StrategyName[]> {
	const port = await getPort();
	const baseUrl = `http://localhost:${port}`;
	const res = await fetch(`${baseUrl}/api/strategies`);
	if (!res.ok) throw new Error("Failed to list strategies");
	return res.json() as Promise<StrategyName[]>;
}

export async function setStrategy(strategy: StrategyName): Promise<void> {
	const port = await getPort();
	const baseUrl = `http://localhost:${port}`;
	const res = await fetch(`${baseUrl}/api/config/strategy`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ strategy }),
	});
	if (!res.ok) {
		const error = (await res.json()) as { error?: string };
		throw new Error(error.error || "Failed to set strategy");
	}
}
