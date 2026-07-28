import type { Config } from "@ccflare/config";
import type { DatabaseOperations } from "@ccflare/database";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@ccflare/http";
import { Logger } from "@ccflare/logger";
import {
	type HealthResponse,
	isAccountProvider,
	type RuntimeHealth,
} from "@ccflare/types";

const log = new Logger("HealthHandler");

/**
 * Create a health check handler
 */
export function createHealthHandler(
	dbOps: DatabaseOperations,
	config: Config,
	getProviders: () => string[],
	getRuntimeHealth?: () => RuntimeHealth,
) {
	return (): Response => {
		try {
			const response: HealthResponse = {
				status: "ok",
				accounts: dbOps.countAccounts(),
				timestamp: new Date().toISOString(),
				strategy: config.getStrategy(),
				providers: getProviders().filter(isAccountProvider),
				runtime: getRuntimeHealth?.(),
			};

			return jsonResponse(response);
		} catch (error) {
			log.error("Failed to compute health response", error);
			return errorResponse(
				InternalServerError("Failed to compute health response"),
			);
		}
	};
}
