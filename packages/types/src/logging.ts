import { isFiniteNumber, isRecord } from "./guards";

export const LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogEvent {
	ts: number;
	level: LogLevel;
	msg: string;
}

export type LogStreamEvent = { connected: true } | LogEvent;

export function isLogLevel(value: string): value is LogLevel {
	return LOG_LEVELS.includes(value as LogLevel);
}

export function isLogEvent(value: unknown): value is LogEvent {
	return (
		isRecord(value) &&
		isFiniteNumber(value.ts) &&
		typeof value.level === "string" &&
		isLogLevel(value.level) &&
		typeof value.msg === "string"
	);
}

export function parseLogStreamEvent(value: unknown): LogStreamEvent | null {
	if (isLogEvent(value)) {
		return value;
	}

	return isRecord(value) && value.connected === true
		? { connected: true }
		: null;
}
