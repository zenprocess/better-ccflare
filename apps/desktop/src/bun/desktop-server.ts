import { existsSync } from "node:fs";
import { join } from "node:path";

const SERVER_READY_PREFIX = "CCFLARE_DESKTOP_SERVER_READY ";
const DEFAULT_SERVER_START_TIMEOUT_MS = 15_000;

export type StartedDesktopServer = {
	port: number;
	process: Bun.Subprocess;
};

function resolveDesktopRuntimeDir(): string {
	const packagedRuntimeDir = join(import.meta.dir, "..", "desktop-runtime");
	if (existsSync(packagedRuntimeDir)) {
		return packagedRuntimeDir;
	}

	const localRuntimeDir = join(import.meta.dir, "..", "..", ".desktop-runtime");
	if (existsSync(localRuntimeDir)) {
		return localRuntimeDir;
	}

	throw new Error(
		"Desktop runtime bundle is missing. Run `bun run src/build-runtime.ts` in apps/desktop first.",
	);
}

async function readLines(
	stream: ReadableStream<Uint8Array> | null,
	onLine: (line: string) => void,
): Promise<void> {
	if (!stream) {
		return;
	}

	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });

			while (true) {
				const newlineIndex = buffer.indexOf("\n");
				if (newlineIndex === -1) {
					break;
				}

				const line = buffer.slice(0, newlineIndex).trimEnd();
				buffer = buffer.slice(newlineIndex + 1);
				onLine(line);
			}
		}

		buffer += decoder.decode();
		const trailingLine = buffer.trim();
		if (trailingLine.length > 0) {
			onLine(trailingLine);
		}
	} finally {
		reader.releaseLock();
	}
}

function getServerStartTimeoutMs(): number {
	const configuredTimeout = Number(
		process.env.CCFLARE_DESKTOP_SERVER_START_TIMEOUT_MS ||
			DEFAULT_SERVER_START_TIMEOUT_MS,
	);

	return Number.isFinite(configuredTimeout) && configuredTimeout > 0
		? configuredTimeout
		: DEFAULT_SERVER_START_TIMEOUT_MS;
}

export async function startDesktopServer(): Promise<StartedDesktopServer> {
	const runtimeDir = resolveDesktopRuntimeDir();
	const serverEntrypoint = join(runtimeDir, "server.js");
	const subprocess = Bun.spawn([process.execPath, serverEntrypoint], {
		cwd: runtimeDir,
		env: {
			...process.env,
			CCFLARE_DESKTOP_PORT: "0",
		},
		stdout: "pipe",
		stderr: "pipe",
	});

	let resolvePort: ((port: number) => void) | null = null;
	let rejectPort: ((error: Error) => void) | null = null;

	const ready = new Promise<number>((resolve, reject) => {
		resolvePort = resolve;
		rejectPort = reject;
	});

	const failStartup = (error: Error): void => {
		if (!rejectPort) {
			return;
		}

		const activeReject = rejectPort;
		resolvePort = null;
		rejectPort = null;

		try {
			subprocess.kill("SIGTERM");
		} catch {}

		activeReject(error);
	};

	void readLines(subprocess.stdout, (line) => {
		if (line.length === 0) {
			return;
		}

		if (line.startsWith(SERVER_READY_PREFIX)) {
			const port = Number(line.slice(SERVER_READY_PREFIX.length));
			if (Number.isInteger(port) && port > 0) {
				resolvePort?.(port);
				resolvePort = null;
				rejectPort = null;
				return;
			}
		}

		console.log(`[ccflare-server] ${line}`);
	}).catch((error) => {
		failStartup(
			error instanceof Error
				? error
				: new Error(`Failed to read server stdout: ${String(error)}`),
		);
	});

	void readLines(subprocess.stderr, (line) => {
		if (line.length > 0) {
			console.error(`[ccflare-server] ${line}`);
		}
	}).catch((error) => {
		console.error("[ccflare-server] Failed to read server stderr", error);
	});

	const exitBeforeReady = subprocess.exited.then((code) => {
		throw new Error(`Desktop server exited before ready (code ${code})`);
	});
	const startupTimeout = Bun.sleep(getServerStartTimeoutMs()).then(() => {
		failStartup(
			new Error(
				"Desktop server did not become ready before the startup timeout elapsed",
			),
		);
		throw new Error(
			"Desktop server did not become ready before the startup timeout elapsed",
		);
	});

	const port = await Promise.race([ready, exitBeforeReady, startupTimeout]);
	return {
		port,
		process: subprocess,
	};
}

export async function stopDesktopServer(
	activeProcess: Bun.Subprocess | null,
): Promise<void> {
	if (!activeProcess) {
		return;
	}

	try {
		activeProcess.kill("SIGTERM");
	} catch {}

	const exited = activeProcess.exited.catch(() => undefined);
	const timeout = Bun.sleep(1_000).then(() => {
		try {
			activeProcess.kill("SIGKILL");
		} catch {}
	});

	await Promise.race([exited, timeout]);
	await exited;
}
