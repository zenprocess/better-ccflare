import { describe, expect, it } from "bun:test";
import {
	parseAssistantMessage,
	parseRequestMessages,
} from "./parse-conversation";

describe("parseRequestMessages", () => {
	it("parses websocket response.create payloads into request messages", () => {
		expect(
			parseRequestMessages(
				JSON.stringify({
					type: "response.create",
					model: "gpt-5-codex",
					input: "hello from websocket",
				}),
			),
		).toEqual([
			expect.objectContaining({
				role: "user",
				content: "hello from websocket",
			}),
		]);
	});

	it("skips malformed request message entries", () => {
		expect(
			parseRequestMessages(
				JSON.stringify({
					model: "openai/gpt-5.4",
					messages: [
						{ role: "user", content: "hello wassup" },
						{},
						{ role: "assistant", content: "Hey there" },
					],
				}),
			),
		).toEqual([
			expect.objectContaining({
				role: "user",
				content: "hello wassup",
			}),
			expect.objectContaining({
				role: "assistant",
				content: "Hey there",
			}),
		]);
	});
});

describe("parseAssistantMessage", () => {
	it("parses synthetic websocket SSE payloads into assistant text", () => {
		const message = parseAssistantMessage(
			[
				"event: response.created",
				'data: {"type":"response.created","response":{"id":"resp_ws","model":"gpt-5-codex"}}',
				"",
				"event: response.output_text.delta",
				'data: {"type":"response.output_text.delta","delta":"Hello"}',
				"",
				"event: response.output_text.delta",
				'data: {"type":"response.output_text.delta","delta":" from Codex"}',
				"",
				"event: response.completed",
				'data: {"type":"response.completed","response":{"id":"resp_ws","usage":{"input_tokens":12,"output_tokens":4,"total_tokens":16}}}',
				"",
			].join("\n"),
		);

		expect(message).toEqual(
			expect.objectContaining({
				role: "assistant",
				content: "Hello from Codex",
			}),
		);
	});

	it("does not duplicate OpenAI final text when output_text.done repeats streamed deltas", () => {
		const message = parseAssistantMessage(
			[
				"event: response.output_item.added",
				'data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","status":"in_progress","content":[],"phase":"final_answer","role":"assistant"},"output_index":0,"sequence_number":2}',
				"",
				"event: response.content_part.added",
				'data: {"type":"response.content_part.added","content_index":0,"item_id":"msg_1","output_index":0,"part":{"type":"output_text","annotations":[],"logprobs":[],"text":""},"sequence_number":3}',
				"",
				"event: response.output_text.delta",
				'data: {"type":"response.output_text.delta","content_index":0,"delta":"Say","item_id":"msg_1","output_index":0,"sequence_number":4}',
				"",
				"event: response.output_text.delta",
				'data: {"type":"response.output_text.delta","content_index":0,"delta":" the","item_id":"msg_1","output_index":0,"sequence_number":5}',
				"",
				"event: response.output_text.delta",
				'data: {"type":"response.output_text.delta","content_index":0,"delta":" thing","item_id":"msg_1","output_index":0,"sequence_number":6}',
				"",
				"event: response.output_text.delta",
				'data: {"type":"response.output_text.delta","content_index":0,"delta":".","item_id":"msg_1","output_index":0,"sequence_number":7}',
				"",
				"event: response.output_text.done",
				'data: {"type":"response.output_text.done","content_index":0,"item_id":"msg_1","output_index":0,"sequence_number":8,"text":"Say the thing."}',
				"",
				"event: response.output_item.done",
				'data: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","annotations":[],"logprobs":[],"text":"Say the thing."}],"phase":"final_answer","role":"assistant"},"output_index":0,"sequence_number":10}',
			].join("\n"),
		);

		expect(message).toEqual(
			expect.objectContaining({
				role: "assistant",
				content: "Say the thing.",
			}),
		);
	});

	it("parses plain data-only chat completion chunks into assistant text", () => {
		const message = parseAssistantMessage(
			[
				'data: {"id":"resp_1","object":"chat.completion.chunk","created":1,"model":"gpt-5.4","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
				"",
				'data: {"id":"resp_1","object":"chat.completion.chunk","created":1,"model":"gpt-5.4","choices":[{"index":0,"delta":{"content":"Hey"},"finish_reason":null}]}',
				"",
				'data: {"id":"resp_1","object":"chat.completion.chunk","created":1,"model":"gpt-5.4","choices":[{"index":0,"delta":{"content":" What’s up?"},"finish_reason":null}]}',
				"",
				'data: {"id":"resp_1","object":"chat.completion.chunk","created":1,"model":"gpt-5.4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":10,"input_tokens":4,"output_tokens":6}}',
				"",
				"data: [DONE]",
			].join("\n"),
		);

		expect(message).toEqual(
			expect.objectContaining({
				role: "assistant",
				content: "Hey What’s up?",
			}),
		);
	});

	it("parses response.completed output arrays into tools and reasoning", () => {
		const message = parseAssistantMessage(
			JSON.stringify({
				type: "response.completed",
				response: {
					id: "resp_1",
					output: [
						{
							type: "reasoning",
							id: "rs_1",
							summary: [{ type: "summary_text", text: "thinking" }],
						},
						{
							type: "message",
							id: "msg_1",
							role: "assistant",
							content: [{ type: "output_text", text: "hello" }],
						},
						{
							type: "function_call",
							id: "fc_1",
							call_id: "call_1",
							name: "Read",
							arguments: '{"file":"README.md"}',
						},
					],
				},
			}),
		);

		expect(message).toEqual(
			expect.objectContaining({
				role: "assistant",
				content: "hello",
				tools: [
					expect.objectContaining({
						id: "call_1",
						name: "Read",
					}),
				],
			}),
		);
		expect(
			message?.contentBlocks?.some(
				(block) => block.type === "thinking" && block.thinking === "thinking",
			),
		).toBe(true);
	});

	it("parses Claude Code sentinel/system events into system messages", () => {
		const message = parseAssistantMessage(
			[
				'data: {"type":"system","subtype":"session_state_changed","state":"requires_action","session_id":"sess_123"}',
				"",
				'data: {"type":"tool_progress","tool_use_id":"toolu_123","tool_name":"Bash","elapsed_time_seconds":2.5,"session_id":"sess_123"}',
				"",
				'data: {"type":"tool_use_summary","summary":"Searched in auth/","preceding_tool_use_ids":["toolu_1","toolu_2"],"session_id":"sess_123"}',
				"",
				'data: {"type":"control_request","request_id":"req_123","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"npm test"},"tool_use_id":"toolu_123","description":"Running npm test"}}',
				"",
			].join("\n"),
		);

		expect(message).toEqual(
			expect.objectContaining({
				role: "system",
				content:
					"Session state changed: requires_action\n\nTool progress: Bash (2.5s)\n\nTool summary: Searched in auth/\n\nTool permission requested: Bash",
				tools: [
					expect.objectContaining({
						id: "toolu_123",
						name: "Bash",
					}),
				],
			}),
		);
	});
});
