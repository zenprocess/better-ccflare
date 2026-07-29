import {
	createWriteStream,
	existsSync,
	mkdirSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BUFFER_SIZES,
	type Disposable,
	LIMITS,
	registerDisposable,
} from "@ccflare/core";
import type { LogEvent } from "@ccflare/types";

function writeToStderr(message: string, error: unknown): void {
	if (typeof process === "undefined") {
		return;
	}

	const formattedError =
		error instanceof Error ? (error.stack ?? error.message) : String(error);
	process.stderr?.write?.(`${message}: ${formattedError}\n`);
}

export class LogFileWriter implements Disposable {
	private logDir: string;
	private logFile: string;
	private stream: ReturnType<typeof createWriteStream> | null = null;
	private maxFileSize = BUFFER_SIZES.LOG_FILE_MAX_SIZE;

	constructor() {
		// Create log directory in tmp folder
		this.logDir = join(tmpdir(), "ccflare-logs");
		if (!existsSync(this.logDir)) {
			mkdirSync(this.logDir, { recursive: true });
		}

		this.logFile = join(this.logDir, "app.log");
		this.initStream();
	}

	private initStream(): void {
		// Check if we need to rotate
		if (existsSync(this.logFile)) {
			const stats = statSync(this.logFile);
			if (stats.size > this.maxFileSize) {
				this.rotateLog();
			}
		}

		// Create write stream with append mode
		this.stream = createWriteStream(this.logFile, { flags: "a" });
	}

	private rotateLog(): void {
		if (this.stream) {
			this.stream.end();
		}

		if (existsSync(this.logFile)) {
			try {
				unlinkSync(this.logFile);
			} catch (_e) {
				writeToStderr("Failed to rotate log", _e);
			}
		}
	}

	write(event: LogEvent): void {
		if (!this.stream || this.stream.destroyed) {
			this.initStream();
		}

		const line = `${JSON.stringify(event)}\n`;
		if (this.stream) {
			this.stream.write(line);
		}
	}

	async readLogs(limit: number = LIMITS.LOG_READ_DEFAULT): Promise<LogEvent[]> {
		if (!existsSync(this.logFile)) {
			return [];
		}

		try {
			const content = await Bun.file(this.logFile).text();
			const lines = content.trim().split("\n").filter(Boolean);

			// Return the last N logs
			return lines
				.slice(-limit)
				.map((line) => {
					try {
						return JSON.parse(line);
					} catch {
						return null;
					}
				})
				.filter((log): log is LogEvent => log !== null);
		} catch (_e) {
			writeToStderr("Failed to read logs", _e);
			return [];
		}
	}

	close(): void {
		if (this.stream) {
			this.stream.end();
			this.stream = null;
		}
	}

	dispose(): void {
		this.close();
	}
}

// Singleton instance
export const logFileWriter = new LogFileWriter();

// Register with lifecycle manager
registerDisposable(logFileWriter);
