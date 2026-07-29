import { formatCost } from "@ccflare/core";
import type { RequestPayload } from "@ccflare/types";
import {
	decodeBase64Body,
	formatTime,
	formatTokens,
	getStatusCodeTermColor,
	safeJsonPrettyPrint,
} from "@ccflare/ui";
import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useState } from "react";
import * as tuiCore from "../core";
import { C } from "../theme.ts";
import { TokenUsageDisplay } from "./TokenUsageDisplay.tsx";

interface RequestsScreenProps {
	refreshKey: number;
}

export function RequestsScreen({ refreshKey }: RequestsScreenProps) {
	const [requests, setRequests] = useState<RequestPayload[]>([]);
	const [summaries, setSummaries] = useState<
		Map<string, tuiCore.RequestSummary>
	>(new Map());
	const [loading, setLoading] = useState(true);
	const [selectedIdx, setSelectedIdx] = useState(0);
	const [viewDetails, setViewDetails] = useState(false);
	const [page, setPage] = useState(0);
	const pageSize = 12;

	useKeyboard((key) => {
		if (key.name === "escape") {
			if (viewDetails) setViewDetails(false);
			return;
		}

		if (!viewDetails) {
			if (key.name === "up" || key.name === "k") {
				setSelectedIdx((i) => Math.max(0, i - 1));
			}
			if (key.name === "down" || key.name === "j") {
				setSelectedIdx((i) =>
					Math.min(
						Math.min(requests.length - 1, page * pageSize + pageSize - 1),
						i + 1,
					),
				);
			}
			if (key.name === "left" && page > 0) {
				setPage((p) => p - 1);
				setSelectedIdx((page - 1) * pageSize);
			}
			if (key.name === "right" && (page + 1) * pageSize < requests.length) {
				setPage((p) => p + 1);
				setSelectedIdx((page + 1) * pageSize);
			}
			if (
				key.name === "return" ||
				key.name === "enter" ||
				key.name === "space"
			) {
				if (requests.length > 0) setViewDetails(true);
			}
		}
	});

	const loadRequests = useCallback(async () => {
		try {
			const [reqData, sumData] = await Promise.all([
				tuiCore.getRequests(100),
				tuiCore.getRequestSummaries(100),
			]);
			setRequests(reqData);
			setSummaries(sumData);
			setLoading(false);
		} catch {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadRequests();
		const interval = setInterval(loadRequests, 10000);
		return () => clearInterval(interval);
	}, [loadRequests]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey triggers manual refresh
	useEffect(() => {
		loadRequests();
	}, [refreshKey, loadRequests]);

	if (loading) {
		return (
			<box padding={1}>
				<text fg={C.dim}>Loading requests...</text>
			</box>
		);
	}

	const selectedReq = requests[selectedIdx];
	const selectedSum = selectedReq ? summaries.get(selectedReq.id) : undefined;

	// Detail view
	if (viewDetails && selectedReq) {
		return (
			<scrollbox flexGrow={1} focused>
				<box flexDirection="column" padding={1} gap={1}>
					<text fg={C.text}>
						<strong>Request Details</strong>
					</text>

					<box flexDirection="column">
						<box flexDirection="row" gap={1}>
							<text fg={C.dim}>ID:</text>
							<text fg={C.text}>{selectedReq.id}</text>
						</box>
						<box flexDirection="row" gap={1}>
							<text fg={C.dim}>Time:</text>
							<text fg={C.text}>
								{formatTime(selectedReq.meta.trace.timestamp)}
							</text>
						</box>
						{selectedReq.meta.account.name && (
							<box flexDirection="row" gap={1}>
								<text fg={C.dim}>Account:</text>
								<text fg={C.text}>{selectedReq.meta.account.name}</text>
							</box>
						)}
						{selectedSum?.model && (
							<box flexDirection="row" gap={1}>
								<text fg={C.dim}>Model:</text>
								<text fg={C.success}>{selectedSum.model}</text>
							</box>
						)}
						{selectedReq.response && (
							<box flexDirection="row" gap={1}>
								<text fg={C.dim}>Status:</text>
								<text fg={getStatusCodeTermColor(selectedReq.response.status)}>
									<strong>{selectedReq.response.status.toString()}</strong>
								</text>
							</box>
						)}
						{selectedSum?.responseTimeMs && (
							<box flexDirection="row" gap={1}>
								<text fg={C.dim}>Response Time:</text>
								<text fg={C.chart1}>
									{selectedSum.responseTimeMs.toString()}ms
								</text>
							</box>
						)}
						{selectedReq.meta.transport.retry !== undefined &&
							selectedReq.meta.transport.retry > 0 && (
								<box flexDirection="row" gap={1}>
									<text fg={C.dim}>Retries:</text>
									<text fg={C.warning}>
										{selectedReq.meta.transport.retry.toString()}
									</text>
								</box>
							)}
						{selectedReq.meta.transport.rateLimited && (
							<text fg={C.warning}>Rate Limited</text>
						)}
						{selectedReq.error && (
							<box flexDirection="row" gap={1}>
								<text fg={C.dim}>Error:</text>
								<text fg={C.error}>{selectedReq.error}</text>
							</box>
						)}
					</box>

					{/* Token Usage */}
					{selectedSum &&
						(selectedSum.inputTokens || selectedSum.outputTokens) && (
							<TokenUsageDisplay summary={selectedSum} />
						)}

					{/* Request Headers */}
					<box flexDirection="column">
						<text fg={C.text}>
							<strong>Request Headers</strong>
						</text>
						<text fg={C.muted}>
							{safeJsonPrettyPrint(JSON.stringify(selectedReq.request.headers))}
						</text>
					</box>

					{/* Request Body */}
					{selectedReq.request.body && (
						<box flexDirection="column">
							<text fg={C.text}>
								<strong>Request Body</strong>
							</text>
							<text fg={C.muted}>
								{safeJsonPrettyPrint(
									decodeBase64Body(selectedReq.request.body),
								).substring(0, 500)}
								{decodeBase64Body(selectedReq.request.body).length > 500
									? "…"
									: ""}
							</text>
						</box>
					)}

					{/* Response */}
					{selectedReq.response && (
						<>
							<box flexDirection="row" gap={1}>
								<text fg={C.text}>
									<strong>Response Status:</strong>
								</text>
								<text fg={getStatusCodeTermColor(selectedReq.response.status)}>
									{selectedReq.response.status.toString()}
								</text>
							</box>
							{selectedReq.response.body && (
								<box flexDirection="column">
									<text fg={C.text}>
										<strong>Response Body</strong>
									</text>
									<text fg={C.muted}>
										{safeJsonPrettyPrint(
											decodeBase64Body(selectedReq.response.body),
										).substring(0, 500)}
										{decodeBase64Body(selectedReq.response.body).length > 500
											? "…"
											: ""}
									</text>
								</box>
							)}
						</>
					)}

					<text fg={C.muted}>Esc: back to list</text>
				</box>
			</scrollbox>
		);
	}

	// List view
	const startIdx = page * pageSize;
	const endIdx = Math.min(startIdx + pageSize, requests.length);
	const pageRequests = requests.slice(startIdx, endIdx);
	const totalPages = Math.ceil(requests.length / pageSize);

	return (
		<box flexDirection="column" padding={1} flexGrow={1}>
			{/* Header */}
			<text fg={C.muted}>↑↓/jk navigate · Enter details · ←→ pages</text>

			{requests.length === 0 ? (
				<text fg={C.muted}>No requests found</text>
			) : (
				<box flexDirection="column" marginTop={1}>
					{pageRequests.map((req, idx) => {
						const index = startIdx + idx;
						const isSelected = index === selectedIdx;
						const statusCode = req.response?.status;
						const summary = summaries.get(req.id);

						return (
							<box
								key={req.id}
								backgroundColor={isSelected ? C.surface : undefined}
								paddingX={1}
							>
								<text fg={isSelected ? C.accent : C.text}>
									{isSelected ? "▸ " : "  "}
									<span fg={C.dim}>{formatTime(req.meta.trace.timestamp)}</span>{" "}
									{statusCode ? (
										<span fg={getStatusCodeTermColor(statusCode)}>
											{statusCode.toString()}
										</span>
									) : (
										<span fg={C.error}>ERR</span>
									)}{" "}
									<span fg={C.dim}>
										{req.meta.account.name ||
											req.meta.account.id?.slice(0, 8) ||
											"—"}
									</span>
									{summary?.model && (
										<span fg={C.chart3}> {summary.model.split("-").pop()}</span>
									)}
									{summary?.totalTokens && (
										<span fg={C.muted}>
											{" "}
											{formatTokens(summary.totalTokens)}
										</span>
									)}
									{summary?.costUsd && summary.costUsd > 0 && (
										<span fg={C.success}> {formatCost(summary.costUsd)}</span>
									)}
									{req.meta.transport.rateLimited && (
										<span fg={C.warning}> [RL]</span>
									)}
								</text>
							</box>
						);
					})}

					<box marginTop={1}>
						<text fg={C.muted}>
							Page {(page + 1).toString()}/{totalPages.toString()} ·{" "}
							{requests.length.toString()} total
						</text>
					</box>
				</box>
			)}
		</box>
	);
}
