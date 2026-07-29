import { processTokenUsage } from "@ccflare/ui";
import type { RequestSummary } from "../core";
import { C } from "../theme.ts";

interface TokenUsageDisplayProps {
	summary: RequestSummary;
}

export function TokenUsageDisplay({ summary }: TokenUsageDisplayProps) {
	const usage = processTokenUsage(summary);

	if (!usage.hasData) {
		return <text fg={C.muted}>No token usage data available</text>;
	}

	const { sections } = usage;

	return (
		<box flexDirection="column">
			<text fg={C.text}>
				<strong>Token Usage</strong>
			</text>
			<box marginLeft={2} flexDirection="column" marginTop={1}>
				{sections.inputTokens && (
					<box flexDirection="row" gap={1}>
						<text fg={C.dim}>{sections.inputTokens.label}:</text>
						<text fg={C.chart1}>
							<strong>{sections.inputTokens.value}</strong>
						</text>
					</box>
				)}
				{sections.outputTokens && (
					<box flexDirection="row" gap={1}>
						<text fg={C.dim}>{sections.outputTokens.label}:</text>
						<text fg={C.chart1}>
							<strong>{sections.outputTokens.value}</strong>
						</text>
					</box>
				)}
				{sections.reasoningTokens && (
					<box flexDirection="row" gap={1}>
						<text fg={C.dim}>{sections.reasoningTokens.label}:</text>
						<text fg={C.chart3}>
							<strong>{sections.reasoningTokens.value}</strong>
						</text>
					</box>
				)}
				{sections.cacheReadTokens && (
					<box flexDirection="row" gap={1}>
						<text fg={C.dim}>{sections.cacheReadTokens.label}:</text>
						<text fg={C.chart2}>
							<strong>{sections.cacheReadTokens.value}</strong>
						</text>
					</box>
				)}
				{sections.cacheCreationTokens && (
					<box flexDirection="row" gap={1}>
						<text fg={C.dim}>{sections.cacheCreationTokens.label}:</text>
						<text fg={C.chart2}>
							<strong>{sections.cacheCreationTokens.value}</strong>
						</text>
					</box>
				)}

				<text fg={C.muted}>─────────────────────</text>

				{sections.totalTokens && (
					<box flexDirection="row" gap={1}>
						<text fg={C.dim}>
							<strong>{sections.totalTokens.label}:</strong>
						</text>
						<text fg={C.success}>
							<strong>{sections.totalTokens.value}</strong>
						</text>
					</box>
				)}
				{sections.cost && (
					<box flexDirection="row" gap={1}>
						<text fg={C.dim}>
							<strong>{sections.cost.label}:</strong>
						</text>
						<text fg={C.success}>
							<strong>{sections.cost.value}</strong>
						</text>
					</box>
				)}
			</box>
		</box>
	);
}
