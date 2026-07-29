import { isRecord } from "@ccflare/types";
import type { JsonRecord } from "../../types";
import {
	normalizeAnthropicConversation,
	renderConversationToOpenAIChatMessages,
	renderConversationToResponsesInput,
} from "../request-conversation";
import { applyAnthropicThinkingToOpenAI } from "../request-thinking";

function applyAnthropicBaseParams(input: JsonRecord, output: JsonRecord): void {
	if (typeof input.max_tokens === "number") {
		output.max_tokens = input.max_tokens;
	}
	if (typeof input.temperature === "number") {
		output.temperature = input.temperature;
	}
	if (typeof input.top_p === "number") {
		output.top_p = input.top_p;
	}
	applyAnthropicThinkingToOpenAI(input, output);
}

function mapAnthropicToolsToOpenAIChat(tools: unknown[]): JsonRecord[] {
	return tools
		.map((tool) => {
			if (!isRecord(tool)) return null;
			return {
				type: "function",
				function: {
					name: typeof tool.name === "string" ? tool.name : "tool",
					description:
						typeof tool.description === "string" ? tool.description : "",
					parameters: isRecord(tool.input_schema) ? tool.input_schema : {},
				},
			};
		})
		.filter(Boolean) as JsonRecord[];
}

function mapAnthropicToolChoiceToOpenAI(toolChoice: unknown): unknown {
	if (isRecord(toolChoice) && toolChoice.type === "tool") {
		return {
			type: "function",
			function: {
				name: typeof toolChoice.name === "string" ? toolChoice.name : "tool",
			},
		};
	}
	if (isRecord(toolChoice) && typeof toolChoice.type === "string") {
		return toolChoice.type === "any" ? "required" : toolChoice.type;
	}
	return undefined;
}

export function convertAnthropicRequestToOpenAIChat(
	input: JsonRecord,
	model: string,
): JsonRecord {
	const output: JsonRecord = {
		model,
		messages: [],
		stream: input.stream === true,
	};

	applyAnthropicBaseParams(input, output);
	if (Array.isArray(input.stop_sequences)) {
		output.stop = input.stop_sequences;
	}
	output.messages = renderConversationToOpenAIChatMessages(
		normalizeAnthropicConversation(input),
	);

	if (Array.isArray(input.tools)) {
		output.tools = mapAnthropicToolsToOpenAIChat(input.tools);
	}
	if (input.tool_choice != null) {
		const mapped = mapAnthropicToolChoiceToOpenAI(input.tool_choice);
		if (mapped !== undefined) {
			output.tool_choice = mapped;
		}
	}

	return output;
}

export function convertAnthropicRequestToOpenAIResponses(
	input: JsonRecord,
	model: string,
): JsonRecord {
	const output: JsonRecord = {
		model,
		stream: input.stream === true,
		store: false,
	};

	applyAnthropicBaseParams(input, output);
	if (typeof output.max_tokens === "number") {
		output.max_output_tokens = output.max_tokens;
		delete output.max_tokens;
	}
	if (output.reasoning_effort !== undefined) {
		output.reasoning = { effort: output.reasoning_effort };
		delete output.reasoning_effort;
	}

	const conversation = normalizeAnthropicConversation(input);
	const rendered = renderConversationToResponsesInput(conversation);
	output.input = rendered.input;
	output.instructions = rendered.instructions ?? "You are a helpful assistant.";

	if (Array.isArray(input.tools)) {
		output.tools = input.tools
			.map((tool) => {
				if (!isRecord(tool)) return null;
				return {
					type: "function",
					name: typeof tool.name === "string" ? tool.name : "tool",
					description:
						typeof tool.description === "string" ? tool.description : "",
					parameters: isRecord(tool.input_schema) ? tool.input_schema : {},
				};
			})
			.filter(Boolean);
	}
	if (input.tool_choice != null) {
		const mapped = mapAnthropicToolChoiceToOpenAI(input.tool_choice);
		if (mapped !== undefined) {
			if (
				isRecord(mapped) &&
				mapped.type === "function" &&
				isRecord(mapped.function) &&
				typeof mapped.function.name === "string"
			) {
				output.tool_choice = { type: "function", name: mapped.function.name };
			} else {
				output.tool_choice = mapped;
			}
		}
	}
	return output;
}
