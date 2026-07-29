import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	loadDashboardAssets,
	resetDashboardAssets,
	resolveDashboardManifestPath,
} from "./dashboard-assets";

const DASHBOARD_DIST_DIR_ENV = "CF_DASHBOARD_DIST_DIR";
const DASHBOARD_MANIFEST_PATH_ENV = "CF_DASHBOARD_MANIFEST_PATH";
const originalDashboardDistDir = process.env[DASHBOARD_DIST_DIR_ENV];
const originalDashboardManifestPath = process.env[DASHBOARD_MANIFEST_PATH_ENV];

afterEach(async () => {
	resetDashboardAssets();

	if (originalDashboardDistDir === undefined) {
		delete process.env[DASHBOARD_DIST_DIR_ENV];
	} else {
		process.env[DASHBOARD_DIST_DIR_ENV] = originalDashboardDistDir;
	}

	if (originalDashboardManifestPath === undefined) {
		delete process.env[DASHBOARD_MANIFEST_PATH_ENV];
	} else {
		process.env[DASHBOARD_MANIFEST_PATH_ENV] = originalDashboardManifestPath;
	}
});

describe("dashboard asset path overrides", () => {
	it("prefers an explicit manifest path when configured", async () => {
		const tempDir = await mkdtemp(
			join(process.env.TMPDIR || "/tmp", "ccflare-dashboard-assets-"),
		);
		const manifestPath = join(tempDir, "manifest.json");

		try {
			await writeFile(
				manifestPath,
				JSON.stringify({ "/index.html": "/index.html" }),
			);
			process.env[DASHBOARD_MANIFEST_PATH_ENV] = manifestPath;

			expect(resolveDashboardManifestPath()).toBe(manifestPath);
			expect(loadDashboardAssets()).toEqual({
				manifest: { "/index.html": "/index.html" },
				distDir: tempDir,
			});
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("derives the manifest path from an explicit dashboard dist directory", async () => {
		const tempDir = await mkdtemp(
			join(process.env.TMPDIR || "/tmp", "ccflare-dashboard-dist-"),
		);
		const distDir = join(tempDir, "dashboard");
		const manifestPath = join(distDir, "manifest.json");

		try {
			await mkdir(distDir, { recursive: true });
			await writeFile(manifestPath, JSON.stringify({ "/app.js": "/app.js" }));
			process.env[DASHBOARD_DIST_DIR_ENV] = distDir;

			expect(resolveDashboardManifestPath()).toBe(manifestPath);
			expect(loadDashboardAssets()).toEqual({
				manifest: { "/app.js": "/app.js" },
				distDir,
			});
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});
