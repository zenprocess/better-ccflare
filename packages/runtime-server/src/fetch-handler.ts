import type { APIRouter } from "@ccflare/api";
import { HTTP_STATUS } from "@ccflare/core";
import { errorResponse } from "@ccflare/http";
import {
	handleCompatibilityProxy,
	handleProxy,
	handleWebSocketUpgradeRequest,
	isWebSocketUpgradeRequest,
	type ProxyContext,
	type WebSocketProxyData,
} from "@ccflare/proxy";
import { serveDashboardRoute } from "./dashboard-assets";

type ServerFetchHandlerDependencies = {
	apiRouter: Pick<APIRouter, "handleRequest">;
	proxyContext: ProxyContext;
	withDashboard: boolean;
	handleProxyRequest?: typeof handleProxy;
	handleCompatibilityRequest?: typeof handleCompatibilityProxy;
	handleWebSocketUpgrade?: typeof handleWebSocketUpgradeRequest;
	serveDashboardAsset?: (url: URL) => Response | null;
};

export function createServerFetchHandler({
	apiRouter,
	proxyContext,
	withDashboard,
	handleProxyRequest = handleProxy,
	handleCompatibilityRequest = handleCompatibilityProxy,
	handleWebSocketUpgrade = handleWebSocketUpgradeRequest,
	serveDashboardAsset = serveDashboardRoute,
}: ServerFetchHandlerDependencies) {
	return async (
		req: Request,
		server?: Bun.Server<WebSocketProxyData>,
	): Promise<Response | undefined> => {
		const url = new URL(req.url);

		const apiResponse = await apiRouter.handleRequest(url, req);
		if (apiResponse) {
			return apiResponse;
		}

		if (url.pathname.startsWith("/v1/ccflare/")) {
			const compatibilityResponse = await handleCompatibilityRequest(
				req,
				url,
				proxyContext,
			);
			if (compatibilityResponse) {
				return compatibilityResponse;
			}
		}

		if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
			if (server) {
				const websocketResponse = await handleWebSocketUpgrade(
					req,
					url,
					proxyContext,
					server,
				);
				if (websocketResponse) {
					return websocketResponse;
				}
				if (isWebSocketUpgradeRequest(req)) {
					return;
				}
			}

			try {
				return await handleProxyRequest(req, url, proxyContext);
			} catch (error) {
				return errorResponse(error);
			}
		}

		if (withDashboard && (req.method === "GET" || req.method === "HEAD")) {
			const dashboardResponse = serveDashboardAsset(url);
			if (dashboardResponse) {
				return dashboardResponse;
			}
		}

		return new Response("Not Found", { status: HTTP_STATUS.NOT_FOUND });
	};
}
