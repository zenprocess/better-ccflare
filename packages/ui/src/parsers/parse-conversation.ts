import { ContentBlockType, isRecord, type MessageData } from "@ccflare/types";
import { normalizeText } from "../utils/normalize-text";

type ConversationTextItem = { type: string; text?: string };
type ConversationContentItem = {
	type: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	tool_use_id?: string;
	content?: string | ConversationTextItem[];
};
type ConversationRequestMessage = {
	role: "user" | "assistant" | "system";
	content: string | ConversationContentItem[];
};

function isConversationRole(value: unknown): value is MessageData["role"] {
	return value === "user" || value === "assistant" || value === "system";
}

function createMessage(role: MessageData["role"]): MessageData {
	return {
		role,
		content: "",
		contentBlocks: [],
		tools: [],
		toolResults: [],
	};
}

function createTextMessage(
	role: MessageData["role"],
	content: string,
): MessageData {
	const message = createMessage(role);
	message.content = content;
	message.contentBlocks = [
		{
			type: ContentBlockType.Text,
			text: content,
		},
	];
	return message;
}

function normalizeOpenAITextContent(content: unknown): string {
	if (typeof content === "string") {
		return normalizeText(content);
	}

	if (Array.isArray(content)) {
		return content
			.map((item) => normalizeOpenAITextContent(item))
			.filter(Boolean)
			.join("\n\n")
			.trim();
	}

	if (content && typeof content === "object") {
		const record = content as Record<string, unknown>;
		return (
			normalizeOpenAITextContent(record.text) ||
			normalizeOpenAITextContent(record.input_text) ||
			normalizeOpenAITextContent(record.content) ||
			normalizeOpenAITextContent(record.input)
		);
	}

	return "";
}

function parseOpenAIRequestMessages(
	parsed: Record<string, unknown>,
): MessageData[] {
	if (parsed.type !== "response.create") {
		return [];
	}

	const input = parsed.input;

	if (Array.isArray(input)) {
		const messages = input
			.map((item) => {
				if (typeof item === "string") {
					const content = normalizeText(item);
					return content ? createTextMessage("user", content) : null;
				}

				if (!item || typeof item !== "object") {
					return null;
				}

				const record = item as Record<string, unknown>;
				const role =
					record.role === "assistant" ||
					record.role === "system" ||
					record.role === "user"
						? record.role
						: "user";
				const content = normalizeOpenAITextContent(
					record.content ?? record.text ?? record.input_text ?? record.input,
				);
				return content ? createTextMessage(role, content) : null;
			})
			.filter((message): message is MessageData => message !== null);

		if (messages.length > 0) {
			return messages;
		}
	}

	const content = normalizeOpenAITextContent(input);
	return content ? [createTextMessage("user", content)] : [];
}

function extractOpenAIResponseText(response: unknown): string {
	if (!response || typeof response !== "object") {
		return "";
	}

	const record = response as Record<string, unknown>;

	return (
		normalizeOpenAITextContent(record.output_text) ||
		normalizeOpenAITextContent(record.output) ||
		normalizeOpenAITextContent(record.content)
	);
}

function appendOpenAIResponseOutputItem(
	message: MessageData,
	item: Record<string, unknown>,
	appendText: (text: string) => void,
): void {
	if (item.type === "message" && Array.isArray(item.content)) {
		for (const part of item.content) {
			if (isRecord(part) && typeof part.text === "string") {
				const text = normalizeText(part.text);
				if (text) {
					appendText(text);
				}
			}
		}
		return;
	}

	if (item.type === "function_call") {
		const id = typeof item.call_id === "string" ? item.call_id : undefined;
		const name = typeof item.name === "string" ? item.name : "tool";
		const input =
			typeof item.arguments === "string"
				? (maybeParseConversationJson(item.arguments) ?? {
						_raw: item.arguments,
					})
				: undefined;
		message.tools?.push({ id, name, input });
		message.contentBlocks?.push({
			type: ContentBlockType.ToolUse,
			id,
			name,
			input,
		});
		return;
	}

	if (item.type === "reasoning" && Array.isArray(item.summary)) {
		const thinking = item.summary
			.map((part) =>
				isRecord(part) && typeof part.text === "string"
					? normalizeText(part.text)
					: "",
			)
			.filter(Boolean)
			.join("\n\n");
		if (thinking) {
			message.contentBlocks?.push({
				type: ContentBlockType.Thinking,
				thinking,
			});
		}
	}
}

