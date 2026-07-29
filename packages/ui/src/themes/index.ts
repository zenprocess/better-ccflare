import {
	catppuccinFrappe,
	catppuccinLatte,
	catppuccinMacchiato,
	catppuccinMocha,
} from "./catppuccin";
import { ccflareDark, ccflareLight } from "./ccflare";
import { dracula } from "./dracula";
import { gruvboxDark, gruvboxLight } from "./gruvbox";
import { nord, nordLight } from "./nord";
import { oneDark } from "./one-dark";
import { rosePine, rosePineDawn, rosePineMoon } from "./rose-pine";
import { solarizedDark, solarizedLight } from "./solarized";
import { tokyoNight } from "./tokyo-night";
import type { ThemePalette } from "./types";

export type { TuiColorMap } from "./tui-adapter";
export { themeToTuiColors } from "./tui-adapter";
export type { ThemePalette } from "./types";

export const THEME_REGISTRY: ThemePalette[] = [
	ccflareLight,
	ccflareDark,
	tokyoNight,
	catppuccinMocha,
	catppuccinMacchiato,
	catppuccinFrappe,
	catppuccinLatte,
	gruvboxDark,
	gruvboxLight,
	nord,
	nordLight,
	dracula,
	solarizedDark,
	solarizedLight,
	oneDark,
	rosePine,
	rosePineMoon,
	rosePineDawn,
];

export const THEME_FAMILIES = [...new Set(THEME_REGISTRY.map((t) => t.family))];

export function getThemeById(id: string): ThemePalette | undefined {
	return THEME_REGISTRY.find((t) => t.id === id);
}

export function getThemesByFamily(family: string): ThemePalette[] {
	return THEME_REGISTRY.filter((t) => t.family === family);
}

export function getDefaultTheme(appearance: "dark" | "light"): ThemePalette {
	return appearance === "dark" ? ccflareDark : ccflareLight;
}

/**
 * For a given theme, find the sibling variant in the same family
 * with the opposite appearance. Returns undefined if none exists.
 */
export function getSiblingTheme(
	theme: ThemePalette,
	appearance: "dark" | "light",
): ThemePalette | undefined {
	if (theme.appearance === appearance) return theme;
	return THEME_REGISTRY.find(
		(t) => t.family === theme.family && t.appearance === appearance,
	);
}

export {
	catppuccinFrappe,
	catppuccinLatte,
	catppuccinMacchiato,
	catppuccinMocha,
	ccflareDark,
	ccflareLight,
	dracula,
	gruvboxDark,
	gruvboxLight,
	nord,
	nordLight,
	oneDark,
	rosePine,
	rosePineDawn,
	rosePineMoon,
	solarizedDark,
	solarizedLight,
	tokyoNight,
};
