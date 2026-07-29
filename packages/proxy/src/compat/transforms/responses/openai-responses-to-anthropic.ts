import { isRecord } from "@ccflare/types";
import type {
	JsonRecord,
	ResponsesToAnthropicStreamState,
	SseFrame,
} from "../../types";
import { convertOpenAIResponsesOutputToAnthropic } from "../response-content";
import {
	buildSseFrame,
	createTransformedSseResponse,
	generateId,
	isStreamingResponse,
	jsonResponse,
	maybeParseJson,
	normalizeOpenAIUsage,
	toAnthropicUsage,
} from "../shared";

export async function transformOpenAIResponsesResponseToAnthropic(
	response: Response,
): Promise<Response> {
	if (isStreamingResponse(response)) {
		const state: ResponsesToAnthropicStreamState = {
			messageId: generateId("msg"),
			model: "",
			usage: {},
			started: false,
			hasContent: false,
			hasToolCalls: false,
			messageIndexes: new Map(),
			functionIndexes: new Map(),
			functionNames: new Map(),
			reasoningIndexes: new Map(),
			nextIndex: 0,
		};
		return createTransformedSseResponse(response, (frame) =>
			transformOpenAIResponsesFrameToAnthropic(frame, state),
		);
	}

	const body = (await response.json()) as JsonRecord;
	return jsonResponse(
		convertOpenAIResponsesJsonToAnthropic(body),
		response,
		"application/json; charset=utf-8",
	);
}

function convertOpenAIResponsesJsonToAnthropic(body: JsonRecord): JsonRecord {
	const source = isRecord(body.response) ? (body.response as JsonRecord) : body;
	const { content, hasToolCalls } = convertOpenAIResponsesOutputToAnthropic(
		source.output,
	);
	return {
		id: typeof source.id === "string" ? source.id : generateId("msg"),
		type: "message",
		role: "assistant",
		model: typeof source.model === "string" ? source.model : "unknown",
		content,
		stop_reason: hasToolCalls ? "tool_use" : "end_turn",
		stop_sequence: null,
		usage: toAnthropicUsage(normalizeOpenAIUsage(source.usage)),
	};
}

