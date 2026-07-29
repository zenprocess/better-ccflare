import { formatCost } from "@ccflare/core";
import type { StrategyName } from "@ccflare/types";
import {
	formatNumber,
	formatPercentage,
	formatTokensPerSecond,
	getSuccessRateTermColor,
} from "@ccflare/ui";
import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useState } from "react";
import { useAppContext } from "../App.tsx";
import * as tuiCore from "../core";
import { C } from "../theme.ts";
import { BarChart } from "./charts/BarChart.tsx";

interface OverviewScreenProps {
	refreshKey: number;
	port: number;
}

export function OverviewScreen({ refreshKey, port }: OverviewScreenProps) {
	const { inputActive, setInputActive } = useAppContext();
	const [stats, setStats] = useState<tuiCore.Stats | null>(null);
	const [loading, setLoading] = useState(true);
	const [strategy, setStrategy] = useState<StrategyName | "">("");
	const [strategies, setStrategies] = useState<StrategyName[]>([]);
	const [selectingStrategy, setSelectingStrategy] = useState(false);
	const [strategyIdx, setStrategyIdx] = useState(0);
	const [message, setMessage] = useState<string | null>(null);

	const loadData = useCallback(async () => {
		try {
			const [s, current, list] = await Promise.all([
				tuiCore.getStats(),
				tuiCore.getStrategy(),
				tuiCore.listStrategies(),
			]);
			setStats(s);
			setStrategy(current);
			setStrategies(list);
			setLoading(false);
		} catch {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadData();
		const interval = setInterval(loadData, 5000);
		return () => clearInterval(interval);
	}, [loadData]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey triggers manual refresh
	useEffect(() => {
		loadData();
	}, [refreshKey, loadData]);

	useKeyboard((key) => {
		if (selectingStrategy) {
			if (key.name === "escape") {
				setSelectingStrategy(false);
				setInputActive(false);
			}
			if (key.name === "up" || key.name === "k") {
				setStrategyIdx((i) => Math.max(0, i - 1));
			}
			if (key.name === "down" || key.name === "j") {
				setStrategyIdx((i) => Math.min(strategies.length - 1, i + 1));
			}
			if (key.name === "return" || key.name === "enter") {
				const selected = strategies[strategyIdx];
				if (selected) {
					tuiCore.setStrategy(selected).then(() => {
						setStrategy(selected);
						setMessage(`Strategy changed to: ${selected}`);
						setSelectingStrategy(false);
						setInputActive(false);
						setTimeout(() => setMessage(null), 3000);
					});
				}
			}
			return;
		}

		if (inputActive) return;

		if (key.name === "s") {
			setSelectingStrategy(true);
			setInputActive(true);
			setStrategyIdx(strategies.indexOf(strategy as StrategyName));
		}
		if (key.name === "d") {
			import("open")
				.then((mod) => {
					const openFn = mod.default as (url: string) => Promise<void>;
					openFn(`http://localhost:${port}`);
				})
				.catch(() => {});
		}
	});

	if (loading || !stats) {
		return (
			<box padding={1}>
				<text fg={C.dim}>Loading dashboard...</text>
			</box>
		);
	}

	const avgCostPerReq =
		stats.totalRequests > 0 ? stats.totalCostUsd / stats.totalRequests : 0;
	const successColor = getSuccessRateTermColor(stats.successRate);
	const errorKeyCounts = new Map<string, number>();
	const keyedRecentErrors = stats.recentErrors.slice(0, 5).map((err) => {
		const count = (errorKeyCounts.get(err) ?? 0) + 1;
		errorKeyCounts.set(err, count);
		return {
			err,
			key: count === 1 ? err : `${err}-${count}`,
		};
	});

	// Strategy selector overlay
	if (selectingStrategy) {
		return (
			<box flexDirection="column" padding={1}>
				<text fg={C.text}>
					<strong>Select Load Balancer Strategy</strong>
				</text>
				<box flexDirection="column" marginTop={1}>
					{strategies.map((s, i) => {
						const active = i === strategyIdx;
						const current = s === strategy;
						return (
							<box
								key={s}
								paddingX={1}
								backgroundColor={active ? C.surface : undefined}
							>
								<text fg={active ? C.accent : current ? C.info : C.dim}>
									{active ? "▸ " : "  "}
									{s}
									{current ? " (current)" : ""}
								</text>
							</box>
						);
					})}
				</box>
				<box marginTop={1}>
					<text fg={C.muted}>Enter: select Esc: cancel</text>
				</box>
			</box>
		);
	}

	return (
		<scrollbox flexGrow={1} focused>
			<box flexDirection="column" padding={1} gap={1}>
				{/* Message */}
				{message && <text fg={C.success}>✓ {message}</text>}

				{/* Metric Cards Row */}
				<box flexDirection="row" gap={1} flexWrap="wrap">
					<MetricCard
						title="Total Requests"
						value={formatNumber(stats.totalRequests)}
						color={C.chart1}
					/>
					<MetricCard
						title="Success Rate"
						value={formatPercentage(stats.successRate)}
						color={successColor}
					/>
					<MetricCard
						title="Avg Response"
						value={`${formatNumber(stats.avgResponseTime)}ms`}
						color={C.chart3}
					/>
					<MetricCard
						title="Total Cost"
						value={formatCost(stats.totalCostUsd)}
						color={C.success}
					/>
					{stats.avgTokensPerSecond !== null && (
						<MetricCard
							title="Output Speed"
							value={formatTokensPerSecond(stats.avgTokensPerSecond)}
							color={C.chart2}
						/>
					)}
				</box>

				{/* Token Breakdown */}
				{stats.tokenDetails && (
					<box flexDirection="column">
						<text fg={C.text}>
							<strong>Token Usage</strong>
						</text>
						<box flexDirection="column" marginTop={1} paddingLeft={1}>
							<TokenBar
								label="Input"
								value={stats.tokenDetails.inputTokens}
								total={stats.totalTokens}
								color={C.chart1}
							/>
							{stats.tokenDetails.cacheReadInputTokens > 0 && (
								<TokenBar
									label="Cache Read"
									value={stats.tokenDetails.cacheReadInputTokens}
									total={stats.totalTokens}
									color={C.chart2}
								/>
							)}
							{stats.tokenDetails.cacheCreationInputTokens > 0 && (
								<TokenBar
									label="Cache Create"
									value={stats.tokenDetails.cacheCreationInputTokens}
									total={stats.totalTokens}
									color={C.info}
								/>
							)}
							<TokenBar
								label="Output"
								value={stats.tokenDetails.outputTokens}
								total={stats.totalTokens}
								color={C.success}
							/>
						</box>
						<box marginTop={1} paddingLeft={1}>
							<text fg={C.dim}>
								Total: {formatNumber(stats.totalTokens)} tokens ·{" "}
								{formatCost(avgCostPerReq)} avg/req
							</text>
						</box>
					</box>
				)}

				{/* Account Performance */}
				{stats.accounts.length > 0 && (
					<BarChart
						title="Account Performance"
						data={stats.accounts.map((a) => ({
							label: a.name,
							value: a.requestCount,
							color: getSuccessRateTermColor(a.successRate),
						}))}
						width={30}
						showValues
					/>
				)}

				{/* Strategy & Server */}
				<box flexDirection="row" gap={3}>
					<box flexDirection="column">
						<text fg={C.text}>
							<strong>Strategy</strong>
						</text>
						<box flexDirection="row" gap={1} marginTop={1}>
							<text fg={C.accent}>{strategy}</text>
							<text fg={C.muted}>[s] change</text>
						</box>
					</box>
					<box flexDirection="column">
						<text fg={C.text}>
							<strong>Server</strong>
						</text>
						<box flexDirection="row" gap={1} marginTop={1}>
							<text fg={C.success}>● Running</text>
							<text fg={C.dim}>:{port.toString()}</text>
							<text fg={C.muted}>[d] dashboard</text>
						</box>
					</box>
				</box>

				{/* Recent Errors */}
				{stats.recentErrors.length > 0 && (
					<box flexDirection="column">
						<text fg={C.error}>
							<strong>Recent Errors</strong>
						</text>
						<box flexDirection="column" marginTop={1} paddingLeft={1}>
							{keyedRecentErrors.map(({ err, key }) => (
								<text key={key} fg={C.muted}>
									• {err.length > 70 ? `${err.substring(0, 70)}…` : err}
								</text>
							))}
						</box>
					</box>
				)}

				{/* Controls */}
				<box marginTop={1}>
					<text fg={C.muted}>
						<span fg={C.dim}>s</span> strategy <span fg={C.dim}>d</span>{" "}
						dashboard
					</text>
				</box>
			</box>
		</scrollbox>
	);
}

function MetricCard({
	title,
	value,
	color,
}: {
	title: string;
	value: string;
	color: string;
}) {
	return (
		<box
			border
			borderStyle="rounded"
			borderColor={C.border}
			paddingX={2}
			paddingY={0}
			minWidth={16}
		>
			<box flexDirection="column">
				<text fg={C.dim}>{title}</text>
				<text fg={color}>
					<strong>{value}</strong>
				</text>
			</box>
		</box>
	);
}

function TokenBar({
	label,
	value,
	total,
	color,
}: {
	label: string;
	value: number;
	total: number;
	color: string;
}) {
	const pct = total > 0 ? (value / total) * 100 : 0;
	const barWidth = 20;
	const filled = Math.round((pct / 100) * barWidth);

	return (
		<box flexDirection="row" gap={1}>
			<text fg={C.dim}>{label.padEnd(13)}</text>
			<text fg={color}>{"█".repeat(filled)}</text>
			<text fg={C.muted}>{"░".repeat(barWidth - filled)}</text>
			<text fg={C.dim}>
				{" "}
				{formatNumber(value)} ({Math.round(pct)}%)
			</text>
		</box>
	);
}