function maybeParseConversationJson(
	value: string,
): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function normalizeToolResultContent(
	content: ConversationContentItem["content"],
): string {
	if (Array.isArray(content)) {
		return content
			.map((item) =>
				normalizeText(typeof item.text === "string" ? item.text : ""),
			)
			.join("");
	}

	return typeof content === "string" ? normalizeText(content) : "";
}

function normalizeConversationText(text: unknown): string {
	let normalized = normalizeText(text || "");
	if (normalized.includes("<system-reminder>")) {
		normalized = normalized
			.split(/<system-reminder>[\s\S]*?<\/system-reminder>/g)
			.join("")
			.trim();
	}
	return normalized;
}

function appendConversationContentItem(
	message: MessageData,
	item: ConversationContentItem,
	appendText: (text: string) => void,
): void {
	if (item.type === "text") {
		const text = normalizeConversationText(item.text);
		if (text) {
			appendText(text);
			message.contentBlocks?.push({
				type: ContentBlockType.Text,
				text,
			});
		}
		return;
	}

	if (item.type === "tool_use") {
		message.tools?.push({
			id: item.id,
			name: item.name || "unknown",
			input: item.input,
		});
		message.contentBlocks?.push({
			type: ContentBlockType.ToolUse,
			id: item.id,
			name: item.name,
			input: item.input,
		});
		return;
	}

	if (item.type === "tool_result") {
		const resultContent = normalizeToolResultContent(item.content);
		message.toolResults?.push({
			tool_use_id: item.tool_use_id || "",
			content: resultContent,
		});
		message.contentBlocks?.push({
			type: ContentBlockType.ToolResult,
			tool_use_id: item.tool_use_id,
			content: resultContent,
		});
		return;
	}

	if (item.type === "thinking") {
		const thinking = normalizeText(item.thinking || "");
		if (thinking) {
			message.contentBlocks?.push({
				type: ContentBlockType.Thinking,
				thinking,
			});
		}
	}
}

export function parseRequestMessages(body: string | null): MessageData[] {
	if (!body) return [];

	try {
		const parsed = JSON.parse(body);
		if (parsed && typeof parsed === "object") {
			const openAIRequestMessages = parseOpenAIRequestMessages(
				parsed as Record<string, unknown>,
			);
			if (openAIRequestMessages.length > 0) {
				return openAIRequestMessages;
			}
		}

		if (!parsed.messages || !Array.isArray(parsed.messages)) return [];

		return parsed.messages
			.map((msg: unknown): MessageData | null => {
				if (!msg || typeof msg !== "object") {
					return null;
				}
				const record = msg as Partial<ConversationRequestMessage>;
				if (!isConversationRole(record.role)) {
					return null;
				}

				const { role, content } = record;
				if (typeof content !== "string" && !Array.isArray(content)) {
					return null;
				}

				const message = createMessage(role);

				if (typeof content === "string") {
					message.content = content;
				} else if (Array.isArray(content)) {
					const textContents: string[] = [];

					for (const item of content) {
						appendConversationContentItem(message, item, (text) => {
							textContents.push(text);
						});
					}

					message.content = textContents.join("\n\n").trim();
					if (
						!message.content &&
						message.tools?.length === 0 &&
						message.toolResults?.length === 0
					) {
						return null;
					}
				}

				return message;
			})
			.filter((msg: MessageData | null): msg is MessageData => msg !== null);
	} catch (error) {
		console.error("Failed to parse request body:", error);
		return [];
	}
}

