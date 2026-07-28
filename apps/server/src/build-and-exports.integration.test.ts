import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../../..");
const PACKAGES_ROOT = join(REPO_ROOT, "packages");
const APPS_ROOT = join(REPO_ROOT, "apps");

type PackageManifest = {
	name: string;
	exports?: Record<string, string>;
	scripts?: Record<string, string>;
};

function readJsonFile<T>(filePath: string): T {
	return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function getPackageManifests(): PackageManifest[] {
	return readdirSync(PACKAGES_ROOT, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) =>
			readJsonFile<PackageManifest>(
				join(PACKAGES_ROOT, entry.name, "package.json"),
			),
		);
}

describe("workspace build and export contracts", () => {
	it("declares an exports field for every package under packages/", () => {
		const missingExports = getPackageManifests()
			.filter((manifest) => !manifest.exports)
			.map((manifest) => manifest.name)
			.sort();

		expect(missingExports).toEqual([]);
	});

	it("exposes the dashboard manifest through a declared package export", () => {
		const manifest = readJsonFile<PackageManifest>(
			join(APPS_ROOT, "web", "package.json"),
		);

		expect(manifest.exports).toMatchObject({
			".": "./src/index.ts",
			"./manifest.json": "./dist/manifest.json",
		});
	});

	it("uses the dashboard HTML shell as the single dev entrypoint", () => {
		const rootManifest = readJsonFile<PackageManifest>(
			join(REPO_ROOT, "package.json"),
		);
		const dashboardManifest = readJsonFile<PackageManifest>(
			join(APPS_ROOT, "web", "package.json"),
		);

		expect(rootManifest.scripts?.["dev:dashboard"]).toBe(
			"bun run --cwd apps/web dev",
		);
		expect(dashboardManifest.scripts?.dev).toBe("bun --hot src/index.html");
	});

	it("keeps bun run build working while exposing a scoped build name", () => {
		const rootManifest = readJsonFile<PackageManifest>(
			join(REPO_ROOT, "package.json"),
		);

		expect(rootManifest.scripts?.["build:clients"]).toBe(
			"bun run build:dashboard && bun run build:tui",
		);
		expect(rootManifest.scripts?.build).toBe("bun run build:clients");
	});

	it("imports dashboard assets through package exports instead of dist internals", () => {
		const runtimeServerSrc = join(PACKAGES_ROOT, "runtime-server", "src");
		const runtimeServerSource = readdirSync(runtimeServerSrc)
			.filter((file) => file.endsWith(".ts"))
			.map((file) => readFileSync(join(runtimeServerSrc, file), "utf8"))
			.join("\n");

		expect(runtimeServerSource).toContain("@ccflare/web/manifest.json");
		expect(runtimeServerSource).not.toContain(
			"@ccflare/web/dist/manifest.json",
		);
		expect(runtimeServerSource).not.toContain("@ccflare/web/dist");
		expect(runtimeServerSource).not.toContain("apps/web/dist");
	});
});
