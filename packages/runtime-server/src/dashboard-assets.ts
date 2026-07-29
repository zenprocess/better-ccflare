import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CACHE } from "@ccflare/core";

const DASHBOARD_MANIFEST_EXPORT = "@ccflare/web/manifest.json";
const DASHBOARD_DIST_DIR_ENV = "CF_DASHBOARD_DIST_DIR";
const DASHBOARD_MANIFEST_PATH_ENV = "CF_DASHBOARD_MANIFEST_PATH";

type DashboardAssetState = {
	manifest: Record<string, string>;
	distDir: string;
};

let dashboardAssets: DashboardAssetState | null = null;

function resolveConfiguredPath(configuredPath: string): string {
	return isAbsolute(configuredPath)
		? configuredPath
		: resolve(process.cwd(), configuredPath);
}

export function resolveDashboardManifestPath(): string {
	const configuredManifestPath =
		process.env[DASHBOARD_MANIFEST_PATH_ENV]?.trim();
	if (configuredManifestPath) {
		return resolveConfiguredPath(configuredManifestPath);
	}

	const configuredDistDir = process.env[DASHBOARD_DIST_DIR_ENV]?.trim();
	if (configuredDistDir) {
		return join(resolveConfiguredPath(configuredDistDir), "manifest.json");
	}

	return Bun.resolveSync(DASHBOARD_MANIFEST_EXPORT, process.cwd());
}

export function resetDashboardAssets(): void {
	dashboardAssets = null;
}

export function loadDashboardAssets(): DashboardAssetState {
	if (dashboardAssets) {
		return dashboardAssets;
	}

	const manifestPath = resolveDashboardManifestPath();
	dashboardAssets = {
		manifest: JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
			string,
			string
		>,
		distDir: dirname(manifestPath),
	};
	return dashboardAssets;
}

function resolveDashboardAsset(assetPath: string): string {
	return join(loadDashboardAssets().distDir, assetPath.replace(/^\//, ""));
}

function serveDashboardFile(
	assetPath: string,
	contentType?: string,
	cacheControl?: string,
): Response {
	const fullPath = resolveDashboardAsset(assetPath);

	if (!contentType) {
		if (assetPath.endsWith(".js")) contentType = "application/javascript";
		else if (assetPath.endsWith(".css")) contentType = "text/css";
		else if (assetPath.endsWith(".html")) contentType = "text/html";
		else if (assetPath.endsWith(".json")) contentType = "application/json";
		else if (assetPath.endsWith(".svg")) contentType = "image/svg+xml";
		else contentType = "text/plain";
	}

	return new Response(Bun.file(fullPath), {
		headers: {
			"Content-Type": contentType,
			"Cache-Control": cacheControl || CACHE.CACHE_CONTROL_NO_CACHE,
		},
	});
}

export function serveDashboardRoute(url: URL): Response | null {
	const { manifest } = loadDashboardAssets();

	if (manifest[url.pathname]) {
		return serveDashboardFile(
			url.pathname,
			undefined,
			CACHE.CACHE_CONTROL_STATIC,
		);
	}

	if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/v1")) {
		return serveDashboardFile("/index.html", "text/html");
	}

	return null;
}