export function parseAssistantMessage(body: string | null): MessageData | null {
	if (!body) return null;

	try {
		const lines = body.split("\n");
		const message = createMessage("assistant");

		let currentContent = "";
		let currentThinking = "";
		let isStreaming = false;
		const systemNotices: string[] = [];

		for (const line of lines) {
			if (line.startsWith("event:")) {
				isStreaming = true;
				continue;
			}

			if (line.startsWith("data:")) {
				isStreaming = true;
				const dataStr = line.substring(5).trim();
				if (!dataStr || dataStr === "[DONE]") continue;

				try {
					const data = JSON.parse(dataStr);

					// Handle different event types
					if (data.type === "content_block_start") {
						if (data.content_block?.type === "tool_use") {
							appendConversationContentItem(
								message,
								{
									type: "tool_use",
									id: data.content_block.id,
									name: data.content_block.name,
									input: {},
								},
								() => {},
							);
						} else if (data.content_block?.type === "thinking") {
							// Thinking block will be added when content is received
						}
					} else if (data.type === "content_block_delta") {
						if (data.delta?.type === "text_delta") {
							currentContent += data.delta.text || "";
						} else if (data.delta?.type === "thinking_delta") {
							currentThinking += data.delta.thinking || "";
						} else if (
							data.delta?.type === "input_json_delta" &&
							data.index !== undefined
						) {
							// Update tool input
							const hasThinking = message.contentBlocks?.some(
								(b) => b.type === ContentBlockType.Thinking,
							);
							const toolIndex = data.index - (hasThinking ? 1 : 0);
							if (message.tools?.[toolIndex]) {
								try {
									const partialJson = data.delta.partial_json || "";
									// This is a simplified approach - in production you'd want proper JSON streaming
									if (partialJson && message.contentBlocks) {
										const blockIndex = message.contentBlocks.findIndex(
											(b) =>
												b.type === ContentBlockType.ToolUse &&
												b.id === message.tools?.[toolIndex].id,
										);
										if (blockIndex !== -1) {
											// Try to parse the partial JSON, fallback to empty object
											try {
												message.contentBlocks[blockIndex].input =
													JSON.parse(partialJson);
											} catch {
												// If parsing fails, store raw string in a temporary field
												message.contentBlocks[blockIndex].input = {
													_partial: partialJson,
												};
											}
										}
									}
								} catch (_e) {
									// Ignore JSON parsing errors for partial data
								}
							}
						}
					} else if (data.type === "response.output_text.delta") {
						const deltaText =
							typeof data.delta === "string"
								? data.delta
								: typeof data.delta?.text === "string"
									? data.delta.text
									: "";
						currentContent += normalizeText(deltaText);
					} else if (data.type === "response.output_text.done") {
						const finalText = normalizeOpenAITextContent(
							data.text ?? data.delta ?? data.output_text,
						);
						if (!finalText) {
							continue;
						}
						if (!currentContent) {
							currentContent = finalText;
						} else if (
							currentContent === finalText ||
							currentContent.endsWith(finalText)
						) {
						} else if (finalText.startsWith(currentContent)) {
							currentContent = finalText;
						} else {
							currentContent += finalText;
						}
					} else if (data.type === "response.completed") {
						if (!currentContent) {
							currentContent = extractOpenAIResponseText(data.response);
						}
						const responseOutput = isRecord(data.response)
							? data.response.output
							: undefined;
						if (Array.isArray(responseOutput)) {
							for (const item of responseOutput) {
								if (!isRecord(item)) continue;
								appendOpenAIResponseOutputItem(message, item, (text) => {
									currentContent += text;
								});
							}
						}
					} else if (
						data.object === "chat.completion.chunk" &&
						Array.isArray(data.choices)
					) {
						const firstChoice =
							data.choices[0] && typeof data.choices[0] === "object"
								? (data.choices[0] as Record<string, unknown>)
								: null;
						const delta =
							firstChoice?.delta && typeof firstChoice.delta === "object"
								? (firstChoice.delta as Record<string, unknown>)
								: null;
						const content =
							typeof delta?.content === "string"
								? normalizeText(delta.content)
								: "";
						if (content) {
							currentContent += content;
						}
					} else if (
						data.type === "system" &&
						typeof data.subtype === "string" &&
						data.subtype === "session_state_changed"
					) {
						const stateLabel =
							typeof data.state === "string" ? data.state : "unknown";
						systemNotices.push(`Session state changed: ${stateLabel}`);
					} else if (data.type === "tool_progress") {
						const toolName =
							typeof data.tool_name === "string" ? data.tool_name : "tool";
						const elapsed =
							typeof data.elapsed_time_seconds === "number"
								? `${data.elapsed_time_seconds}s`
								: "in progress";
						systemNotices.push(`Tool progress: ${toolName} (${elapsed})`);
					} else if (data.type === "tool_use_summary") {
						const summary =
							typeof data.summary === "string"
								? normalizeText(data.summary)
								: "";
						if (summary) {
							systemNotices.push(`Tool summary: ${summary}`);
						}
					} else if (
						data.type === "control_request" &&
						data.request &&
						typeof data.request === "object"
					) {
						const request = data.request as Record<string, unknown>;
						if (request.subtype === "can_use_tool") {
							const toolName =
								typeof request.tool_name === "string"
									? request.tool_name
									: "tool";
							systemNotices.push(`Tool permission requested: ${toolName}`);
							const id =
								typeof request.tool_use_id === "string"
									? request.tool_use_id
									: undefined;
							const input = isRecord(request.input)
								? (request.input as Record<string, unknown>)
								: undefined;
							message.tools?.push({ id, name: toolName, input });
							message.contentBlocks?.push({
								type: ContentBlockType.ToolUse,
								id,
								name: toolName,
								input,
							});
						}
					}
				} catch (_e) {
					// Skip invalid JSON
				}
			}
		}

		// If no streaming data found, try parsing as direct response
		if (!isStreaming) {
			try {
				const parsed = JSON.parse(body);
				const responseRecord =
					parsed && typeof parsed === "object" && parsed.response
						? (parsed.response as Record<string, unknown>)
						: null;
				const output = (
					responseRecord && Array.isArray(responseRecord.output)
						? responseRecord.output
						: Array.isArray(parsed?.output)
							? parsed.output
							: null
				) as unknown[] | null;
				if (output) {
					for (const item of output) {
						if (!isRecord(item)) continue;
						appendOpenAIResponseOutputItem(message, item, (text) => {
							currentContent += text;
						});
					}
				}
				if (parsed.content) {
					if (typeof parsed.content === "string") {
						if (!currentContent) {
							currentContent = normalizeText(parsed.content);
						}
					} else if (Array.isArray(parsed.content)) {
						for (const item of parsed.content as ConversationContentItem[]) {
							appendConversationContentItem(message, item, (text) => {
								currentContent += text;
							});
						}
					}
				} else if (!currentContent) {
					currentContent = extractOpenAIResponseText(parsed);
				}
			} catch (_e) {
				// Not JSON, might be plain text
				currentContent = body;
			}
		}

		message.content = currentContent.trim();

		if (currentThinking) {
			message.contentBlocks?.unshift({
				type: ContentBlockType.Thinking,
				thinking: currentThinking,
			});
		}

		if (systemNotices.length > 0 && !message.content && !currentThinking) {
			message.role = "system";
			message.content = systemNotices.join("\n\n");
			message.contentBlocks?.unshift({
				type: ContentBlockType.Text,
				text: message.content,
			});
		}

		if (
			!message.content &&
			!currentThinking &&
			(!message.tools || message.tools.length === 0) &&
			(!message.toolResults || message.toolResults.length === 0)
		) {
			return null;
		}

		return message;
	} catch (error) {
		console.error("Failed to parse response body:", error);
		return null;
	}
}
