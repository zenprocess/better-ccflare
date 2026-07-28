import { describe, expect, it } from "bun:test";
import { dirname, relative } from "node:path";
import {
	collectSourceFiles,
	extractImports,
	getWorkspaceManifests,
	REPO_ROOT,
} from "./test-helpers/workspace";

const BUILTIN_PACKAGES = new Set([
	"assert",
	"buffer",
	"bun",
	"child_process",
	"crypto",
	"events",
	"fs",
	"http",
	"https",
	"module",
	"net",
	"os",
	"path",
	"process",
	"querystring",
	"readline",
	"stream",
	"string_decoder",
	"timers",
	"tty",
	"url",
	"util",
	"vm",
	"worker_threads",
	"zlib",
]);
function extractPackageName(specifier: string): string | null {
	if (
		specifier.startsWith(".") ||
		specifier.startsWith("/") ||
		specifier.startsWith("bun:") ||
		specifier.startsWith("node:")
	) {
		return null;
	}

	if (specifier.startsWith("@")) {
		const [scope, name] = specifier.split("/");
		return scope && name ? `${scope}/${name}` : specifier;
	}

	return specifier.split("/")[0] ?? null;
}

describe("workspace manifests", () => {
	it("declare every bare package import used from source files", () => {
		const missingDependencies: string[] = [];

		for (const { manifestPath, manifest } of getWorkspaceManifests()) {
			const workspaceRoot = dirname(manifestPath);
			const declaredDependencies = new Set([
				...Object.keys(manifest.dependencies ?? {}),
				...Object.keys(manifest.devDependencies ?? {}),
				...Object.keys(manifest.peerDependencies ?? {}),
			]);

			for (const sourceFile of collectSourceFiles(workspaceRoot)) {
				for (const specifier of extractImports(sourceFile)) {
					const packageName = extractPackageName(specifier);
					if (
						!packageName ||
						packageName === manifest.name ||
						BUILTIN_PACKAGES.has(packageName)
					) {
						continue;
					}

					if (!declaredDependencies.has(packageName)) {
						missingDependencies.push(
							`${relative(REPO_ROOT, manifestPath)} is missing ${packageName} for ${relative(REPO_ROOT, sourceFile)}`,
						);
					}
				}
			}
		}

		expect(missingDependencies).toEqual([]);
	});
});
