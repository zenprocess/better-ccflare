import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const REPO_ROOT = join(import.meta.dir, "../../../..");
export const WORKSPACE_ROOTS = ["apps", "packages"] as const;
export const SOURCE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mts",
	".cts",
]);
export const IMPORT_PATTERNS = [
	/(?:import\s+(?:type\s+)?(?:[^"'`]+?\s+from\s+)?|export\s+(?:type\s+)?(?:[^"'`]+?\s+from\s+)?|import\()\s*["']([^"']+)["']/g,
	/require\(\s*["']([^"']+)["']\s*\)/g,
];

export type PackageManifest = {
	name: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
};

export type Workspace = {
	root: string;
	manifestPath: string;
	manifest: PackageManifest;
};

export function getWorkspaceManifests(): Workspace[] {
	return WORKSPACE_ROOTS.flatMap((workspaceRoot) => {
		const workspacePath = join(REPO_ROOT, workspaceRoot);

		return readdirSync(workspacePath, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(workspacePath, entry.name, "package.json"))
			.filter((manifestPath) => Bun.file(manifestPath).size > 0)
			.map((manifestPath) => ({
				root: dirname(manifestPath),
				manifestPath,
				manifest: JSON.parse(
					readFileSync(manifestPath, "utf8"),
				) as PackageManifest,
			}));
	});
}

export function collectSourceFiles(workspaceRoot: string): string[] {
	const srcRoot = join(workspaceRoot, "src");
	if (!existsSync(srcRoot)) {
		return [];
	}

	const files: string[] = [];
	const stack = [srcRoot];

	while (stack.length > 0) {
		const currentPath = stack.pop();
		if (!currentPath) {
			continue;
		}

		for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
			const entryPath = join(currentPath, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "dist" || entry.name === "node_modules") {
					continue;
				}
				stack.push(entryPath);
				continue;
			}

			const extension = entry.name.slice(entry.name.lastIndexOf("."));
			if (SOURCE_EXTENSIONS.has(extension)) {
				files.push(entryPath);
			}
		}
	}

	return files;
}

export function extractImports(filePath: string): string[] {
	const source = readFileSync(filePath, "utf8");
	const specifiers = new Set<string>();

	for (const pattern of IMPORT_PATTERNS) {
		for (const match of source.matchAll(pattern)) {
			const specifier = match[1];
			if (specifier) {
				specifiers.add(specifier);
			}
		}
	}

	return [...specifiers];
}

export function getCcflareDependencies(manifest: PackageManifest): string[] {
	return [
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.devDependencies ?? {}),
		...Object.keys(manifest.peerDependencies ?? {}),
	]
		.filter((dependency) => dependency.startsWith("@ccflare/"))
		.sort();
}
