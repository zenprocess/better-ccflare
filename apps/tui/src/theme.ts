import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	getDefaultTheme,
	getThemeById,
	THEME_REGISTRY,
	type TuiColorMap,
	themeToTuiColors,
} from "@ccflare/ui";

const CONFIG_DIR = join(homedir(), ".config", "ccflare");
const CONFIG_FILE = join(CONFIG_DIR, "theme.json");

function loadPersistedThemeId(): string {
	try {
		if (existsSync(CONFIG_FILE)) {
			const data = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
			if (data?.themeId && getThemeById(data.themeId)) {
				return data.themeId;
			}
		}
	} catch {
		// ignore
	}
	return "ccflare-dark";
}

function persistThemeId(themeId: string): void {
	try {
		if (!existsSync(CONFIG_DIR)) {
			mkdirSync(CONFIG_DIR, { recursive: true });
		}
		writeFileSync(CONFIG_FILE, JSON.stringify({ themeId }), "utf-8");
	} catch {
		// ignore
	}
}

let currentThemeId = loadPersistedThemeId();
let currentColors: TuiColorMap = themeToTuiColors(
	getThemeById(currentThemeId) ?? getDefaultTheme("dark"),
);

export function setTuiTheme(themeId: string): void {
	const theme = getThemeById(themeId);
	if (theme) {
		currentThemeId = themeId;
		currentColors = themeToTuiColors(theme);
		persistThemeId(themeId);
	}
}

export function getCurrentThemeId(): string {
	return currentThemeId;
}

export function getAvailableThemes() {
	return THEME_REGISTRY.map((t) => ({
		id: t.id,
		name: t.name,
		family: t.family,
		appearance: t.appearance,
	}));
}

/**
 * Proxy-based reactive color object.
 * All existing `C.accent`, `C.bg`, etc. references continue to work
 * and will return the current theme's color values.
 */
export const C: TuiColorMap = new Proxy({} as TuiColorMap, {
	get(_target, prop: string) {
		return (currentColors as unknown as Record<string, string>)[prop];
	},
	ownKeys() {
		return Object.keys(currentColors);
	},
	getOwnPropertyDescriptor(_target, prop: string) {
		if (prop in currentColors) {
			return {
				configurable: true,
				enumerable: true,
				value: (currentColors as unknown as Record<string, string>)[prop],
			};
		}
		return undefined;
	},
});

export const NAV_ITEMS = [
	{ name: "Overview", value: "overview", icon: "◫", key: "1" },
	{ name: "Analytics", value: "analytics", icon: "◰", key: "2" },
	{ name: "Requests", value: "requests", icon: "⇄", key: "3" },
	{ name: "Accounts", value: "accounts", icon: "⊕", key: "4" },
	{ name: "Logs", value: "logs", icon: "≡", key: "5" },
] as const;

export type Screen = (typeof NAV_ITEMS)[number]["value"];

export const SCREEN_TITLES: Record<Screen, string> = {
	overview: "Dashboard Overview",
	analytics: "Analytics",
	requests: "Request History",
	accounts: "Account Management",
	logs: "System Logs",
};
