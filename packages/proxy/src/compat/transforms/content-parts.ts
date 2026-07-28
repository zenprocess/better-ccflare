import { isRecord } from "@ccflare/types";
import type { JsonRecord } from "../types";
import { generateId } from "./shared";

export function buildAnthropicTextBlock(text: string) {
	return {
		type: "text",
		text,
	};
}

export function convertAnthropicContentPartToOpenAI(
	part: unknown,
): JsonRecord | null {
	if (!isRecord(part) || typeof part.type !== "string") {
		return null;
	}

	if (part.type === "text" && typeof part.text === "string") {
		return { type: "text", text: part.text };
	}

	if (part.type === "image") {
		let url = "";
		if (isRecord(part.source)) {
			if (
				part.source.type === "base64" &&
				typeof part.source.data === "string"
			) {
				const mediaType =
					typeof part.source.media_type === "string" && part.source.media_type
						? part.source.media_type
						: "application/octet-stream";
				url = `data:${mediaType};base64,${part.source.data}`;
			} else if (
				part.source.type === "url" &&
				typeof part.source.url === "string"
			) {
				url = part.source.url;
			}
		}
		if (!url && typeof part.url === "string") {
			url = part.url;
		}
		return url ? { type: "image_url", image_url: { url } } : null;
	}

	return null;
}

export function convertAnthropicToolResultContentToOpenAI(
	content: unknown,
): string | JsonRecord[] | JsonRecord {
	if (typeof content === "string") {
		return content;
	}

	if (Array.isArray(content)) {
		const contentItems: JsonRecord[] = [];
		const textParts: string[] = [];
		let hasRichContent = false;

		for (const item of content) {
			if (typeof item === "string") {
				textParts.push(item);
				contentItems.push({ type: "text", text: item });
				continue;
			}
			if (isRecord(item) && typeof item.text === "string") {
				textParts.push(item.text);
			}
			const converted = convertAnthropicContentPartToOpenAI(item);
			if (converted) {
				if (converted.type !== "text") {
					hasRichContent = true;
				}
				contentItems.push(converted);
				continue;
			}
			if (isRecord(item) && typeof item.text === "string") {
				contentItems.push({ type: "text", text: item.text });
			}
		}

		if (hasRichContent) {
			return contentItems;
		}

		const text = textParts.join("\n\n");
		return text || "";
	}

	if (isRecord(content)) {
		const converted = convertAnthropicContentPartToOpenAI(content);
		if (converted) {
			return converted.type === "text" && typeof converted.text === "string"
				? converted.text
				: [converted];
		}
		if (typeof content.text === "string") {
			return content.text;
		}
		return content;
	}

	return "";
}

export function convertOpenAIContentPartToAnthropic(
	part: unknown,
): JsonRecord | null {
	if (typeof part === "string") {
		return buildAnthropicTextBlock(part);
	}
	if (!isRecord(part)) {
		return null;
	}

	if (
		(part.type === "text" ||
			part.type === "input_text" ||
			part.type === "output_text") &&
		typeof part.text === "string"
	) {
		return buildAnthropicTextBlock(part.text);
	}

	if (part.type === "image_url") {
		const url =
			isRecord(part.image_url) && typeof part.image_url.url === "string"
				? part.image_url.url
				: "";
		return convertOpenAIImageToAnthropic(url);
	}

	if (part.type === "input_image") {
		const url =
			typeof part.image_url === "string"
				? part.image_url
				: typeof part.url === "string"
					? part.url
					: "";
		return convertOpenAIImageToAnthropic(url);
	}

	if (part.type === "file" && isRecord(part.file)) {
		const fileData =
			typeof part.file.file_data === "string" ? part.file.file_data : "";
		return convertOpenAIFileToAnthropic(fileData);
	}

	if (part.type === "input_file" && typeof part.file_data === "string") {
		return convertOpenAIFileToAnthropic(part.file_data);
	}

	if (typeof part.content === "string") {
		return buildAnthropicTextBlock(part.content);
	}

	return null;
}

function convertOpenAIImageToAnthropic(url: string): JsonRecord | null {
	if (!url) {
		return null;
	}

	if (url.startsWith("data:")) {
		const [metadata, data] = url.split(",", 2);
		if (!data) {
			return null;
		}
		const mediaType =
			metadata.slice(5).split(";", 1)[0] || "application/octet-stream";
		return {
			type: "image",
			source: {
				type: "base64",
				media_type: mediaType,
				data,
			},
		};
	}

	return {
		type: "image",
		source: {
			type: "url",
			url,
		},
	};
}

