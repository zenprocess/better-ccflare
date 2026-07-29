import {
	createLogFeedInitialState,
	getLogSeverityMeta,
	type LogFeedAction,
	logFeedReducer,
} from "@ccflare/ui";
import { useKeyboard } from "@opentui/react";
import { useEffect, useReducer } from "react";
import * as tuiCore from "../core";
import { C } from "../theme.ts";

interface LogsScreenProps {
	refreshKey: number;
}

const MAX_LOGS = 200;

function reducer(
	state: ReturnType<typeof createLogFeedInitialState>,
	action: LogFeedAction,
) {
	return logFeedReducer(state, action, { maxBuffer: MAX_LOGS });
}

export function LogsScreen({ refreshKey }: LogsScreenProps) {
	const [state, dispatch] = useReducer(
		reducer,
		undefined,
		createLogFeedInitialState,
	);
	const logKeyCounts = new Map<string, number>();
	const keyedLogs = state.logs.map((log) => {
		const baseKey = `${log.ts}-${log.level ?? ""}-${log.msg}`;
		const count = (logKeyCounts.get(baseKey) ?? 0) + 1;
		logKeyCounts.set(baseKey, count);
		return {
			key: count === 1 ? baseKey : `${baseKey}-${count}`,
			log,
		};
	});

	useKeyboard((key) => {
		if (key.name === "space") {
			dispatch({ type: "toggle_pause" });
		}
		if (key.name === "c" && !key.ctrl) {
			dispatch({ type: "clear" });
		}
	});

	// Load historical logs on mount and on refreshKey change
	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey triggers manual refresh
	useEffect(() => {
		const loadHistory = async () => {
			try {
				const history = await tuiCore.getLogHistory();
				dispatch({ type: "history_loaded", logs: history });
			} catch {
				dispatch({ type: "history_error" });
			}
		};
		loadHistory();
	}, [refreshKey]);

	// Stream live logs when not paused and not loading
	useEffect(() => {
		if (!state.paused && !state.loading) {
			const unsubscribe = tuiCore.streamLogs((log) => {
				dispatch({ type: "new_entry", log });
			});
			return () => {
				unsubscribe();
			};
		}
	}, [state.paused, state.loading]);

	return (
		<box flexDirection="column" padding={1} flexGrow={1}>
			{/* Controls */}
			<box flexDirection="row" gap={2}>
				<text fg={C.muted}>
					<span fg={C.dim}>space</span> {state.paused ? "resume" : "pause"}{" "}
					<span fg={C.dim}>c</span> clear
				</text>
				{state.paused && (
					<text fg={C.warning}>
						<strong>PAUSED</strong>
					</text>
				)}
			</box>

			{/* Log content */}
			<scrollbox flexGrow={1} focused marginTop={1}>
				{state.loading ? (
					<text fg={C.muted}>Loading logs...</text>
				) : state.logs.length === 0 ? (
					<text fg={C.muted}>No logs yet...</text>
				) : (
					<box flexDirection="column">
						{keyedLogs.map(({ key, log }) => {
							const sev = getLogSeverityMeta(log.level);
							return (
								<text key={key} fg={sev.termColor}>
									[{sev.label}] {log.msg}
								</text>
							);
						})}
					</box>
				)}
			</scrollbox>
		</box>
	);
}
