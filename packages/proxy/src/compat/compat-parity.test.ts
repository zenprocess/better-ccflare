import { describe, expect, it } from "bun:test";
import {
	convertAnthropicRequestToOpenAIChat,
	convertAnthropicRequestToOpenAIResponses,
} from "./transforms/requests";
import {
	transformAnthropicResponseToOpenAIResponses,
	transformOpenAIResponsesResponseToAnthropic,
	transformOpenAIResponsesResponseToOpenAIChat,
} from "./transforms/responses";

describe("compat parity", () => {
	describe("request ordering", () => {
		it("preserves user text/tool_result ordering for anthropic -> openai chat", () => {
			const output = convertAnthropicRequestToOpenAIChat(
				{
					model: "claude-sonnet-4",
					messages: [
						{
							role: "assistant",
							content: [
								{
									type: "tool_use",
									id: "call_abc",
									name: "Read",
									input: { file: "test.go" },
								},
							],
						},
						{
							role: "user",
							content: [
								{ type: "text", text: "Before result. " },
								{
									type: "tool_result",
									tool_use_id: "call_abc",
									content: "file content",
								},
								{ type: "text", text: "After result." },
							],
						},
					],
				},
				"claude-sonnet-4",
			);

			expect(output.messages).toEqual([
				expect.objectContaining({
					role: "assistant",
					tool_calls: [expect.objectContaining({ id: "call_abc" })],
				}),
				{ role: "user", content: "Before result. " },
				{ role: "tool", tool_call_id: "call_abc", content: "file content" },
				{ role: "user", content: "After result." },
			]);
		});

		it("preserves user text/tool_result ordering for anthropic -> openai responses", () => {
			const output = convertAnthropicRequestToOpenAIResponses(
				{
					model: "claude-sonnet-4",
					messages: [
						{
							role: "assistant",
							content: [
								{
									type: "tool_use",
									id: "call_abc",
									name: "Read",
									input: { file: "test.go" },
								},
							],
						},
						{
							role: "user",
							content: [
								{ type: "text", text: "Before result. " },
								{
									type: "tool_result",
									tool_use_id: "call_abc",
									content: "file content",
								},
								{ type: "text", text: "After result." },
							],
						},
					],
				},
				"claude-sonnet-4",
			);

			expect(output.input).toEqual([
				expect.objectContaining({ type: "function_call", call_id: "call_abc" }),
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Before result. " }],
				},
				{
					type: "function_call_output",
					call_id: "call_abc",
					output: "file content",
				},
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "After result." }],
				},
			]);
		});
	});

	describe("responses parity", () => {
		it("preserves request fields and populated output on anthropic -> openai responses streams", async () => {
			const response = await transformAnthropicResponseToOpenAIResponses(
				new Response(
					[
						"event: message_start",
						'data: {"type":"message_start","message":{"id":"msg_test","model":"claude-opus-4.6","usage":{"input_tokens":10,"output_tokens":0}}}',
						"",
						"event: content_block_start",
						'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
						"",
						"event: content_block_delta",
						'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"translated"}}',
						"",
						"event: content_block_stop",
						'data: {"type":"content_block_stop","index":0}',
						"",
						"event: message_delta",
						'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":10,"output_tokens":5}}',
						"",
						"event: message_stop",
						'data: {"type":"message_stop"}',
						"",
						"",
					].join("\n"),
					{
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					},
				),
				{
					model: "anthropic/claude-opus-4.6",
					instructions: "Keep it short.",
					metadata: { source: "compat-stream-test" },
					tool_choice: "auto",
				},
			);

			const text = await response.text();
			expect(text).toContain('"type":"response.completed"');
			expect(text).toContain('"instructions":"Keep it short."');
			expect(text).toContain('"metadata":{"source":"compat-stream-test"}');
			expect(text).toContain(
				'"output":[{"id":"msg_test_msg_0","type":"message"',
			);
			expect(text).toContain('"text":"translated"');
			const outputDoneIndex = text.indexOf(
				'"type":"response.output_item.done"',
			);
			const completedIndex = text.indexOf('"type":"response.completed"');
			expect(outputDoneIndex).toBeGreaterThan(-1);
			expect(completedIndex).toBeGreaterThan(outputDoneIndex);
		});

		it("materializes terminal-only response.completed payloads for anthropic streams", async () => {
			const response = await transformOpenAIResponsesResponseToAnthropic(
				new Response(
					[
						"event: response.completed",
						'data: {"type":"response.completed","response":{"id":"resp_1","created_at":1,"model":"gpt-5.4","output":[{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"hello from responses"}]}],"usage":{"input_tokens":10,"output_tokens":3,"total_tokens":13}}}',
						"",
						"",
					].join("\n"),
					{
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					},
				),
			);

			const text = await response.text();
			expect(text).toContain('"text_delta","text":"hello from responses"');
			expect(text).toContain('"type":"message_stop"');
		});

		it("uses tool_use stop reasons for tool-only anthropic payloads", async () => {
			const streaming = await transformOpenAIResponsesResponseToAnthropic(
				new Response(
					[
						"event: response.completed",
						'data: {"type":"response.completed","response":{"id":"resp_1","created_at":1,"model":"gpt-5.4","output":[{"type":"function_call","id":"fc_1","call_id":"call_1","name":"Read","arguments":"{\\"file\\":\\"README.md\\"}"}],"usage":{"input_tokens":10,"output_tokens":3,"total_tokens":13}}}',
						"",
						"",
					].join("\n"),
					{
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					},
				),
			);
			expect(await streaming.text()).toContain('"stop_reason":"tool_use"');

			const nonStream = await transformOpenAIResponsesResponseToAnthropic(
				new Response(
					JSON.stringify({
						id: "resp_1",
						object: "response",
						created_at: 1,
						model: "gpt-5.4",
						output: [
							{
								type: "function_call",
								id: "fc_1",
								call_id: "call_1",
								name: "Read",
								arguments: '{"file":"README.md"}',
							},
						],
						usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			);
			expect(
				((await nonStream.json()) as { stop_reason?: string }).stop_reason,
			).toBe("tool_use");
		});

		it("uses tool_calls finish reasons for chat payloads with function calls", async () => {
			const streaming = await transformOpenAIResponsesResponseToOpenAIChat(
				new Response(
					[
						"event: response.completed",
						'data: {"type":"response.completed","response":{"id":"resp_1","created_at":1,"model":"gpt-5.4","output":[{"type":"function_call","id":"fc_1","call_id":"call_1","name":"Read","arguments":"{\\"file\\":\\"README.md\\"}"}],"usage":{"input_tokens":10,"output_tokens":3,"total_tokens":13}}}',
						"",
						"",
					].join("\n"),
					{
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					},
				),
			);
			expect(await streaming.text()).toContain('"finish_reason":"tool_calls"');

			const nonStream = await transformOpenAIResponsesResponseToOpenAIChat(
				new Response(
					JSON.stringify({
						id: "resp_1",
						object: "response",
						created_at: 1,
						model: "gpt-5.4",
						output: [
							{
								type: "function_call",
								id: "fc_1",
								call_id: "call_1",
								name: "Read",
								arguments: '{"file":"README.md"}',
							},
						],
						usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			);
			expect(
				(
					(await nonStream.json()) as {
						choices?: Array<{ finish_reason?: string }>;
					}
				).choices?.[0]?.finish_reason,
			).toBe("tool_calls");
		});

		it("keeps terminal mixed outputs ordered and assigns distinct tool call indexes", async () => {
			const response = await transformOpenAIResponsesResponseToOpenAIChat(
				new Response(
					[
						"event: response.completed",
						'data: {"type":"response.completed","response":{"id":"resp_1","created_at":1,"model":"gpt-5.4","output":[{"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"thinking"}]},{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"hello"}]},{"type":"function_call","id":"fc_1","call_id":"call_1","name":"Read","arguments":"{\\"file\\":\\"README.md\\"}"},{"type":"function_call","id":"fc_2","call_id":"call_2","name":"Write","arguments":"{\\"file\\":\\"out.txt\\"}"}],"usage":{"input_tokens":10,"output_tokens":3,"total_tokens":13}}}',
						"",
						"",
					].join("\n"),
					{
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					},
				),
			);

			const text = await response.text();
			const reasoningIndex = text.indexOf('"reasoning_content":"thinking"');
			const contentIndex = text.indexOf('"content":"hello"');
			const firstToolIndex = text.indexOf('"index":0,"id":"call_1"');
			const secondToolIndex = text.indexOf('"index":1,"id":"call_2"');
			expect(reasoningIndex).toBeGreaterThan(-1);
			expect(contentIndex).toBeGreaterThan(reasoningIndex);
			expect(firstToolIndex).toBeGreaterThan(contentIndex);
			expect(secondToolIndex).toBeGreaterThan(firstToolIndex);
		});
	});
});
