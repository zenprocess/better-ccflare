import {
	type Request,
	type RequestPayload,
	type RequestSummary,
	toRequestSummary,
} from "@ccflare/types";

type RequestWithAccountName = Request & {
	accountName?: string | null;
};

export function serializeRequestResponse(
	request: RequestWithAccountName,
): RequestSummary {
	return {
		...toRequestSummary(request),
		accountName: request.accountName ?? null,
	};
}

export function enrichRequestPayload(
	payload: RequestPayload,
	accountName: string | null = null,
): RequestPayload {
	return {
		...payload,
		meta: {
			...payload.meta,
			account: {
				...payload.meta.account,
				name: accountName ?? payload.meta.account.name ?? null,
			},
		},
	};
}
