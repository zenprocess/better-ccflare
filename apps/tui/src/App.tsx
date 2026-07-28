import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { createContext, useContext, useState } from "react";
import { AccountsScreen } from "./components/AccountsScreen.tsx";
import { AnalyticsScreen } from "./components/AnalyticsScreen.tsx";
import { LogsScreen } from "./components/LogsScreen.tsx";
import { OverviewScreen } from "./components/OverviewScreen.tsx";
import { RequestsScreen } from "./components/RequestsScreen.tsx";
import { ThemePicker } from "./components/ThemePicker.tsx";
import { C, NAV_ITEMS, SCREEN_TITLES, type Screen } from "./theme.ts";

// Context for child screens to signal input mode (blocks global shortcuts)
interface AppContextValue {
	inputActive: boolean;
	setInputActive: (v: boolean) => void;
}
const AppContext = createContext<AppContextValue>({
	inputActive: false,
	setInputActive: () => {},
});
export const useAppContext = () => useContext(AppContext);

const SCREENS: Screen[] = NAV_ITEMS.map((item) => item.value);

interface AppProps {
	port: number;
	onQuit: () => Promise<void>;
}

export function App({ port, onQuit }: AppProps) {
	const { width } = useTerminalDimensions();
	const [screen, setScreen] = useState<Screen>("overview");
	const [inputActive, setInputActive] = useState(false);
	const [refreshKey, setRefreshKey] = useState(0);
	const [showThemePicker, setShowThemePicker] = useState(false);

	const triggerRefresh = () => setRefreshKey((k) => k + 1);

	// Global keyboard shortcuts
	// Tab/Shift+Tab for screen navigation (no number key conflicts)
	// Ctrl+t for theme (no bare 't' conflict with analytics)
	useKeyboard((key) => {
		// Theme picker is modal — blocks all global shortcuts
		if (showThemePicker) return;

		// When an input component is focused, only allow force-quit
		if (inputActive) {
			if (key.ctrl && key.name === "c") onQuit();
			return;
		}

		// Quit
		if (key.name === "q") {
			onQuit();
			return;
		}
		if (key.ctrl && key.name === "c") {
			onQuit();
			return;
		}

		// Refresh
		if (key.name === "r") {
			triggerRefresh();
			return;
		}

		// Screen navigation: Tab / Shift+Tab
		if (key.name === "tab" && !key.shift) {
			const idx = SCREENS.indexOf(screen);
			setScreen(SCREENS[(idx + 1) % SCREENS.length]);
			return;
		}
		if (key.name === "tab" && key.shift) {
			const idx = SCREENS.indexOf(screen);
			setScreen(SCREENS[(idx - 1 + SCREENS.length) % SCREENS.length]);
			return;
		}

		// Theme picker: Ctrl+t
		if (key.ctrl && key.name === "t") {
			setShowThemePicker(true);
			return;
		}
	});

	const sidebarWidth = width > 100 ? 22 : 18;
	const showSidebar = width > 50;

	const renderScreen = () => {
		switch (screen) {
			case "overview":
				return <OverviewScreen refreshKey={refreshKey} port={port} />;
			case "analytics":
				return <AnalyticsScreen refreshKey={refreshKey} />;
			case "requests":
				return <RequestsScreen refreshKey={refreshKey} />;
			case "accounts":
				return <AccountsScreen refreshKey={refreshKey} />;
			case "logs":
				return <LogsScreen refreshKey={refreshKey} />;
		}
	};

	return (
		<AppContext.Provider value={{ inputActive, setInputActive }}>
			<box
				flexDirection="column"
				width="100%"
				height="100%"
				backgroundColor={C.bg}
			>
				{/* Header */}
				<box
					height={3}
					paddingX={2}
					flexDirection="row"
					justifyContent="space-between"
					alignItems="center"
					border
					borderStyle="rounded"
					borderColor={C.border}
				>
					<text fg={C.accent}>
						<strong>{"◆ ccflare"}</strong>
					</text>
					<text fg={C.dim}>
						<span fg={C.success}>{"●"}</span> :{port.toString()}
					</text>
				</box>

				{/* Body: Sidebar + Content */}
				<box flexDirection="row" flexGrow={1}>
					{/* Sidebar */}
					{showSidebar && (
						<box
							width={sidebarWidth}
							flexDirection="column"
							paddingY={1}
							border
							borderStyle="rounded"
							borderColor={C.border}
						>
							{NAV_ITEMS.map((item) => {
								const active = item.value === screen;
								return (
									<box
										key={item.value}
										paddingX={1}
										backgroundColor={active ? C.surface : undefined}
									>
										<text fg={active ? C.accent : C.dim}>
											{active ? (
												<strong>
													{"▸ "}
													{item.icon} {item.name}
												</strong>
											) : (
												<>
													{"  "}
													{item.icon} {item.name}
												</>
											)}
										</text>
									</box>
								);
							})}

							{/* Spacer */}
							<box flexGrow={1} />

							{/* Sidebar footer */}
							<box paddingX={1} paddingTop={1}>
								<text fg={C.muted}>
									{"Tab  navigate\n^t   theme\nr    refresh\nq    quit"}
								</text>
							</box>
						</box>
					)}

					{/* Content area */}
					<box
						flexGrow={1}
						flexDirection="column"
						border
						borderStyle="rounded"
						borderColor={C.border}
						title={` ${SCREEN_TITLES[screen]} `}
						titleAlignment="left"
					>
						{renderScreen()}
					</box>
				</box>

				{/* Status bar */}
				<box height={1} paddingX={2} flexDirection="row" gap={2}>
					<text fg={C.muted}>
						<span fg={C.dim}>Tab</span> navigate <span fg={C.dim}>^t</span>{" "}
						theme <span fg={C.dim}>r</span> refresh <span fg={C.dim}>q</span>{" "}
						quit
					</text>
				</box>

				{/* Theme picker overlay — absolute positioned over everything */}
				{showThemePicker && (
					<ThemePicker onClose={() => setShowThemePicker(false)} />
				)}
			</box>
		</AppContext.Provider>
	);
}
