import type { JsonRecord } from "../types";

const OPENAI_RESPONSES_REQUEST_FIELDS = [
	"instructions",
	"max_output_tokens",
	"max_tool_calls",
	"parallel_tool_calls",
	"previous_response_id",
	"prompt_cache_key",
	"reasoning",
	"safety_identifier",
	"service_tier",
	"store",
	"temperature",
	"text",
	"tool_choice",
	"tools",
	"top_logprobs",
	"top_p",
	"truncation",
	"user",
	"metadata",
] as const;

export function applyOpenAIResponsesRequestFields(
	responseBody: JsonRecord,
	originalRequest?: JsonRecord,
): JsonRecord {
	if (!originalRequest) {
		return responseBody;
	}

	const merged: JsonRecord = { ...responseBody };
	for (const field of OPENAI_RESPONSES_REQUEST_FIELDS) {
		if (originalRequest[field] !== undefined) {
			merged[field] = originalRequest[field];
		}
	}

	return merged;
}