function transformOpenAIResponsesFrameToAnthropic(
	frame: SseFrame,
	state: ResponsesToAnthropicStreamState,
): string[] {
	const payload = maybeParseJson(frame.data);
	if (!isRecord(payload)) return [];
	const outputs: string[] = [];
	const type = typeof payload.type === "string" ? payload.type : frame.event;

	if (type === "response.created" && isRecord(payload.response)) {
		state.started = true;
		state.messageId =
			typeof payload.response.id === "string"
				? payload.response.id
				: state.messageId;
		state.model =
			typeof payload.response.model === "string"
				? payload.response.model
				: state.model;
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
		return outputs;
	}

	if (type === "response.output_item.added" && isRecord(payload.item)) {
		const outputIndex =
			typeof payload.output_index === "number"
				? payload.output_index
				: state.nextIndex++;
		if (payload.item.type === "message") {
			const index = state.nextIndex++;
			state.hasContent = true;
			state.messageIndexes.set(
				typeof payload.item.id === "string"
					? payload.item.id
					: String(outputIndex),
				index,
			);
			outputs.push(
				buildSseFrame("content_block_start", {
					type: "content_block_start",
					index,
					content_block: { type: "text", text: "" },
				}),
			);
		}
		if (payload.item.type === "function_call") {
			const index = state.nextIndex++;
			state.hasContent = true;
			state.hasToolCalls = true;
			const itemId =
				typeof payload.item.id === "string"
					? payload.item.id
					: String(outputIndex);
			state.functionIndexes.set(itemId, index);
			state.functionNames.set(
				itemId,
				typeof payload.item.name === "string" ? payload.item.name : "tool",
			);
			outputs.push(
				buildSseFrame("content_block_start", {
					type: "content_block_start",
					index,
					content_block: {
						type: "tool_use",
						id:
							typeof payload.item.call_id === "string"
								? payload.item.call_id
								: generateId("toolu"),
						name: state.functionNames.get(itemId) ?? "tool",
						input: {},
					},
				}),
			);
		}
		if (payload.item.type === "reasoning") {
			const index = state.nextIndex++;
			state.hasContent = true;
			const itemId =
				typeof payload.item.id === "string"
					? payload.item.id
					: String(outputIndex);
			state.reasoningIndexes.set(itemId, index);
			outputs.push(
				buildSseFrame("content_block_start", {
					type: "content_block_start",
					index,
					content_block: { type: "thinking", thinking: "" },
				}),
			);
		}
		return outputs;
	}

	if (
		type === "response.output_text.delta" &&
		typeof payload.delta === "string"
	) {
		const itemId = typeof payload.item_id === "string" ? payload.item_id : "";
		const index = state.messageIndexes.get(itemId);
		if (index !== undefined) {
			outputs.push(
				buildSseFrame("content_block_delta", {
					type: "content_block_delta",
					index,
					delta: { type: "text_delta", text: payload.delta },
				}),
			);
		}
		return outputs;
	}

	if (
		type === "response.function_call_arguments.delta" &&
		typeof payload.delta === "string"
	) {
		const itemId = typeof payload.item_id === "string" ? payload.item_id : "";
		const index = state.functionIndexes.get(itemId);
		if (index !== undefined) {
			outputs.push(
				buildSseFrame("content_block_delta", {
					type: "content_block_delta",
					index,
					delta: { type: "input_json_delta", partial_json: payload.delta },
				}),
			);
		}
		return outputs;
	}

	if (
		type === "response.reasoning_summary_text.delta" &&
		typeof payload.delta === "string"
	) {
		const itemId = typeof payload.item_id === "string" ? payload.item_id : "";
		const index = state.reasoningIndexes.get(itemId);
		if (index !== undefined) {
			outputs.push(
				buildSseFrame("content_block_delta", {
					type: "content_block_delta",
					index,
					delta: { type: "thinking_delta", thinking: payload.delta },
				}),
			);
		}
		return outputs;
	}

	if (type === "response.output_item.done" && isRecord(payload.item)) {
		const itemId = typeof payload.item.id === "string" ? payload.item.id : "";
		const index =
			state.messageIndexes.get(itemId) ??
			state.functionIndexes.get(itemId) ??
			state.reasoningIndexes.get(itemId);
		if (index !== undefined) {
			outputs.push(
				buildSseFrame("content_block_stop", {
					type: "content_block_stop",
					index,
				}),
			);
		}
		return outputs;
	}

	if (type === "response.completed" && isRecord(payload.response)) {
		if (!state.hasContent && Array.isArray(payload.response.output)) {
			let fallbackIndex = 0;
			for (const item of payload.response.output) {
				if (!isRecord(item)) continue;
				if (item.type === "message" && Array.isArray(item.content)) {
					for (const part of item.content) {
						if (!isRecord(part) || typeof part.text !== "string") continue;
						outputs.push(
							buildSseFrame("content_block_start", {
								type: "content_block_start",
								index: fallbackIndex,
								content_block: { type: "text", text: "" },
							}),
						);
						outputs.push(
							buildSseFrame("content_block_delta", {
								type: "content_block_delta",
								index: fallbackIndex,
								delta: { type: "text_delta", text: part.text },
							}),
						);
						outputs.push(
							buildSseFrame("content_block_stop", {
								type: "content_block_stop",
								index: fallbackIndex,
							}),
						);
						fallbackIndex += 1;
					}
				}
				if (item.type === "function_call") {
					state.hasToolCalls = true;
					const callId =
						typeof item.call_id === "string"
							? item.call_id
							: generateId("toolu");
					const name = typeof item.name === "string" ? item.name : "tool";
					outputs.push(
						buildSseFrame("content_block_start", {
							type: "content_block_start",
							index: fallbackIndex,
							content_block: {
								type: "tool_use",
								id: callId,
								name,
								input: {},
							},
						}),
					);
					if (typeof item.arguments === "string" && item.arguments) {
						outputs.push(
							buildSseFrame("content_block_delta", {
								type: "content_block_delta",
								index: fallbackIndex,
								delta: {
									type: "input_json_delta",
									partial_json: item.arguments,
								},
							}),
						);
					}
					outputs.push(
						buildSseFrame("content_block_stop", {
							type: "content_block_stop",
							index: fallbackIndex,
						}),
					);
					fallbackIndex += 1;
				}
				if (item.type === "reasoning" && Array.isArray(item.summary)) {
					const text = item.summary
						.map((part) =>
							isRecord(part) && typeof part.text === "string" ? part.text : "",
						)
						.filter(Boolean)
						.join("\n\n");
					outputs.push(
						buildSseFrame("content_block_start", {
							type: "content_block_start",
							index: fallbackIndex,
							content_block: { type: "thinking", thinking: "" },
						}),
					);
					if (text) {
						outputs.push(
							buildSseFrame("content_block_delta", {
								type: "content_block_delta",
								index: fallbackIndex,
								delta: { type: "thinking_delta", thinking: text },
							}),
						);
					}
					outputs.push(
						buildSseFrame("content_block_stop", {
							type: "content_block_stop",
							index: fallbackIndex,
						}),
					);
					fallbackIndex += 1;
				}
			}
		}

		state.usage = toAnthropicUsage(
			normalizeOpenAIUsage(payload.response.usage),
		);
		outputs.push(
			buildSseFrame("message_delta", {
				type: "message_delta",
				delta: {
					stop_reason: state.hasToolCalls ? "tool_use" : "end_turn",
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

	return outputs;
}
