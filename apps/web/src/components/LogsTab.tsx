import type { LogEvent } from "@ccflare/types";
import {
	createLogFeedInitialState,
	formatTime,
	getLogSeverityMeta,
	type LogFeedAction,
	logFeedReducer,
} from "@ccflare/ui";
import { Pause, Play, Trash2 } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api } from "../api";
import { useLogHistory } from "../hooks/queries";
import { Button } from "./ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";

const MAX_LOGS = 1000;

function reducer(
	state: ReturnType<typeof createLogFeedInitialState>,
	action: LogFeedAction,
) {
	return logFeedReducer(state, action, { maxBuffer: MAX_LOGS });
}

export function LogsTab() {
	const [state, dispatch] = useReducer(
		reducer,
		undefined,
		createLogFeedInitialState,
	);
	const [autoScroll, setAutoScroll] = useState(true);
	const eventSourceRef = useRef<EventSource | null>(null);
	const logsEndRef = useRef<HTMLDivElement>(null);

	const scrollToBottom = useCallback(() => {
		if (autoScroll && logsEndRef.current) {
			setTimeout(() => {
				logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
			}, 0);
		}
	}, [autoScroll]);

	const startStreaming = useCallback(() => {
		eventSourceRef.current = api.streamLogs((log: LogEvent) => {
			dispatch({ type: "new_entry", log });
			scrollToBottom();
		});
	}, [scrollToBottom]);

	const stopStreaming = useCallback(() => {
		if (eventSourceRef.current) {
			eventSourceRef.current.close();
			eventSourceRef.current = null;
		}
	}, []);

	// Load historical logs on mount
	const { data: history, isLoading: loading, error } = useLogHistory();

	useEffect(() => {
		if (history) {
			dispatch({ type: "history_loaded", logs: history });
			scrollToBottom();
		}
	}, [history, scrollToBottom]);

	useEffect(() => {
		if (!state.paused && !loading) {
			startStreaming();
		}

		return () => {
			stopStreaming();
		};
	}, [state.paused, loading, startStreaming, stopStreaming]);

	useEffect(() => {
		if (autoScroll && logsEndRef.current) {
			logsEndRef.current.scrollIntoView({ behavior: "smooth" });
		}
	}, [autoScroll]);

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div>
						<CardTitle>Live Logs</CardTitle>
						<CardDescription>
							Real-time log stream {state.paused && "(Paused)"}
						</CardDescription>
					</div>
					<div className="flex gap-2">
						<Button
							onClick={() => dispatch({ type: "toggle_pause" })}
							variant="outline"
							size="sm"
						>
							{state.paused ? (
								<>
									<Play className="mr-2 h-4 w-4" />
									Resume
								</>
							) : (
								<>
									<Pause className="mr-2 h-4 w-4" />
									Pause
								</>
							)}
						</Button>
						<Button
							onClick={() => dispatch({ type: "clear" })}
							variant="outline"
							size="sm"
						>
							<Trash2 className="mr-2 h-4 w-4" />
							Clear
						</Button>
					</div>
				</div>
			</CardHeader>
			<CardContent>
				<div className="space-y-1 max-h-[500px] overflow-y-auto font-mono text-sm">
					{loading ? (
						<p className="text-muted-foreground">Loading logs...</p>
					) : error ? (
						<p className="text-destructive">
							Error: {error instanceof Error ? error.message : String(error)}
						</p>
					) : state.logs.length === 0 ? (
						<p className="text-muted-foreground">No logs yet...</p>
					) : (
						state.logs.map((log) => {
							const severity = getLogSeverityMeta(log.level);
							return (
								<div
									key={`${log.ts}-${log.level}-${log.msg}`}
									className="flex gap-2"
								>
									<span className="text-muted-foreground">
										{formatTime(log.ts)}
									</span>
									<span className={`font-medium ${severity.cssClass}`}>
										[{severity.label}]
									</span>
									<span className="flex-1">{log.msg}</span>
								</div>
							);
						})
					)}
					<div ref={logsEndRef} />
				</div>
				<div className="mt-4 flex items-center gap-2">
					<input
						type="checkbox"
						id="autoscroll"
						checked={autoScroll}
						onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
							setAutoScroll((e.target as HTMLInputElement).checked)
						}
						className="rounded border-input"
					/>
					<label htmlFor="autoscroll" className="text-sm text-muted-foreground">
						Auto-scroll to bottom
					</label>
				</div>
			</CardContent>
		</Card>
	);
}
