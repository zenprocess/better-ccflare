import { DatabaseFactory } from "@ccflare/database";
import {
	parseRequestPayload,
	type Request,
	type RequestPayload,
} from "@ccflare/types";

export type RequestSummary = Pick<
	Request,
	| "id"
	| "model"
	| "inputTokens"
	| "outputTokens"
	| "reasoningTokens"
	| "totalTokens"
	| "cacheReadInputTokens"
	| "cacheCreationInputTokens"
	| "costUsd"
	| "responseTimeMs"
	| "tokensPerSecond"
	| "ttftMs"
	| "proxyOverheadMs"
	| "upstreamTtfbMs"
	| "streamingDurationMs"
>;

export async function getRequests(limit = 100): Promise<RequestPayload[]> {
	const dbOps = DatabaseFactory.getInstance();
	const rows = dbOps.listRequestPayloadsWithAccountNames(limit);

	return rows.map((row) => {
		try {
			const data = parseRequestPayload(JSON.parse(row.json));
			if (!data) {
				throw new Error("Invalid payload shape");
			}

			return {
				...(data.id === row.id ? data : { ...data, id: row.id }),
				meta: {
					...data.meta,
					account: {
						...data.meta.account,
						name: row.account_name ?? data.meta.account.name ?? null,
					},
				},
			};
		} catch {
			return {
				id: row.id,
				error: "Failed to parse payload",
				request: { headers: {}, body: null },
				response: null,
				meta: {
					trace: { timestamp: Date.now() },
					account: { id: null, name: row.account_name ?? null },
					transport: {},
				},
			};
		}
	});
}

export async function getRequestSummaries(
	limit = 100,
): Promise<Map<string, RequestSummary>> {
	const dbOps = DatabaseFactory.getInstance();
	const summaries = dbOps.listRequestsWithAccountNames(limit);

	return new Map(
		summaries.map((summary) => [
			summary.id,
			{
				id: summary.id,
				model: summary.model,
				inputTokens: summary.inputTokens,
				outputTokens: summary.outputTokens,
				reasoningTokens: summary.reasoningTokens,
				totalTokens: summary.totalTokens,
				cacheReadInputTokens: summary.cacheReadInputTokens,
				cacheCreationInputTokens: summary.cacheCreationInputTokens,
				costUsd: summary.costUsd,
				responseTimeMs: summary.responseTimeMs,
				tokensPerSecond: summary.tokensPerSecond,
				ttftMs: summary.ttftMs,
				proxyOverheadMs: summary.proxyOverheadMs,
				upstreamTtfbMs: summary.upstreamTtfbMs,
				streamingDurationMs: summary.streamingDurationMs,
			},
		]),
	);
}
