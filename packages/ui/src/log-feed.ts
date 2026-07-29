/**
 * Pure log-feed state model shared between dashboard and TUI.
 *
 * Owns:
 *  - history + stream merge policy
 *  - max-buffer policy (configurable)
 *  - pause/resume semantics
 *  - clear behavior
 *
 * Does NOT own transport (SSE vs logBus) or rendering (DOM vs Ink).
 * Consumers provide a transport adapter and subscribe to state updates.
 */

import type { LogEvent } from "@ccflare/types";

export interface LogFeedState {
	/** Current visible log entries */
	logs: LogEvent[];
	/** Whether the feed is paused (new entries are dropped) */
	paused: boolean;
	/** Whether initial history is still loading */
	loading: boolean;
}

export interface LogFeedOptions {
	/** Maximum number of log entries to retain. Defaults to 1000. */
	maxBuffer?: number;
}

export type LogFeedAction =
	| { type: "history_loaded"; logs: LogEvent[] }
	| { type: "history_error" }
	| { type: "new_entry"; log: LogEvent }
	| { type: "toggle_pause" }
	| { type: "clear" };

export function createLogFeedInitialState(): LogFeedState {
	return { logs: [], paused: false, loading: true };
}

export function logFeedReducer(
	state: LogFeedState,
	action: LogFeedAction,
	options: LogFeedOptions = {},
): LogFeedState {
	const maxBuffer = options.maxBuffer ?? 1000;

	switch (action.type) {
		case "history_loaded":
			return {
				...state,
				logs: action.logs.slice(-maxBuffer),
				loading: false,
			};

		case "history_error":
			return { ...state, loading: false };

		case "new_entry": {
			if (state.paused) return state;
			const next = [...state.logs, action.log];
			return {
				...state,
				logs: next.length > maxBuffer ? next.slice(-maxBuffer) : next,
			};
		}

		case "toggle_pause":
			return { ...state, paused: !state.paused };

		case "clear":
			return { ...state, logs: [] };
	}
}
