import { BUFFER_SIZES } from "@ccflare/core";
import {
	type Account,
	getProviderDefaultBaseUrl,
	isRecord,
} from "@ccflare/types";
import { BaseProvider, deleteTransportHeaders } from "../../base";
import type { RateLimitInfo } from "../../types";

type OpenAIUsagePayload = {
	model?: string;
	response?: {
		model?: string;
		usage?: {
			prompt_tokens?: number;
			completion_tokens?: number;
			total_tokens?: number;
			input_tokens?: number;
			output_tokens?: number;
		};
	};
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		input_tokens?: number;
		output_tokens?: number;
	};
	type?: string;
};

function parseUsageShape(value: unknown): OpenAIUsagePayload["usage"] {
	if (!isRecord(value)) {
		return undefined;
	}

	const parsedUsage = {
		...(typeof value.prompt_tokens === "number" && {
			prompt_tokens: value.prompt_tokens,
		}),
		...(typeof value.completion_tokens === "number" && {
			completion_tokens: value.completion_tokens,
		}),
		...(typeof value.total_tokens === "number" && {
			total_tokens: value.total_tokens,
		}),
		...(typeof value.input_tokens === "number" && {
			input_tokens: value.input_tokens,
		}),
		...(typeof value.output_tokens === "number" && {
			output_tokens: value.output_tokens,
		}),
	};

	return Object.keys(parsedUsage).length > 0 ? parsedUsage : undefined;
}

function parseOpenAIResponseEnvelope(
	value: unknown,
): OpenAIUsagePayload | null {
	if (!isRecord(value)) {
		return null;
	}

	const parsed: OpenAIUsagePayload = {};
	if (typeof value.model === "string") {
		parsed.model = value.model;
	}
	if (typeof value.type === "string") {
		parsed.type = value.type;
	}
	if (isRecord(value.response)) {
		const usage = parseUsageShape(value.response.usage);
		parsed.response = {
			...(typeof value.response.model === "string" && {
				model: value.response.model,
			}),
			...(usage && {
				usage,
			}),
		};
	}
	const usage = parseUsageShape(value.usage);
	if (usage) {
		parsed.usage = usage;
	}

	return parsed;
}

export function parseResetTime(headerValue: string | null): number | undefined {
	if (!headerValue) {
		return undefined;
	}

	const trimmed = headerValue.trim();
	if (!trimmed) {
		return undefined;
	}

	if (/^\d+(\.\d+)?$/.test(trimmed)) {
		const numericValue = Number(trimmed);
		if (!Number.isFinite(numericValue)) {
			return undefined;
		}

		return numericValue > 10_000_000_000 ? numericValue : numericValue * 1000;
	}

	const durationMatches = [...trimmed.matchAll(/(\d+)(ms|s|m|h|d)/g)];
	if (durationMatches.length > 0) {
		const matchedLength = durationMatches.reduce(
			(total, match) => total + match[0].length,
			0,
		);
		if (matchedLength === trimmed.length) {
			const durationMs = durationMatches.reduce((total, match) => {
				const value = Number(match[1]);
				const unit = match[2];
				const multiplier =
					unit === "d"
						? 24 * 60 * 60 * 1000
						: unit === "h"
							? 60 * 60 * 1000
							: unit === "m"
								? 60 * 1000
								: unit === "s"
									? 1000
									: 1;

				return total + value * multiplier;
			}, 0);

			return Date.now() + durationMs;
		}
	}

	const parsedDate = Date.parse(trimmed);
	return Number.isNaN(parsedDate) ? undefined : parsedDate;
}

