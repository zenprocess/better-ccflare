import { describe, expect, it } from "bun:test";
import { join, relative } from "node:path";
import {
	collectSourceFiles,
	extractImports,
	getCcflareDependencies,
	getWorkspaceManifests,
	REPO_ROOT,
	type Workspace,
} from "./test-helpers/workspace";

function findImportViolations(
	workspaceRoot: string,
	isViolation: (specifier: string) => boolean,
): string[] {
	const violations: string[] = [];

	for (const sourceFile of collectSourceFiles(workspaceRoot)) {
		for (const specifier of extractImports(sourceFile)) {
			if (isViolation(specifier)) {
				violations.push(
					`${relative(REPO_ROOT, sourceFile)} imports ${specifier}`,
				);
			}
		}
	}

	return violations.sort();
}

function findWorkspaceCycles(workspaces: Workspace[]): string[] {
	const workspaceNames = new Set(
		workspaces.map(({ manifest }) => manifest.name),
	);
	const graph = new Map<string, string[]>();

	for (const { manifest } of workspaces) {
		const dependencies = getCcflareDependencies(manifest).filter((dependency) =>
			workspaceNames.has(dependency),
		);
		graph.set(manifest.name, dependencies);
	}

	const visited = new Set<string>();
	const inStack = new Set<string>();
	const path: string[] = [];
	const cycles = new Set<string>();

	function visit(node: string) {
		visited.add(node);
		inStack.add(node);
		path.push(node);

		for (const dependency of graph.get(node) ?? []) {
			if (!visited.has(dependency)) {
				visit(dependency);
				continue;
			}

			if (inStack.has(dependency)) {
				const cycleStart = path.indexOf(dependency);
				const cycle = [...path.slice(cycleStart), dependency].join(" -> ");
				cycles.add(cycle);
			}
		}

		path.pop();
		inStack.delete(node);
	}

	for (const node of graph.keys()) {
		if (!visited.has(node)) {
			visit(node);
		}
	}

	return [...cycles].sort();
}

describe("workspace package boundaries", () => {
	it("keeps workspace dependency edges acyclic", () => {
		expect(findWorkspaceCycles(getWorkspaceManifests())).toEqual([]);
	});

	it("keeps leaf workspaces free of @ccflare dependencies", () => {
		const leafWorkspaceNames = new Set(["@ccflare/types"]);
		const violations: string[] = [];

		for (const workspace of getWorkspaceManifests()) {
			if (!leafWorkspaceNames.has(workspace.manifest.name)) {
				continue;
			}

			const manifestDependencies = getCcflareDependencies(workspace.manifest);
			if (manifestDependencies.length > 0) {
				violations.push(
					`${relative(REPO_ROOT, workspace.manifestPath)} declares ${manifestDependencies.join(", ")}`,
				);
			}

			violations.push(
				...findImportViolations(workspace.root, (specifier) =>
					specifier.startsWith("@ccflare/"),
				),
			);
		}

		expect(violations).toEqual([]);
	});

	it("blocks the audited layer violations", () => {
		const workspaces = getWorkspaceManifests();
		const workspaceByName = new Map(
			workspaces.map((workspace) => [workspace.manifest.name, workspace]),
		);
		const violations = [
			...findImportViolations(
				workspaceByName.get("@ccflare/proxy")?.root ??
					join(REPO_ROOT, "packages/proxy"),
				(specifier) => specifier === "@ccflare/ui",
			),
			...findImportViolations(
				workspaceByName.get("@ccflare/types")?.root ??
					join(REPO_ROOT, "packages/types"),
				(specifier) =>
					specifier === "@ccflare/config" || specifier === "@ccflare/database",
			),
			...findImportViolations(
				workspaceByName.get("ccflare")?.root ?? join(REPO_ROOT, "apps/tui"),
				(specifier) => specifier === "@ccflare/server",
			),
		];

		expect(violations.sort()).toEqual([]);
	});
});
