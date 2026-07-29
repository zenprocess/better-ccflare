import type { DatabaseOperations } from "@ccflare/database";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
	NotFound,
} from "@ccflare/http";
import { Logger } from "@ccflare/logger";
import { parseRequestPayload } from "@ccflare/types";
import {
	enrichRequestPayload,
	serializeRequestResponse,
} from "../serializers/request";

const log = new Logger("RequestsHandler");

function parsePayloadRows(
	rows: Array<{ id: string; json: string; account_name: string | null }>,
) {
	return rows.flatMap((r) => {
		try {
			const data = parseRequestPayload({
				id: r.id,
				...JSON.parse(r.json),
			});
			if (!data) {
				log.warn(`Skipping malformed request payload ${r.id}`);
				return [];
			}

			return [
				enrichRequestPayload(
					data.id === r.id ? data : { ...data, id: r.id },
					r.account_name ?? null,
				),
			];
		} catch {
			log.warn(`Skipping unparsable request payload ${r.id}`);
			return [];
		}
	});
}

/**
 * Create a requests summary handler (existing functionality)
 */
export function createRequestsSummaryHandler(dbOps: DatabaseOperations) {
	return (limit: number = 50): Response => {
		try {
			return jsonResponse(
				dbOps.listRequestsWithAccountNames(limit).map(serializeRequestResponse),
			);
		} catch (error) {
			log.error("Failed to load request summaries", error);
			return errorResponse(
				InternalServerError("Failed to load request summaries"),
			);
		}
	};
}

/**
 * Create a detailed requests handler with full payload data
 */
export function createRequestsDetailHandler(dbOps: DatabaseOperations) {
	return (limit = 100): Response => {
		try {
			return jsonResponse(
				parsePayloadRows(dbOps.listRequestPayloadsWithAccountNames(limit)),
			);
		} catch (error) {
			log.error("Failed to load request details", error);
			return errorResponse(
				InternalServerError("Failed to load request details"),
			);
		}
	};
}

export function createRequestsConversationHandler(dbOps: DatabaseOperations) {
	return (requestId: string): Response => {
		try {
			const rows = dbOps.listResponseChainPayloadsWithAccountNames(requestId);
			if (rows.length === 0) {
				return errorResponse(NotFound("Request conversation not found"));
			}

			return jsonResponse(parsePayloadRows(rows));
		} catch (error) {
			log.error("Failed to load request conversation", error);
			return errorResponse(
				InternalServerError("Failed to load request conversation"),
			);
		}
	};
}