export function parseInteger(value: string | null): number | undefined {
	if (!value) {
		return undefined;
	}

	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function extractUsageFromPayload(payload: OpenAIUsagePayload): {
	model?: string;
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
} | null {
	const model = payload.response?.model ?? payload.model;
	const usage = payload.response?.usage ?? payload.usage;

	if (!usage) {
		return null;
	}

	const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
	const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
	const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;

	return {
		model,
		promptTokens,
		completionTokens,
		totalTokens,
		inputTokens: promptTokens,
		outputTokens: completionTokens,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
	};
}

function extractUsageFromSseBuffer(buffer: string) {
	let currentEvent = "";

	for (const line of buffer.split("\n")) {
		if (line.startsWith("event: ")) {
			currentEvent = line.slice(7).trim();
			continue;
		}

		if (!line.startsWith("data: ")) {
			continue;
		}

		try {
			const payload = parseOpenAIResponseEnvelope(JSON.parse(line.slice(6)));
			if (!payload) {
				continue;
			}
			if (
				currentEvent === "response.completed" ||
				payload.type === "response.completed"
			) {
				return extractUsageFromPayload(payload);
			}
		} catch {
			// Ignore malformed SSE payloads
		}
	}

	return null;
}

const PROVIDER_NAME = "openai" as const;
const DEFAULT_BASE_URL = getProviderDefaultBaseUrl(PROVIDER_NAME);

export class OpenAIProvider extends BaseProvider {
	name: string = PROVIDER_NAME;
	defaultBaseUrl: string = DEFAULT_BASE_URL;

	prepareHeaders(headers: Headers, account: Account | null): Headers {
		const newHeaders = new Headers(headers);
		const token = account?.api_key;

		if (token) {
			newHeaders.set("Authorization", `Bearer ${token}`);
		}

		// Remove Anthropic-family headers that don't belong on OpenAI requests
		newHeaders.delete("x-api-key");
		newHeaders.delete("anthropic-version");

		deleteTransportHeaders(newHeaders);

		return newHeaders;
	}

	parseRateLimit(response: Response): RateLimitInfo {
		const standardLimit = response.headers.get("x-ratelimit-limit-requests");
		const standardRemaining = parseInteger(
			response.headers.get("x-ratelimit-remaining-requests"),
		);
		const standardReset = parseResetTime(
			response.headers.get("x-ratelimit-reset-requests"),
		);

		if (
			standardLimit !== null ||
			standardRemaining !== undefined ||
			standardReset !== undefined
		) {
			const isRateLimited = response.status === 429 || standardRemaining === 0;

			return {
				isRateLimited,
				resetTime: standardReset,
				statusHeader: isRateLimited ? "rate_limited" : "allowed",
				remaining: standardRemaining,
			};
		}

		const codexPrimaryUsed = parseInteger(
			response.headers.get("x-codex-primary-used-percent"),
		);
		const codexSecondaryUsed = parseInteger(
			response.headers.get("x-codex-secondary-used-percent"),
		);
		const codexResets = [
			parseResetTime(response.headers.get("x-codex-primary-reset-at")),
			parseResetTime(response.headers.get("x-codex-secondary-reset-at")),
		].filter((value): value is number => value !== undefined);

		if (
			codexPrimaryUsed !== undefined ||
			codexSecondaryUsed !== undefined ||
			codexResets.length > 0
		) {
			const isRateLimited =
				response.status === 429 ||
				codexPrimaryUsed === 100 ||
				codexSecondaryUsed === 100;

			return {
				isRateLimited,
				resetTime:
					codexResets.length > 0 ? Math.min(...codexResets) : undefined,
				statusHeader: isRateLimited ? "rate_limited" : "allowed",
			};
		}

		if (response.status !== 429) {
			return { isRateLimited: false };
		}

		return {
			isRateLimited: true,
			resetTime:
				parseResetTime(response.headers.get("retry-after")) ??
				parseResetTime(response.headers.get("x-ratelimit-reset-requests")),
		};
	}

	async extractUsageInfo(response: Response): Promise<{
		model?: string;
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		costUsd?: number;
		inputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		outputTokens?: number;
	} | null> {
		try {
			const clone = response.clone();

			if (this.isStreamingResponse?.(response)) {
				const reader = clone.body?.getReader();
				if (!reader) {
					return null;
				}

				const decoder = new TextDecoder();
				let buffered = "";
				let bytesRead = 0;

				try {
					while (bytesRead < BUFFER_SIZES.STREAM_BODY_MAX_BYTES) {
						const { value, done } = await reader.read();
						if (done) {
							break;
						}

						if (!value) {
							continue;
						}

						bytesRead += value.byteLength;
						buffered += decoder.decode(value, { stream: true });

						const usage = extractUsageFromSseBuffer(buffered);
						if (usage) {
							return usage;
						}
					}

					buffered += decoder.decode();
					return extractUsageFromSseBuffer(buffered);
				} finally {
					reader.cancel().catch(() => {});
				}
			}

			const json = (await clone.json()) as OpenAIUsagePayload;
			return extractUsageFromPayload(json);
		} catch {
			return null;
		}
	}

	isStreamingResponse(response: Response): boolean {
		const contentType = response.headers.get("content-type") ?? "";
		return contentType.includes("text/event-stream");
	}
}
