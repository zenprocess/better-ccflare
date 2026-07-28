import { isRecord } from "@ccflare/types";
import type {
	JsonRecord,
	ResponsesToChatStreamState,
	SseFrame,
} from "../../types";
import { convertOpenAIResponsesOutputToChatMessage } from "../response-content";
import {
	buildChatChunk,
	buildSseFrame,
	createTransformedSseResponse,
	generateId,
	isStreamingResponse,
	jsonResponse,
	maybeParseJson,
	normalizeOpenAIUsage,
} from "../shared";

export async function transformOpenAIResponsesResponseToOpenAIChat(
	response: Response,
): Promise<Response> {
	if (isStreamingResponse(response)) {
		const state: ResponsesToChatStreamState = {
			id: generateId("chatcmpl"),
			model: "",
			created: Math.floor(Date.now() / 1000),
			usage: {},
			hasContent: false,
			hasToolCalls: false,
			functionIndexes: new Map(),
			functionNames: new Map(),
			functionCallIds: new Map(),
			finishReason: null,
			started: false,
		};
		return createTransformedSseResponse(response, (frame) =>
			transformOpenAIResponsesFrameToOpenAIChat(frame, state),
		);
	}

	const body = (await response.json()) as JsonRecord;
	return jsonResponse(
		convertOpenAIResponsesJsonToOpenAIChat(body),
		response,
		"application/json; charset=utf-8",
	);
}

function convertOpenAIResponsesJsonToOpenAIChat(body: JsonRecord): JsonRecord {
	const source = isRecord(body.response) ? (body.response as JsonRecord) : body;
	const { message, finishReason } = convertOpenAIResponsesOutputToChatMessage(
		source.output,
	);

	return {
		id: typeof source.id === "string" ? source.id : generateId("chatcmpl"),
		object: "chat.completion",
		created:
			typeof source.created_at === "number"
				? source.created_at
				: Math.floor(Date.now() / 1000),
		model: typeof source.model === "string" ? source.model : "unknown",
		choices: [
			{
				index: 0,
				message,
				finish_reason: finishReason,
			},
		],
		usage: normalizeOpenAIUsage(source.usage),
	};
}

function transformOpenAIResponsesFrameToOpenAIChat(
	frame: SseFrame,
	state: ResponsesToChatStreamState,
): string[] {
	const payload = maybeParseJson(frame.data);
	if (!isRecord(payload)) return [];
	const outputs: string[] = [];
	const type = typeof payload.type === "string" ? payload.type : frame.event;

	if (type === "response.created" && isRecord(payload.response)) {
		state.started = true;
		state.id =
			typeof payload.response.id === "string" ? payload.response.id : state.id;
		state.model =
			typeof payload.response.model === "string"
				? payload.response.model
				: state.model;
		state.created =
			typeof payload.response.created_at === "number"
				? payload.response.created_at
				: state.created;
		outputs.push(
			buildSseFrame(null, buildChatChunk(state, { role: "assistant" })),
		);
		return outputs;
	}

	if (
		type === "response.output_text.delta" &&
		typeof payload.delta === "string"
	) {
		state.hasContent = true;
		outputs.push(
			buildSseFrame(null, buildChatChunk(state, { content: payload.delta })),
		);
		return outputs;
	}

	if (type === "response.output_item.added" && isRecord(payload.item)) {
		const outputIndex =
			typeof payload.output_index === "number"
				? payload.output_index
				: state.functionIndexes.size;
		if (payload.item.type === "function_call") {
			state.hasContent = true;
			state.hasToolCalls = true;
			const itemId =
				typeof payload.item.id === "string"
					? payload.item.id
					: generateId("fc");
			const callId =
				typeof payload.item.call_id === "string"
					? payload.item.call_id
					: generateId("call");
			const name =
				typeof payload.item.name === "string" ? payload.item.name : "tool";
			state.functionIndexes.set(itemId, outputIndex);
			state.functionNames.set(itemId, name);
			state.functionCallIds.set(itemId, callId);
			outputs.push(
				buildSseFrame(
					null,
					buildChatChunk(state, {
						tool_calls: [
							{
								index: outputIndex,
								id: callId,
								type: "function",
								function: { name, arguments: "" },
							},
						],
					}),
				),
			);
		}
		return outputs;
	}

	if (
		type === "response.function_call_arguments.delta" &&
		typeof payload.delta === "string"
	) {
		const itemId = typeof payload.item_id === "string" ? payload.item_id : "";
		const outputIndex = state.functionIndexes.get(itemId);
		if (outputIndex !== undefined) {
			outputs.push(
				buildSseFrame(
					null,
					buildChatChunk(state, {
						tool_calls: [
							{
								index: outputIndex,
								id: state.functionCallIds.get(itemId) ?? generateId("call"),
								type: "function",
								function: {
									name: state.functionNames.get(itemId) ?? "tool",
									arguments: payload.delta,
								},
							},
						],
					}),
				),
			);
		}
		return outputs;
	}

	if (type === "response.completed" && isRecord(payload.response)) {
		if (!state.started) {
			state.started = true;
			state.id =
				typeof payload.response.id === "string"
					? payload.response.id
					: state.id;
			state.model =
				typeof payload.response.model === "string"
					? payload.response.model
					: state.model;
			state.created =
				typeof payload.response.created_at === "number"
					? payload.response.created_at
					: state.created;
			outputs.push(
				buildSseFrame(null, buildChatChunk(state, { role: "assistant" })),
			);
		}

		if (!state.hasContent && Array.isArray(payload.response.output)) {
			let fallbackToolIndex = state.functionIndexes.size;
			for (const item of payload.response.output) {
				if (!isRecord(item)) continue;
				if (item.type === "message" && Array.isArray(item.content)) {
					const text = item.content
						.map((part) =>
							isRecord(part) && typeof part.text === "string" ? part.text : "",
						)
						.filter(Boolean)
						.join("");
					if (text) {
						outputs.push(
							buildSseFrame(null, buildChatChunk(state, { content: text })),
						);
					}
				}
				if (item.type === "function_call") {
					state.hasToolCalls = true;
					const outputIndex = fallbackToolIndex;
					fallbackToolIndex += 1;
					outputs.push(
						buildSseFrame(
							null,
							buildChatChunk(state, {
								tool_calls: [
									{
										index: outputIndex,
										id:
											typeof item.call_id === "string"
												? item.call_id
												: generateId("call"),
										type: "function",
										function: {
											name: typeof item.name === "string" ? item.name : "tool",
											arguments:
												typeof item.arguments === "string"
													? item.arguments
													: "",
										},
									},
								],
							}),
						),
					);
				}
				if (item.type === "reasoning" && Array.isArray(item.summary)) {
					const text = item.summary
						.map((part) =>
							isRecord(part) && typeof part.text === "string" ? part.text : "",
						)
						.filter(Boolean)
						.join("\n\n");
					if (text) {
						outputs.push(
							buildSseFrame(
								null,
								buildChatChunk(state, { reasoning_content: text }),
							),
						);
					}
				}
			}
		}

		state.usage = normalizeOpenAIUsage(payload.response.usage);
		outputs.push(
			buildSseFrame(
				null,
				buildChatChunk(
					state,
					{},
					{
						finishReason:
							state.finishReason ??
							(state.hasToolCalls ? "tool_calls" : "stop"),
						usage: state.usage,
					},
				),
			),
		);
		outputs.push(buildSseFrame(null, "[DONE]"));
		return outputs;
	}

	return outputs;
}
