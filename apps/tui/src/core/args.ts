import { parseArgs as nodeParseArgs } from "node:util";
import {
	ACCOUNT_PROVIDERS,
	type AccountProvider,
	isAccountProvider,
} from "@ccflare/types";

const supportedProviders = ACCOUNT_PROVIDERS.join(", ");

export interface ParsedArgs {
	help?: boolean;
	serve?: boolean;
	port?: number;
	logs?: boolean | number;
	stats?: boolean;
	addAccount?: string;
	provider?: AccountProvider;
	list?: boolean;
	remove?: string;
	pause?: string;
	resume?: string;
	analyze?: boolean;
	resetStats?: boolean;
	clearHistory?: boolean;
	theme?: string;
}

export function parseArgs(args: string[]): ParsedArgs {
	const { values } = nodeParseArgs({
		args,
		options: {
			help: { type: "boolean", short: "h" },
			serve: { type: "boolean" },
			port: { type: "string" },
			logs: { type: "string" },
			stats: { type: "boolean" },
			"add-account": { type: "string" },
			provider: { type: "string" },
			list: { type: "boolean" },
			remove: { type: "string" },
			pause: { type: "string" },
			resume: { type: "string" },
			analyze: { type: "boolean" },
			"reset-stats": { type: "boolean" },
			"clear-history": { type: "boolean" },
			theme: { type: "string" },
		},
		allowPositionals: true,
	});

	const result: ParsedArgs = {};

	if (values.help) result.help = true;
	if (values.serve) result.serve = true;
	if (values.port) result.port = Number.parseInt(values.port, 10);
	if (values.logs !== undefined) {
		result.logs = values.logs ? Number.parseInt(values.logs, 10) : true;
	}
	if (values.stats) result.stats = true;
	if (values["add-account"]) result.addAccount = values["add-account"];
	if (values.provider) {
		if (!isAccountProvider(values.provider)) {
			throw new Error(
				`Invalid provider '${values.provider}'. Expected one of: ${supportedProviders}.`,
			);
		}
		result.provider = values.provider;
	}
	if (values.list) result.list = true;
	if (values.remove) result.remove = values.remove;
	if (values.pause) result.pause = values.pause;
	if (values.resume) result.resume = values.resume;
	if (values.analyze) result.analyze = true;
	if (values["reset-stats"]) result.resetStats = true;
	if (values["clear-history"]) result.clearHistory = true;
	if (values.theme) result.theme = values.theme;

	return result;
}
