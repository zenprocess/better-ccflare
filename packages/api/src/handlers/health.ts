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
 * Build-time provenance for the /health response. Populated from env vars
 * injected by the Dockerfile at build time:
 *   - CCFLARE_VERSION: optional override; normally reads from
 *     `npm_package_version` which is set automatically by `bun run` /
 *     npm scripts.
 *   - CCFLARE_GIT_SHA: full 40-char commit SHA the image was built from.
 *   - CCFLARE_GIT_REF: branch / tag name (e.g. "main", "deploy/2026-07-30").
 *   - CCFLARE_BUILD_DATE: RFC 3339 timestamp the image was built.
 *
 * Each field reports "unknown" when unset so the shape is stable and the
 * canary can detect "field present but empty" vs "field missing" without
 * guessing. The canary expects this four-tuple and uses it to compare
 * against the deploy branch HEAD.
 */
function readBuildProvenance(): {
	version: string;
	git_sha: string;
	git_ref: string;
	build_date: string;
} {
	return {
		version:
			process.env.CCFLARE_VERSION ??
			process.env.BETTER_CCFLARE_VERSION ??
			process.env.npm_package_version ??
			"unknown",
		git_sha: process.env.CCFLARE_GIT_SHA ?? "unknown",
		git_ref: process.env.CCFLARE_GIT_REF ?? "unknown",
		build_date: process.env.CCFLARE_BUILD_DATE ?? "unknown",
	};
}

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
				...readBuildProvenance(),
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
