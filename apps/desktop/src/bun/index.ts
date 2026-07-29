import { ApplicationMenu, BrowserWindow } from "electrobun/bun";
import { startDesktopServer, stopDesktopServer } from "./desktop-server";

let serverProcess: Bun.Subprocess | null = null;

async function stopDesktopServerProcess(): Promise<void> {
	const activeProcess = serverProcess;
	serverProcess = null;
	await stopDesktopServer(activeProcess);
}

ApplicationMenu.setApplicationMenu([
	{
		submenu: [
			{ label: "About ccflare", role: "about" },
			{ type: "separator" },
			{ label: "Quit ccflare", role: "quit", accelerator: "q" },
		],
	},
	{
		label: "Edit",
		submenu: [
			{ role: "undo" },
			{ role: "redo" },
			{ type: "separator" },
			{ role: "cut" },
			{ role: "copy" },
			{ role: "paste" },
			{ role: "selectAll" },
		],
	},
	{
		label: "Window",
		submenu: [
			{ role: "minimize" },
			{ role: "zoom" },
			{ role: "close" },
			{ type: "separator" },
			{ role: "bringAllToFront" },
		],
	},
]);

const { port, process: desktopServerProcess } = await startDesktopServer();
serverProcess = desktopServerProcess;

process.on("beforeExit", () => {
	void stopDesktopServerProcess();
});

process.on("exit", () => {
	try {
		serverProcess?.kill("SIGTERM");
	} catch {}
});

process.on("SIGINT", () => {
	void stopDesktopServerProcess();
});

process.on("SIGTERM", () => {
	void stopDesktopServerProcess();
});

new BrowserWindow({
	title: "ccflare",
	url: `http://localhost:${port}`,
	titleBarStyle: "hiddenInset",
	frame: {
		width: 1200,
		height: 800,
		x: 100,
		y: 100,
	},
});
