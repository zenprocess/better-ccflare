import {
	getDefaultTheme,
	getSiblingTheme,
	getThemeById,
	type ThemePalette,
} from "@ccflare/ui";
import type React from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";

interface ThemeContextType {
	themeId: string;
	setThemeId: (id: string) => void;
	resolvedTheme: ThemePalette;
	systemMode: boolean;
	setSystemMode: (v: boolean) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const STORAGE_KEY = "ccflare-theme";
const LEGACY_KEY = "theme";

interface StoredTheme {
	themeId: string;
	systemMode: boolean;
	appearance?: "dark" | "light";
}

function readStoredTheme(): StoredTheme {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) return JSON.parse(raw);

		// Migrate from legacy "theme" key
		const legacy = localStorage.getItem(LEGACY_KEY);
		if (legacy) {
			localStorage.removeItem(LEGACY_KEY);
			if (legacy === "system") {
				return { themeId: "ccflare-dark", systemMode: true };
			}
			return {
				themeId: legacy === "light" ? "ccflare-light" : "ccflare-dark",
				systemMode: false,
			};
		}
	} catch {
		// ignore
	}
	return { themeId: "ccflare-dark", systemMode: true };
}

function getSystemAppearance(): "dark" | "light" {
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
}

function applyThemeToDom(theme: ThemePalette): void {
	const root = document.documentElement;
	const s = root.style;

	s.setProperty("--background", theme.background);
	s.setProperty("--foreground", theme.foreground);
	s.setProperty("--card", theme.card);
	s.setProperty("--card-foreground", theme.cardForeground);
	s.setProperty("--popover", theme.popover);
	s.setProperty("--popover-foreground", theme.popoverForeground);
	s.setProperty("--primary", theme.primary);
	s.setProperty("--primary-foreground", theme.primaryForeground);
	s.setProperty("--secondary", theme.secondary);
	s.setProperty("--secondary-foreground", theme.secondaryForeground);
	s.setProperty("--muted", theme.muted);
	s.setProperty("--muted-foreground", theme.mutedForeground);
	s.setProperty("--accent", theme.accent);
	s.setProperty("--accent-foreground", theme.accentForeground);
	s.setProperty("--destructive", theme.destructive);
	s.setProperty("--destructive-foreground", theme.destructiveForeground);
	s.setProperty("--border", theme.border);
	s.setProperty("--input", theme.input);
	s.setProperty("--ring", theme.ring);
	s.setProperty("--success", theme.success);
	s.setProperty("--success-foreground", "#ffffff");
	s.setProperty("--warning", theme.warning);
	s.setProperty("--warning-foreground", "#ffffff");
	s.setProperty("--info", theme.info);
	s.setProperty("--info-foreground", "#ffffff");
	s.setProperty("--chart-1", theme.chart1);
	s.setProperty("--chart-2", theme.chart2);
	s.setProperty("--chart-3", theme.chart3);
	s.setProperty("--chart-4", theme.chart4);
	s.setProperty("--chart-5", theme.chart5);

	root.classList.remove("light", "dark");
	root.classList.add(theme.appearance);
}

function persist(
	themeId: string,
	systemMode: boolean,
	appearance: string,
): void {
	try {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({ themeId, systemMode, appearance }),
		);
	} catch {
		// ignore
	}
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
	const [stored] = useState(readStoredTheme);
	const [themeId, setThemeIdRaw] = useState(stored.themeId);
	const [systemMode, setSystemModeRaw] = useState(stored.systemMode);

	const resolvedTheme = useMemo(() => {
		const base = getThemeById(themeId) ?? getDefaultTheme("dark");
		if (!systemMode) return base;
		const appearance = getSystemAppearance();
		return getSiblingTheme(base, appearance) ?? base;
	}, [themeId, systemMode]);

	const setThemeId = useCallback((id: string) => {
		setThemeIdRaw(id);
	}, []);

	const setSystemMode = useCallback((v: boolean) => {
		setSystemModeRaw(v);
	}, []);

	// Apply theme to DOM
	useEffect(() => {
		applyThemeToDom(resolvedTheme);
		persist(themeId, systemMode, resolvedTheme.appearance);
	}, [resolvedTheme, themeId, systemMode]);

	// Listen for OS theme changes when in system mode
	useEffect(() => {
		if (!systemMode) return;
		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		const handleChange = () => {
			const appearance = mq.matches ? "dark" : "light";
			const base = getThemeById(themeId) ?? getDefaultTheme("dark");
			const theme = getSiblingTheme(base, appearance) ?? base;
			applyThemeToDom(theme);
			persist(themeId, systemMode, theme.appearance);
		};
		mq.addEventListener("change", handleChange);
		return () => mq.removeEventListener("change", handleChange);
	}, [systemMode, themeId]);

	const value = useMemo(
		() => ({ themeId, setThemeId, resolvedTheme, systemMode, setSystemMode }),
		[themeId, setThemeId, resolvedTheme, systemMode, setSystemMode],
	);

	return (
		<ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
	);
}

export function useTheme() {
	const context = useContext(ThemeContext);
	if (!context) {
		throw new Error("useTheme must be used within a ThemeProvider");
	}
	return context;
}
