import {
	Activity,
	ListChecks,
	type LucideIcon,
	ShieldQuestion,
	Wrench,
} from "lucide-react";
import React from "react";

type SystemEventKind =
	| "session_state_changed"
	| "tool_progress"
	| "tool_summary"
	| "tool_permission"
	| "generic";

export interface SystemEventNotice {
	kind: SystemEventKind;
	title: string;
	detail: string;
}

const STYLES: Record<
	SystemEventKind,
	{ Icon: LucideIcon; accent: string; border: string; bg: string }
> = {
	session_state_changed: {
		Icon: Activity,
		accent: "text-info",
		border: "border-info/20",
		bg: "bg-info/10",
	},
	tool_progress: {
		Icon: Wrench,
		accent: "text-warning",
		border: "border-warning/20",
		bg: "bg-warning/10",
	},
	tool_summary: {
		Icon: ListChecks,
		accent: "text-success",
		border: "border-success/20",
		bg: "bg-success/10",
	},
	tool_permission: {
		Icon: ShieldQuestion,
		accent: "text-primary",
		border: "border-primary/20",
		bg: "bg-primary/10",
	},
	generic: {
		Icon: Activity,
		accent: "text-muted-foreground",
		border: "border-border",
		bg: "bg-muted/40",
	},
};

interface SystemEventBlockProps {
	notice: SystemEventNotice;
}

function SystemEventBlockComponent({ notice }: SystemEventBlockProps) {
	const style = STYLES[notice.kind];
	const Icon = style.Icon;

	return (
		<div className={`p-3 rounded-lg border ${style.border} ${style.bg}`}>
			<div
				className={`flex items-center gap-2 text-xs font-medium ${style.accent}`}
			>
				<Icon className="w-3 h-3" />
				<span>{notice.title}</span>
			</div>
			<div className="mt-1 text-xs text-left whitespace-pre-wrap break-words">
				{notice.detail}
			</div>
		</div>
	);
}

export const SystemEventBlock = React.memo(SystemEventBlockComponent);
