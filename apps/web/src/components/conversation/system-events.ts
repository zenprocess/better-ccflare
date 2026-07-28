import type { SystemEventNotice } from "./SystemEventBlock";

const SESSION_PREFIX = "Session state changed:";
const TOOL_PROGRESS_PREFIX = "Tool progress:";
const TOOL_SUMMARY_PREFIX = "Tool summary:";
const TOOL_PERMISSION_PREFIX = "Tool permission requested:";

export function parseSystemEventNotices(content: string): {
	notices: SystemEventNotice[];
	remainingContent: string;
} {
	const paragraphs = content
		.split(/\n{2,}/)
		.map((paragraph) => paragraph.trim())
		.filter(Boolean);

	const notices: SystemEventNotice[] = [];
	const remaining: string[] = [];

	for (const paragraph of paragraphs) {
		if (paragraph.startsWith(SESSION_PREFIX)) {
			notices.push({
				kind: "session_state_changed",
				title: "Session State",
				detail: paragraph.slice(SESSION_PREFIX.length).trim(),
			});
			continue;
		}
		if (paragraph.startsWith(TOOL_PROGRESS_PREFIX)) {
			notices.push({
				kind: "tool_progress",
				title: "Tool Progress",
				detail: paragraph.slice(TOOL_PROGRESS_PREFIX.length).trim(),
			});
			continue;
		}
		if (paragraph.startsWith(TOOL_SUMMARY_PREFIX)) {
			notices.push({
				kind: "tool_summary",
				title: "Tool Summary",
				detail: paragraph.slice(TOOL_SUMMARY_PREFIX.length).trim(),
			});
			continue;
		}
		if (paragraph.startsWith(TOOL_PERMISSION_PREFIX)) {
			notices.push({
				kind: "tool_permission",
				title: "Tool Permission",
				detail: paragraph.slice(TOOL_PERMISSION_PREFIX.length).trim(),
			});
			continue;
		}

		remaining.push(paragraph);
	}

	return {
		notices,
		remainingContent: remaining.join("\n\n"),
	};
}
