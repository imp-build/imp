import { describe, expect, test } from "//rules/imp/test";
import { transitiveClosureDirs } from "//rules/rust/workspace_closure";

const WORKSPACE_ROOT = "/sandbox/repo";

function manifestPath(dir) {
	return dir === "."
		? `${WORKSPACE_ROOT}/Cargo.toml`
		: `${WORKSPACE_ROOT}/${dir}/Cargo.toml`;
}

const METADATA = {
	workspace_root: WORKSPACE_ROOT,
	packages: [
		{
			name: "imp",
			manifest_path: manifestPath("crates/imp"),
			dependencies: [
				{ name: "imp-store", path: `${WORKSPACE_ROOT}/crates/imp-store` },
				{
					name: "imp-execution",
					path: `${WORKSPACE_ROOT}/crates/imp-execution`,
				},
			],
		},
		{
			name: "imp-execution",
			manifest_path: manifestPath("crates/imp-execution"),
			dependencies: [
				{ name: "imp-store", path: `${WORKSPACE_ROOT}/crates/imp-store` },
				{ name: "serde", path: null },
			],
		},
		{
			name: "imp-store",
			manifest_path: manifestPath("crates/imp-store"),
			dependencies: [{ name: "anyhow", path: null }],
		},
		{
			name: "imp-daemon",
			manifest_path: manifestPath("crates/imp-daemon"),
			dependencies: [],
		},
	],
};

describe("rust workspace closure", () => {
	test("transitiveClosureDirs includes only a leaf crate's own directory", () => {
		expect(
			transitiveClosureDirs(METADATA, manifestPath("crates/imp-store")),
		).toEqual(["crates/imp-store"]);
	});

	test("transitiveClosureDirs follows path dependencies transitively, excluding unrelated crates", () => {
		expect(transitiveClosureDirs(METADATA, manifestPath("crates/imp"))).toEqual(
			["crates/imp", "crates/imp-execution", "crates/imp-store"],
		);
	});

	test("transitiveClosureDirs ignores non-path (registry) dependencies", () => {
		const dirs = transitiveClosureDirs(
			METADATA,
			manifestPath("crates/imp-execution"),
		);
		expect(dirs).toEqual(["crates/imp-execution", "crates/imp-store"]);
	});

	test("transitiveClosureDirs returns just the start crate when its manifest isn't found", () => {
		expect(
			transitiveClosureDirs(METADATA, manifestPath("crates/missing")),
		).toEqual([]);
	});
});
