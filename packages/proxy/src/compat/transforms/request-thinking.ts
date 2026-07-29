import { isRecord } from "@ccflare/types";
import type { JsonRecord } from "../types";
import {
	claudeModelSupportsAdaptive,
	claudeModelSupportsMax,
	convertBudgetToReasoningEffort,
	convertLevelToBudget,
	mapClaudeEffortToReasoningEffort,
	mapToClaudeEffort,
	normalizeReasoningEffort,
} from "./shared";

export function applyAnthropicThinkingToOpenAI(
	input: JsonRecord,
	output: JsonRecord,
): void {
	if (!isRecord(input.thinking) || typeof input.thinking.type !== "string") {
		return;
	}

	switch (input.thinking.type) {
		case "disabled":
			output.reasoning_effort = "none";
			return;
		case "enabled": {
			if (typeof input.thinking.budget_tokens === "number") {
				const effort = convertBudgetToReasoningEffort(
					input.thinking.budget_tokens,
				);
				if (effort) {
					output.reasoning_effort = effort;
				}
			} else {
				output.reasoning_effort = "auto";
			}
			return;
		}
		case "adaptive":
		case "auto": {
			const effort = mapClaudeEffortToReasoningEffort(
				isRecord(input.output_config) ? input.output_config.effort : undefined,
			);
			output.reasoning_effort = effort ?? "xhigh";
		}
	}
}

export function applyOpenAIThinkingToAnthropic(
	output: JsonRecord,
	reasoningEffort: unknown,
): void {
	const effort = normalizeReasoningEffort(reasoningEffort);
	if (!effort) {
		return;
	}

	if (effort === "none") {
		output.thinking = { type: "disabled" };
		delete output.output_config;
		return;
	}

	if (claudeModelSupportsAdaptive(String(output.model))) {
		output.thinking = { type: "adaptive" };
		if (effort === "auto") {
			delete output.output_config;
			return;
		}
		const claudeEffort = mapToClaudeEffort(
			effort,
			claudeModelSupportsMax(String(output.model)),
		);
		if (claudeEffort) {
			output.output_config = { effort: claudeEffort };
		}
		return;
	}

	if (effort === "auto") {
		output.thinking = { type: "enabled" };
		return;
	}

	const budget = convertLevelToBudget(effort);
	if (budget === undefined) {
		return;
	}

	if (budget === 0) {
		output.thinking = { type: "disabled" };
		return;
	}

	output.thinking = { type: "enabled", budget_tokens: budget };
	const maxTokens =
		typeof output.max_tokens === "number" && output.max_tokens > 0
			? output.max_tokens
			: typeof output.max_completion_tokens === "number" &&
					output.max_completion_tokens > 0
				? output.max_completion_tokens
				: 0;
	if (maxTokens > 0 && maxTokens <= budget) {
		output.max_tokens = budget + 1;
	}
}
