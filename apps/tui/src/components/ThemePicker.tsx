import { getThemeById } from "@ccflare/ui";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useMemo, useState } from "react";
import {
	C,
	getAvailableThemes,
	getCurrentThemeId,
	setTuiTheme,
} from "../theme.ts";
import { ModalFrame, ShortcutLegend, ThemeSwatches } from "./TuiPrimitives.tsx";

interface ThemePickerProps {
	onClose: () => void;
}

export function ThemePicker({ onClose }: ThemePickerProps) {
	const { width } = useTerminalDimensions();
	const themes = getAvailableThemes();
	const currentId = getCurrentThemeId();
	const initialIndex = Math.max(
		themes.findIndex((theme) => theme.id === currentId),
		0,
	);
	const [selectedIndex, setSelectedIndex] = useState(initialIndex);

	const selectedTheme = useMemo(() => {
		const selected = themes[selectedIndex] ?? themes[0];
		return selected ? getThemeById(selected.id) : undefined;
	}, [selectedIndex, themes]);

	useKeyboard((key) => {
		if (key.name === "escape") {
			onClose();
		}
	});

	return (
		<ModalFrame
			title="Theme Studio"
			subtitle="Preview every palette before committing the switch."
			width={Math.min(76, Math.max(56, width - 10))}
			footer={
				<ShortcutLegend
					items={[
						{ key: "↑↓", label: "browse" },
						{ key: "enter", label: "apply" },
						{ key: "esc", label: "close" },
					]}
				/>
			}
		>
			<box flexDirection="row" gap={2}>
				{/* Theme list */}
				<box width="56%" minWidth={30} height={18}>
					<select
						style={{ width: "100%", height: "100%" }}
						options={themes.map((theme) => ({
							name:
								theme.id === currentId
									? `${theme.name} \u00b7 active`
									: theme.name,
							description: `${theme.family} \u00b7 ${theme.appearance}`,
							value: theme.id,
						}))}
						selectedIndex={selectedIndex}
						focused
						backgroundColor={C.bg}
						focusedBackgroundColor={C.bg}
						selectedBackgroundColor={C.surface}
						selectedTextColor={C.accent}
						onChange={(index) => setSelectedIndex(index)}
						onSelect={(_, option) => {
							if (!option?.value) return;
							setTuiTheme(String(option.value));
							onClose();
						}}
					/>
				</box>

				{/* Preview panel */}
				<box
					flexGrow={1}
					border
					borderStyle="rounded"
					borderColor={C.border}
					paddingX={2}
					paddingY={1}
					flexDirection="column"
				>
					{selectedTheme ? (
						<>
							<text fg={C.accent}>
								<strong>{selectedTheme.name}</strong>
							</text>
							<text fg={C.dim}>
								{selectedTheme.family} {"\u00b7"} {selectedTheme.appearance}
							</text>
							<box height={1} />

							<ThemeSwatches theme={selectedTheme} />
							<box height={1} />

							<text fg={C.text}>Primary accent</text>
							<text fg={selectedTheme.primary}>
								<strong>{selectedTheme.primary}</strong>
							</text>
							<box height={1} />

							<text fg={C.text}>Background / card</text>
							<text fg={selectedTheme.foreground}>
								<span fg={selectedTheme.background}>{"■■"}</span>{" "}
								{selectedTheme.background}{" "}
								<span fg={selectedTheme.card}>{"■■"}</span> {selectedTheme.card}
							</text>
							<box height={1} />

							<text fg={C.muted}>
								{"Persists to ~/.config/ccflare/theme.json"}
							</text>
						</>
					) : (
						<text fg={C.dim}>No theme selected.</text>
					)}
				</box>
			</box>
		</ModalFrame>
	);
}
