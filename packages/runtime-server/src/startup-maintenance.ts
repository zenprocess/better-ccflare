import type { Config } from "@ccflare/config";
import type { DatabaseOperations } from "@ccflare/database";
import { Logger } from "@ccflare/logger";

export function runStartupMaintenance(
	config: Config,
	dbOps: DatabaseOperations,
): () => void {
	const log = new Logger("StartupMaintenance");

	try {
		const payloadDays = config.getDataRetentionDays();
		const requestDays = config.getRequestRetentionDays();
		const { removedRequests, removedPayloads } = dbOps.cleanupOldRequests(
			payloadDays * 24 * 60 * 60 * 1000,
			requestDays * 24 * 60 * 60 * 1000,
		);
		log.info(
			`Startup cleanup removed ${removedRequests} requests and ${removedPayloads} payloads (payload=${payloadDays}d, requests=${requestDays}d)`,
		);
	} catch (err) {
		log.error(`Startup cleanup error: ${err}`);
	}

	try {
		dbOps.compact();
		log.info("Database compacted at startup");
	} catch (err) {
		log.error(`Database compaction error: ${err}`);
	}

	return () => {};
}
