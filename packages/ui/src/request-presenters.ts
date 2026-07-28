/**
 * Pure presentation helpers for request/log display.
 *
 * These functions are shared between dashboard-web and TUI.
 * They contain no DOM or Ink dependencies -- only string/data transforms.
 */

import { decodeBase64Utf8 } from "@ccflare/types";

export function decodeBase64Body(str: string | null): string {
	if (!str) return "No data";
	if (str === "[streamed]") return "[Streaming data not captured]";

	const decoded = decodeBase64Utf8(str);
	return decoded ?? `Failed to decode: ${str}`;
}

/**
 * Safely pretty-print a string as JSON. Returns the original string unchanged
 * if it is not valid JSON.
 */
export function safeJsonPrettyPrint(str: string): string {
	try {
		return JSON.stringify(JSON.parse(str), null, 2);
	} catch {
		return str;
	}
}

/**
 * Format a headers record for display.
 * When `beautify` is true (the default), outputs indented JSON.
 * Otherwise outputs `key: value` lines.
 */
export function formatHeaders(
	headers: Record<string, string>,
	beautify = true,
): string {
	if (!beautify) {
		return Object.entries(headers)
			.map(([key, value]) => `${key}: ${value}`)
			.join("\n");
	}
	return JSON.stringify(headers, null, 2);
}

/**
 * Decode a base64 body and optionally beautify it.
 */
export function formatBody(body: string | null, beautify = true): string {
	const decoded = decodeBase64Body(body);
	if (!beautify) return decoded;
	return safeJsonPrettyPrint(decoded);
}

export type LogSeverity = "ERROR" | "WARN" | "INFO" | "DEBUG";

interface LogSeverityMeta {
	/** Canonical level name for display */
	label: string;
	/** Tailwind text class for browser UIs */
	cssClass: string;
	/** Terminal color name for Ink/chalk */
	termColor: string;
}

const LOG_SEVERITY_MAP: Record<string, LogSeverityMeta> = {
	ERROR: { label: "ERROR", cssClass: "text-destructive", termColor: "red" },
	WARN: { label: "WARN", cssClass: "text-warning", termColor: "yellow" },
	INFO: { label: "INFO", cssClass: "text-success", termColor: "green" },
	DEBUG: {
		label: "DEBUG",
		cssClass: "text-muted-foreground",
		termColor: "gray",
	},
};

const DEFAULT_SEVERITY_META: LogSeverityMeta = {
	label: "LOG",
	cssClass: "",
	termColor: "white",
};

/**
 * Get display metadata (label, css class, terminal color) for a log level.
 */
export function getLogSeverityMeta(level: string | undefined): LogSeverityMeta {
	if (!level) return DEFAULT_SEVERITY_META;
	return LOG_SEVERITY_MAP[level.toUpperCase()] ?? DEFAULT_SEVERITY_META;
}

export type StatusCategory = "success" | "warning" | "error" | "info";

/**
 * Categorize an HTTP status code for display purposes.
 */
export function getStatusCategory(statusCode: number): StatusCategory {
	if (statusCode === 101 || (statusCode >= 200 && statusCode < 300))
		return "success";
	if (statusCode >= 400 && statusCode < 500) return "warning";
	if (statusCode >= 500) return "error";
	return "info";
}

/**
 * Get a Tailwind text color class for a status code.
 */
export function getStatusCodeCssClass(statusCode: number): string {
	switch (getStatusCategory(statusCode)) {
		case "success":
			return "text-success";
		case "warning":
			return "text-warning";
		case "error":
			return "text-destructive";
		default:
			return "text-muted-foreground";
	}
}

/**
 * Get a terminal color for a status code (for Ink/chalk).
 */
export function getStatusCodeTermColor(statusCode: number): string {
	switch (getStatusCategory(statusCode)) {
		case "success":
			return "green";
		case "warning":
			return "yellow";
		case "error":
			return "red";
		default:
			return "white";
	}
}

/**
 * Format a time-only display from a numeric timestamp.
 */
export function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString();
}
