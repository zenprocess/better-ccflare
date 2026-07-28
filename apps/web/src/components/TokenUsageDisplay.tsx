import type { RequestSummary } from "@ccflare/types";
import { processTokenUsage, type TokenUsageInfo } from "@ccflare/ui";

type Section = TokenUsageInfo["sections"];

function MetricCard({
	section,
}: {
	section: Section[keyof Section] | undefined;
}) {
	if (!section) return null;
	return (
		<div className="bg-muted p-4 rounded-lg">
			<h4 className="font-semibold mb-2">{section.label}</h4>
			<p className="text-2xl font-mono">{section.value}</p>
		</div>
	);
}

interface TokenUsageDisplayProps {
	summary: RequestSummary | undefined;
}

export function TokenUsageDisplay({ summary }: TokenUsageDisplayProps) {
	// Convert RequestSummary to TokenUsageData format while preserving explicit null metadata.
	const tokenData = summary
		? {
				inputTokens: summary.inputTokens,
				outputTokens: summary.outputTokens,
				reasoningTokens: summary.reasoningTokens,
				cacheReadInputTokens: summary.cacheReadInputTokens,
				cacheCreationInputTokens: summary.cacheCreationInputTokens,
				totalTokens: summary.totalTokens,
				costUsd: summary.costUsd,
				responseTimeMs: summary.responseTimeMs,
				tokensPerSecond: summary.tokensPerSecond,
				ttftMs: summary.ttftMs,
				proxyOverheadMs: summary.proxyOverheadMs,
				upstreamTtfbMs: summary.upstreamTtfbMs,
				streamingDurationMs: summary.streamingDurationMs,
			}
		: undefined;

	const usage = processTokenUsage(tokenData);

	if (!usage.hasData) {
		return (
			<div className="text-center text-muted-foreground py-8">
				<p>No token usage data available</p>
			</div>
		);
	}

	const { sections } = usage;

	const hasTimingData =
		sections.ttft ||
		sections.proxyOverhead ||
		sections.upstreamTtfb ||
		sections.streamingDuration;

	return (
		<div className="space-y-4">
			<div className="grid grid-cols-2 gap-4">
				<MetricCard section={sections.inputTokens} />
				<MetricCard section={sections.outputTokens} />
				<MetricCard section={sections.reasoningTokens} />
				<MetricCard section={sections.cacheReadTokens} />
				<MetricCard section={sections.cacheCreationTokens} />
			</div>

			{sections.totalTokens && (
				<div className="bg-primary/10 p-4 rounded-lg">
					<h4 className="font-semibold mb-2">{sections.totalTokens.label}</h4>
					<p className="text-3xl font-mono font-bold">
						{sections.totalTokens.value}
					</p>
					{sections.cost && (
						<p className="mt-2 text-lg text-muted-foreground">
							{sections.cost.label}: {sections.cost.value}
						</p>
					)}
				</div>
			)}

			<div className="grid grid-cols-2 gap-4">
				<MetricCard section={sections.responseTime} />
				<MetricCard section={sections.tokensPerSecond} />
			</div>

			{hasTimingData && (
				<div className="rounded-lg border border-border p-4 space-y-3">
					<h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
						Latency Breakdown
					</h4>
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
						<MetricCard section={sections.ttft} />
						<MetricCard section={sections.proxyOverhead} />
						<MetricCard section={sections.upstreamTtfb} />
						<MetricCard section={sections.streamingDuration} />
					</div>
				</div>
			)}
		</div>
	);
}
