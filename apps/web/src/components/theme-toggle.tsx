import {
	getThemesByFamily,
	THEME_FAMILIES,
	type ThemePalette,
} from "@ccflare/ui";
import { Check, Monitor, Palette } from "lucide-react";
import { useTheme } from "../contexts/theme-context";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Switch } from "./ui/switch";

function ThemeSwatch({ theme }: { theme: ThemePalette }) {
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
		<div className="flex gap-0.5">
			{keyedColors.map(({ color, key }) => (
				<div
					key={key}
					className="w-3 h-3 rounded-full border border-foreground/10"
					style={{ backgroundColor: color }}
				/>
			))}
		</div>
	);
}

function ThemeItem({
	theme,
	isActive,
	onSelect,
}: {
	theme: ThemePalette;
	isActive: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-sm transition-colors ${
				isActive
					? "bg-primary/10 text-primary"
					: "hover:bg-muted text-foreground"
			}`}
		>
			<div className="flex items-center gap-2 min-w-0">
				<ThemeSwatch theme={theme} />
				<span className="truncate">{theme.name}</span>
				<span className="text-[10px] text-muted-foreground">
					{theme.appearance}
				</span>
			</div>
			{isActive && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
		</button>
	);
}

export function ThemeToggle() {
	const { themeId, setThemeId, systemMode, setSystemMode } = useTheme();

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button variant="ghost" size="sm" className="w-9 px-0">
					<Palette className="h-[1.2rem] w-[1.2rem]" />
					<span className="sr-only">Change theme</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				className="w-64 max-h-[70vh] overflow-y-auto p-2"
			>
				{/* System mode toggle */}
				<div className="flex items-center justify-between px-2 py-1.5 mb-1">
					<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
						<Monitor className="h-3.5 w-3.5" />
						<span>Auto (system)</span>
					</div>
					<Switch
						checked={systemMode}
						onCheckedChange={setSystemMode}
						className="scale-75"
					/>
				</div>
				<div className="h-px bg-border mb-1" />

				{/* Theme families */}
				{THEME_FAMILIES.map((family) => {
					const themes = getThemesByFamily(family);
					return (
						<div key={family} className="mb-1">
							<div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
								{family}
							</div>
							{themes.map((theme) => (
								<ThemeItem
									key={theme.id}
									theme={theme}
									isActive={themeId === theme.id}
									onSelect={() => setThemeId(theme.id)}
								/>
							))}
						</div>
					);
				})}
			</PopoverContent>
		</Popover>
	);
}
