import { isRecord } from "@ccflare/types";
import type { JsonRecord } from "../../types";

export function applyOpenAIChatStructuredOutputs(
	input: JsonRecord,
	output: JsonRecord,
): void {
	const responseFormat = isRecord(input.response_format)
		? input.response_format
		: null;
	const text = isRecord(input.text) ? input.text : null;

	if (!responseFormat && !text) {
		return;
	}

	const outputText: JsonRecord = isRecord(output.text)
		? { ...output.text }
		: {};
	if (responseFormat && typeof responseFormat.type === "string") {
		if (responseFormat.type === "text") {
			outputText.format = { type: "text" };
		}
		if (
			responseFormat.type === "json_schema" &&
			isRecord(responseFormat.json_schema)
		) {
			const format: JsonRecord = { type: "json_schema" };
			if (typeof responseFormat.json_schema.name === "string") {
				format.name = responseFormat.json_schema.name;
			}
			if (typeof responseFormat.json_schema.strict === "boolean") {
				format.strict = responseFormat.json_schema.strict;
			}
			if (responseFormat.json_schema.schema !== undefined) {
				format.schema = responseFormat.json_schema.schema;
			}
			outputText.format = format;
		}
	}

	if (text && typeof text.verbosity === "string") {
		outputText.verbosity = text.verbosity;
	}

	if (Object.keys(outputText).length > 0) {
		output.text = outputText;
	}
}

export function mapOpenAIChatToolChoiceToResponses(
	toolChoice: unknown,
): unknown {
	if (typeof toolChoice === "string") {
		return toolChoice;
	}
	if (
		isRecord(toolChoice) &&
		toolChoice.type === "function" &&
		isRecord(toolChoice.function) &&
		typeof toolChoice.function.name === "string"
	) {
		return {
			type: "function",
			name: toolChoice.function.name,
		};
	}
	return toolChoice;
}
