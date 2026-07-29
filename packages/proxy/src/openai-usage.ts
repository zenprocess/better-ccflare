import { isRecord } from "@ccflare/types";
import type { PreExtractedUsage } from "./worker-messages";

type UsageDetails = {
	cached_tokens?: number;
	reasoning_tokens?: number;
};

export type OpenAIUsagePayload = PreExtractedUsage & {
	input_tokens_details?: UsageDetails | null;
	prompt_tokens_details?: UsageDetails | null;
	output_tokens_details?: UsageDetails | null;
};

function getFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function parseUsageDetails(value: unknown): UsageDetails | null | undefined {
	if (value === null) {
		return null;
	}

	if (!isRecord(value)) {
		return undefined;
	}

	const cachedTokens = getFiniteNumber(value.cached_tokens);
	const reasoningTokens = getFiniteNumber(value.reasoning_tokens);

	return {
		...(cachedTokens !== undefined && { cached_tokens: cachedTokens }),
		...(reasoningTokens !== undefined && {
			reasoning_tokens: reasoningTokens,
		}),
	};
}

export function parseOpenAIUsagePayload(
	value: unknown,
): OpenAIUsagePayload | null {
	if (!isRecord(value)) {
		return null;
	}

	const parsed: OpenAIUsagePayload = {};
	const numericFields = [
		"prompt_tokens",
		"completion_tokens",
		"total_tokens",
		"input_tokens",
		"cache_read_input_tokens",
		"cache_creation_input_tokens",
		"output_tokens",
		"reasoning_tokens",
	] as const;

	for (const field of numericFields) {
		const numericValue = getFiniteNumber(value[field]);
		if (numericValue !== undefined) {
			parsed[field] = numericValue;
		}
	}

	const inputTokenDetails = parseUsageDetails(value.input_tokens_details);
	if (inputTokenDetails !== undefined) {
		parsed.input_tokens_details = inputTokenDetails;
	}

	const promptTokenDetails = parseUsageDetails(value.prompt_tokens_details);
	if (promptTokenDetails !== undefined) {
		parsed.prompt_tokens_details = promptTokenDetails;
	}

	const outputTokenDetails = parseUsageDetails(value.output_tokens_details);
	if (outputTokenDetails !== undefined) {
		parsed.output_tokens_details = outputTokenDetails;
	}

	return parsed;
}

export function normalizeOpenAIUsage(
	usage: OpenAIUsagePayload | null | undefined,
): PreExtractedUsage {
	if (!usage) {
		return {};
	}

	const normalized: PreExtractedUsage = {};
	const numericFields = [
		"prompt_tokens",
		"completion_tokens",
		"total_tokens",
		"input_tokens",
		"cache_read_input_tokens",
		"cache_creation_input_tokens",
		"output_tokens",
		"reasoning_tokens",
	] as const;

	for (const field of numericFields) {
		const value = getFiniteNumber(usage[field]);
		if (value !== undefined) {
			normalized[field] = value;
		}
	}

	const rawCachedTokens =
		getFiniteNumber(usage.input_tokens_details?.cached_tokens) ??
		getFiniteNumber(usage.prompt_tokens_details?.cached_tokens);
	if (rawCachedTokens !== undefined) {
		const inputTokens =
			getFiniteNumber(usage.input_tokens) ??
			getFiniteNumber(normalized.input_tokens);
		const promptTokens =
			getFiniteNumber(usage.prompt_tokens) ??
			getFiniteNumber(normalized.prompt_tokens);
		const maxCachedTokens = Math.max(
			0,
			inputTokens ?? promptTokens ?? rawCachedTokens,
		);
		const cachedTokens = Math.max(
			0,
			Math.min(rawCachedTokens, maxCachedTokens),
		);

		normalized.cache_read_input_tokens = cachedTokens;

		if (inputTokens !== undefined) {
			normalized.input_tokens = Math.max(0, inputTokens - cachedTokens);
		}

		if (promptTokens !== undefined) {
			normalized.prompt_tokens = Math.max(0, promptTokens - cachedTokens);
		}
	}

	const reasoningTokens = getFiniteNumber(
		usage.output_tokens_details?.reasoning_tokens,
	);
	if (reasoningTokens !== undefined) {
		normalized.reasoning_tokens = reasoningTokens;
	}

	return normalized;
}
