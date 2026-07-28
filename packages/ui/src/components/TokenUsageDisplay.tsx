import { formatCost } from "@ccflare/core";
import {
	formatDuration,
	formatTokens,
	formatTokensPerSecond,
} from "../formatters";

/**
 * Token usage data structure
 */
export interface TokenUsageData {
	inputTokens?: number | null;
	outputTokens?: number | null;
	reasoningTokens?: number | null;
	cacheReadInputTokens?: number | null;
	cacheCreationInputTokens?: number | null;
	totalTokens?: number | null;
	costUsd?: number | null;
	responseTimeMs?: number | null;
	tokensPerSecond?: number | null;
	ttftMs?: number | null;
	proxyOverheadMs?: number | null;
	upstreamTtfbMs?: number | null;
	streamingDurationMs?: number | null;
}

/**
 * Processed token usage information for display
 */
export interface TokenUsageInfo {
	hasData: boolean;
	sections: {
		inputTokens?: { label: string; value: string };
		outputTokens?: { label: string; value: string };
		reasoningTokens?: { label: string; value: string };
		cacheReadTokens?: { label: string; value: string };
		cacheCreationTokens?: { label: string; value: string };
		totalTokens?: { label: string; value: string };
		cost?: { label: string; value: string };
		responseTime?: { label: string; value: string };
		tokensPerSecond?: { label: string; value: string };
		ttft?: { label: string; value: string };
		proxyOverhead?: { label: string; value: string };
		upstreamTtfb?: { label: string; value: string };
		streamingDuration?: { label: string; value: string };
	};
}

/**
 * Process token usage data for display
 * This contains the shared business logic for both dashboard and TUI
 */
export function processTokenUsage(
	data: TokenUsageData | undefined,
): TokenUsageInfo {
	const hasAnyUsageData =
		!!data &&
		([
			data.inputTokens,
			data.outputTokens,
			data.reasoningTokens,
			data.cacheReadInputTokens,
			data.cacheCreationInputTokens,
			data.totalTokens,
		].some((value) => typeof value === "number" && value > 0) ||
			typeof data.responseTimeMs === "number" ||
			typeof data.ttftMs === "number" ||
			typeof data.proxyOverheadMs === "number" ||
			typeof data.upstreamTtfbMs === "number" ||
			typeof data.streamingDurationMs === "number" ||
			(typeof data.costUsd === "number" && data.costUsd > 0) ||
			(typeof data.tokensPerSecond === "number" && data.tokensPerSecond > 0));

	if (!hasAnyUsageData) {
		return {
			hasData: false,
			sections: {},
		};
	}

	const sections: TokenUsageInfo["sections"] = {};

	// Input tokens
	if (data.inputTokens !== undefined) {
		sections.inputTokens = {
			label: "Input Tokens",
			value: formatTokens(data.inputTokens),
		};
	}

	// Output tokens
	if (data.outputTokens !== undefined) {
		sections.outputTokens = {
			label: "Output Tokens",
			value: formatTokens(data.outputTokens),
		};
	}

	// Reasoning tokens
	if (typeof data.reasoningTokens === "number" && data.reasoningTokens > 0) {
		sections.reasoningTokens = {
			label: "Reasoning Tokens",
			value: formatTokens(data.reasoningTokens),
		};
	}

	// Cache read tokens
	if (
		typeof data.cacheReadInputTokens === "number" &&
		data.cacheReadInputTokens > 0
	) {
		sections.cacheReadTokens = {
			label: "Cache Read Tokens",
			value: formatTokens(data.cacheReadInputTokens),
		};
	}

	// Cache creation tokens
	if (
		typeof data.cacheCreationInputTokens === "number" &&
		data.cacheCreationInputTokens > 0
	) {
		sections.cacheCreationTokens = {
			label: "Cache Creation Tokens",
			value: formatTokens(data.cacheCreationInputTokens),
		};
	}

	// Total tokens
	if (typeof data.totalTokens === "number") {
		sections.totalTokens = {
			label: "Total Tokens",
			value: formatTokens(data.totalTokens),
		};
	}

	// Cost
	if (typeof data.costUsd === "number" && data.costUsd > 0) {
		sections.cost = {
			label: "Cost",
			value: formatCost(data.costUsd),
		};
	}

	// Response time
	if (typeof data.responseTimeMs === "number") {
		sections.responseTime = {
			label: "Response Time",
			value: formatDuration(data.responseTimeMs),
		};
	}

	// Tokens per second
	if (typeof data.tokensPerSecond === "number" && data.tokensPerSecond > 0) {
		sections.tokensPerSecond = {
			label: "Speed",
			value: formatTokensPerSecond(data.tokensPerSecond),
		};
	}

	if (typeof data.ttftMs === "number") {
		sections.ttft = {
			label: "TTFT",
			value: formatDuration(data.ttftMs),
		};
	}

	if (typeof data.proxyOverheadMs === "number") {
		sections.proxyOverhead = {
			label: "Proxy Overhead",
			value: formatDuration(data.proxyOverheadMs),
		};
	}

	if (typeof data.upstreamTtfbMs === "number") {
		sections.upstreamTtfb = {
			label: "Upstream TTFB",
			value: formatDuration(data.upstreamTtfbMs),
		};
	}

	if (typeof data.streamingDurationMs === "number") {
		sections.streamingDuration = {
			label: "Streaming Duration",
			value: formatDuration(data.streamingDurationMs),
		};
	}

	return {
		hasData: true,
		sections,
	};
}

/**
 * Helper to determine if there are cache tokens to display
 */
export function hasCacheTokens(data: TokenUsageData | undefined): boolean {
	if (!data) return false;
	return (
		(typeof data.cacheReadInputTokens === "number" &&
			data.cacheReadInputTokens > 0) ||
		(typeof data.cacheCreationInputTokens === "number" &&
			data.cacheCreationInputTokens > 0)
	);
}
