import type { ThemePalette } from "@ccflare/ui";
import type { ReactNode } from "react";
import { C } from "../theme.ts";

interface PanelProps {
	title: string;
	subtitle?: string;
	children: ReactNode;
	accent?: string;
	paddingX?: number;
	paddingY?: number;
}

export function Panel({
	title,
	subtitle,
	children,
	accent = C.accent,
	paddingX = 1,
	paddingY = 1,
}: PanelProps) {
	return (
		<box
			flexDirection="column"
			border
			borderStyle="rounded"
			borderColor={C.border}
			focusedBorderColor={C.borderActive}
			paddingX={paddingX}
			paddingY={paddingY}
		>
			<text fg={accent}>
				<strong>{title}</strong>
			</text>
			{subtitle && <text fg={C.dim}>{subtitle}</text>}
			<box height={1} />
			{children}
		</box>
	);
}

interface MetricTileProps {
	label: string;
	value: string;
	detail?: string;
	color?: string;
	minWidth?: number;
}

export function MetricTile({
	label,
	value,
	detail,
	color = C.text,
	minWidth = 18,
}: MetricTileProps) {
	return (
		<box
			border
			borderStyle="rounded"
			borderColor={C.border}
			paddingX={2}
			paddingY={1}
			minWidth={minWidth}
		>
			<box flexDirection="column">
				<text fg={C.dim}>{label}</text>
				<text fg={color}>
					<strong>{value}</strong>
				</text>
				{detail && <text fg={C.dim}>{detail}</text>}
			</box>
		</box>
	);
}

interface LabeledValueProps {
	label: string;
	value: string;
	valueColor?: string;
}

export function LabeledValue({
	label,
	value,
	valueColor = C.text,
}: LabeledValueProps) {
	return (
		<box flexDirection="row" gap={1}>
			<text fg={C.dim}>{label}</text>
			<text fg={valueColor}>{value}</text>
		</box>
	);
}

export function ShortcutLegend({
	items,
}: {
	items: Array<{ key: string; label: string }>;
}) {
	const content = items.map((item) => `${item.key} ${item.label}`).join("  ");
	return <text fg={C.muted}>{content}</text>;
}

export function EmptyState({ title, body }: { title: string; body: string }) {
	return (
		<box
			border
			borderStyle="rounded"
			borderColor={C.border}
			paddingX={2}
			paddingY={1}
			flexDirection="column"
		>
			<text fg={C.text}>
				<strong>{title}</strong>
			</text>
			<text fg={C.dim}>{body}</text>
		</box>
	);
}

interface ModalFrameProps {
	title: string;
	subtitle?: string;
	children: ReactNode;
	footer?: ReactNode;
	width?: number;
}

export function ModalFrame({
	title,
	subtitle,
	children,
	footer,
	width = 72,
}: ModalFrameProps) {
	return (
		<box
			position="absolute"
			top={0}
			left={0}
			width="100%"
			height="100%"
			alignItems="center"
			justifyContent="center"
		>
			{/* Backdrop */}
			<box
				width="100%"
				height="100%"
				backgroundColor={C.bg}
				opacity={0.55}
				position="absolute"
				top={0}
				left={0}
			/>

			{/* Modal content */}
			<box width={width} maxWidth="92%" flexDirection="column">
				<box
					border
					borderStyle="rounded"
					borderColor={C.borderActive}
					backgroundColor={C.bg}
					paddingX={2}
					paddingY={1}
					flexDirection="column"
				>
					<text fg={C.accent}>
						<strong>{title}</strong>
					</text>
					{subtitle && <text fg={C.dim}>{subtitle}</text>}
					<box height={1} />
					{children}
					{footer && (
						<>
							<box height={1} />
							{footer}
						</>
					)}
				</box>
			</box>
		</box>
	);
}

export function ThemeSwatches({ theme }: { theme: ThemePalette }) {
	const colors = [
		theme.background,
		theme.primary,
		theme.accent,
		theme.success,
		theme.chart2,
	];
	const colorKeyCounts = new Map<string, number>();
	const keyedColors = colors.map((color) => {
		const count = (colorKeyCounts.get(color) ?? 0) + 1;
		colorKeyCounts.set(color, count);
		return {
			color,
			key: count === 1 ? color : `${color}-${count}`,
		};
	});

	return (
		<text>
			{keyedColors.map(({ color, key }) => (
				<span key={`${theme.id}-${key}`} fg={color}>
					{"■■"}
				</span>
			))}
		</text>
	);
}
