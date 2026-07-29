import { isRecord } from "@ccflare/types";
import type {
	ChatToAnthropicStreamState,
	JsonRecord,
	SseFrame,
} from "../../types";
import { buildAnthropicTextBlock } from "../content-parts";
import {
	buildSseFrame,
	createTransformedSseResponse,
	generateId,
	isStreamingResponse,
	jsonResponse,
	maybeParseJson,
	normalizeOpenAIUsage,
	openAIFinishToAnthropicStop,
	textContentFromUnknown,
	toAnthropicUsage,
} from "../shared";

export async function transformOpenAIChatResponseToAnthropic(
	response: Response,
): Promise<Response> {
	if (isStreamingResponse(response)) {
		const state: ChatToAnthropicStreamState = {
			messageId: generateId("msg"),
			model: "",
			createdAt: Math.floor(Date.now() / 1000),
			started: false,
			textStarted: false,
			textIndex: 0,
			toolIndexes: new Map(),
			toolNames: new Map(),
			toolIds: new Map(),
			emittedToolStarts: new Set(),
			usage: {},
			stopReason: null,
		};
		return createTransformedSseResponse(response, (frame) =>
			transformOpenAIChatFrameToAnthropic(frame, state),
		);
	}

	const body = (await response.json()) as JsonRecord;
	return jsonResponse(
		convertOpenAIChatJsonToAnthropic(body),
		response,
		"application/json; charset=utf-8",
	);
}

function convertOpenAIChatJsonToAnthropic(body: JsonRecord): JsonRecord {
	const choice =
		Array.isArray(body.choices) && isRecord(body.choices[0])
			? (body.choices[0] as JsonRecord)
			: {};
	const message = isRecord(choice.message) ? choice.message : {};
	const content = [];
	const text = textContentFromUnknown(message.content);
	if (text) {
		content.push(buildAnthropicTextBlock(text));
	}
	if (Array.isArray(message.tool_calls)) {
		for (const toolCall of message.tool_calls) {
			if (!isRecord(toolCall) || !isRecord(toolCall.function)) continue;
			content.push({
				type: "tool_use",
				id: typeof toolCall.id === "string" ? toolCall.id : generateId("toolu"),
				name:
					typeof toolCall.function.name === "string"
						? toolCall.function.name
						: "tool",
				input:
					typeof toolCall.function.arguments === "string"
						? (maybeParseJson(toolCall.function.arguments) ?? {})
						: (toolCall.function.arguments ?? {}),
			});
		}
	}
	return {
		id: typeof body.id === "string" ? body.id : generateId("msg"),
		type: "message",
		role: "assistant",
		model: typeof body.model === "string" ? body.model : "unknown",
		content,
		stop_reason: openAIFinishToAnthropicStop(
			typeof choice.finish_reason === "string" ? choice.finish_reason : null,
		),
		stop_sequence: null,
		usage: toAnthropicUsage(normalizeOpenAIUsage(body.usage)),
	};
}

function transformOpenAIChatFrameToAnthropic(
	frame: SseFrame,
	state: ChatToAnthropicStreamState,
): string[] {
	const rawData = frame.data.trim();
	if (rawData === "[DONE]") {
		const outputs: string[] = [];
		for (const [index] of state.toolIndexes) {
			outputs.push(
				buildSseFrame("content_block_stop", {
					type: "content_block_stop",
					index,
				}),
			);
		}
		if (state.textStarted) {
			outputs.push(
				buildSseFrame("content_block_stop", {
					type: "content_block_stop",
					index: state.textIndex,
				}),
			);
		}
		outputs.push(
			buildSseFrame("message_delta", {
				type: "message_delta",
				delta: {
					stop_reason: openAIFinishToAnthropicStop(state.stopReason ?? "stop"),
					stop_sequence: null,
				},
				usage: state.usage,
			}),
		);
		outputs.push(
			buildSseFrame("message_stop", {
				type: "message_stop",
			}),
		);
		return outputs;
	}

	const payload = maybeParseJson(rawData);
	if (!isRecord(payload)) return [];
	const outputs: string[] = [];
	const choice =
		Array.isArray(payload.choices) && isRecord(payload.choices[0])
			? (payload.choices[0] as JsonRecord)
			: {};
	const delta = isRecord(choice.delta) ? choice.delta : {};

	if (!state.started) {
		state.started = true;
		state.model =
			typeof payload.model === "string" ? payload.model : state.model;
		state.messageId =
			typeof payload.id === "string" ? payload.id : state.messageId;
		state.createdAt =
			typeof payload.created === "number" ? payload.created : state.createdAt;
		outputs.push(
			buildSseFrame("message_start", {
				type: "message_start",
				message: {
					id: state.messageId,
					type: "message",
					role: "assistant",
					model: state.model,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: state.usage,
				},
			}),
		);
	}

	if (typeof choice.finish_reason === "string" && choice.finish_reason) {
		state.stopReason = choice.finish_reason;
	}
	if (isRecord(payload.usage)) {
		state.usage = toAnthropicUsage(normalizeOpenAIUsage(payload.usage));
	}

	if (typeof delta.content === "string" && delta.content) {
		if (!state.textStarted) {
			state.textStarted = true;
			outputs.push(
				buildSseFrame("content_block_start", {
					type: "content_block_start",
					index: state.textIndex,
					content_block: { type: "text", text: "" },
				}),
			);
		}
		outputs.push(
			buildSseFrame("content_block_delta", {
				type: "content_block_delta",
				index: state.textIndex,
				delta: { type: "text_delta", text: delta.content },
			}),
		);
	}

	if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
		outputs.push(
			buildSseFrame("content_block_delta", {
				type: "content_block_delta",
				index: state.textIndex,
				delta: { type: "thinking_delta", thinking: delta.reasoning_content },
			}),
		);
	}

	if (Array.isArray(delta.tool_calls)) {
		for (const toolCall of delta.tool_calls) {
			if (!isRecord(toolCall)) continue;
			const sourceIndex =
				typeof toolCall.index === "number"
					? toolCall.index
					: state.toolIndexes.size;
			let anthropicIndex = state.toolIndexes.get(sourceIndex);
			if (anthropicIndex === undefined) {
				anthropicIndex = state.textStarted
					? state.toolIndexes.size + 1
					: state.toolIndexes.size;
				state.toolIndexes.set(sourceIndex, anthropicIndex);
			}

			if (typeof toolCall.id === "string" && toolCall.id) {
				state.toolIds.set(sourceIndex, toolCall.id);
			}
			if (
				isRecord(toolCall.function) &&
				typeof toolCall.function.name === "string"
			) {
				state.toolNames.set(sourceIndex, toolCall.function.name);
			}

			if (!state.emittedToolStarts.has(anthropicIndex)) {
				state.emittedToolStarts.add(anthropicIndex);
				outputs.push(
					buildSseFrame("content_block_start", {
						type: "content_block_start",
						index: anthropicIndex,
						content_block: {
							type: "tool_use",
							id: state.toolIds.get(sourceIndex) ?? generateId("toolu"),
							name: state.toolNames.get(sourceIndex) ?? "tool",
							input: {},
						},
					}),
				);
			}
			if (
				isRecord(toolCall.function) &&
				typeof toolCall.function.arguments === "string"
			) {
				outputs.push(
					buildSseFrame("content_block_delta", {
						type: "content_block_delta",
						index: anthropicIndex,
						delta: {
							type: "input_json_delta",
							partial_json: toolCall.function.arguments,
						},
					}),
				);
			}
		}
	}

	return outputs;
}