function convertOpenAIFileToAnthropic(fileData: string): JsonRecord | null {
	if (!fileData) {
		return null;
	}

	if (fileData.startsWith("data:")) {
		const [metadata, data] = fileData.split(",", 2);
		if (!data) {
			return null;
		}
		const mediaType =
			metadata.slice(5).split(";", 1)[0] || "application/octet-stream";
		return {
			type: "document",
			source: {
				type: "base64",
				media_type: mediaType,
				data,
			},
		};
	}

	return {
		type: "document",
		source: {
			type: "base64",
			media_type: "application/octet-stream",
			data: fileData,
		},
	};
}

export function convertOpenAIToolResultContentToAnthropic(
	content: unknown,
): string | JsonRecord[] | JsonRecord {
	if (typeof content === "string") {
		return content;
	}

	if (Array.isArray(content)) {
		const parts = content
			.map((part) => convertOpenAIContentPartToAnthropic(part))
			.filter((part): part is JsonRecord => part != null);
		return parts;
	}

	if (isRecord(content)) {
		const converted = convertOpenAIContentPartToAnthropic(content);
		return converted ? [converted] : content;
	}

	return JSON.stringify(content ?? "");
}

export function convertOpenAIMessageContentToAnthropic(
	content: unknown,
): JsonRecord[] {
	if (typeof content === "string") {
		return content ? [buildAnthropicTextBlock(content)] : [];
	}
	if (!Array.isArray(content)) {
		return [];
	}
	return content
		.map((part) => convertOpenAIContentPartToAnthropic(part))
		.filter((part): part is JsonRecord => part != null);
}

export function convertOpenAIMessageContentToResponses(
	content: unknown,
	role: string,
): JsonRecord[] {
	const textType = role === "assistant" ? "output_text" : "input_text";
	if (typeof content === "string") {
		return content ? [{ type: textType, text: content }] : [];
	}
	if (!Array.isArray(content)) {
		return [];
	}

	const parts: JsonRecord[] = [];
	for (const item of content) {
		if (typeof item === "string") {
			parts.push({ type: textType, text: item });
			continue;
		}
		if (!isRecord(item) || typeof item.type !== "string") {
			continue;
		}
		if (item.type === "text" && typeof item.text === "string") {
			parts.push({ type: textType, text: item.text });
			continue;
		}
		if (
			item.type === "image_url" &&
			isRecord(item.image_url) &&
			typeof item.image_url.url === "string"
		) {
			parts.push({ type: "input_image", image_url: item.image_url.url });
			continue;
		}
		if (
			item.type === "file" &&
			isRecord(item.file) &&
			typeof item.file.file_data === "string"
		) {
			parts.push({ type: "input_file", file_data: item.file.file_data });
		}
	}

	return parts;
}

export function convertResponsesMessageContentToOpenAI(
	content: unknown,
): string | JsonRecord[] {
	if (!Array.isArray(content)) {
		return typeof content === "string" ? content : "";
	}

	const parts: JsonRecord[] = [];
	let hasRichContent = false;
	for (const part of content) {
		if (!isRecord(part) || typeof part.type !== "string") {
			continue;
		}
		if (
			(part.type === "input_text" || part.type === "output_text") &&
			typeof part.text === "string"
		) {
			parts.push({ type: "text", text: part.text });
			continue;
		}
		if (part.type === "input_image") {
			const url =
				typeof part.image_url === "string"
					? part.image_url
					: typeof part.url === "string"
						? part.url
						: "";
			if (url) {
				hasRichContent = true;
				parts.push({ type: "image_url", image_url: { url } });
			}
			continue;
		}
		if (part.type === "input_file" && typeof part.file_data === "string") {
			hasRichContent = true;
			parts.push({ type: "file", file: { file_data: part.file_data } });
		}
	}

	if (hasRichContent) {
		return parts;
	}

	return parts
		.map((part) => (typeof part.text === "string" ? part.text : ""))
		.filter(Boolean)
		.join("");
}

export function extractAnthropicTextAndTools(content: unknown): {
	text: string;
	toolCalls: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}>;
	reasoning: string;
} {
	const blocks = Array.isArray(content) ? content : [];
	const textParts: string[] = [];
	const toolCalls: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}> = [];
	const reasoningParts: string[] = [];

	for (const block of blocks) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") {
			textParts.push(block.text);
		}
		if (block.type === "thinking" && typeof block.thinking === "string") {
			reasoningParts.push(block.thinking);
		}
		if (block.type === "tool_use") {
			toolCalls.push({
				id:
					typeof block.id === "string" && block.id
						? block.id
						: generateId("call"),
				type: "function",
				function: {
					name:
						typeof block.name === "string" && block.name ? block.name : "tool",
					arguments: JSON.stringify(block.input ?? {}),
				},
			});
		}
	}

	return {
		text: textParts.join(""),
		toolCalls,
		reasoning: reasoningParts.join("\n\n"),
	};
}
