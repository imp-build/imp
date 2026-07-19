import { describe, expect, test } from "//rules/imp/test";
import {
	synthesizeVirtualManifest,
	transitiveClosureDirs,
} from "//rules/rust/workspace_closure";

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
		expect(
			transitiveClosureDirs(METADATA, manifestPath("crates/imp")),
		).toEqual(["crates/imp", "crates/imp-execution", "crates/imp-store"]);
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

	const ROOT_MANIFEST_TEXT = `[workspace]
members = ["crates/*"]
resolver = "2"

[workspace.package]
version = "0.1.0"
edition = "2021"

[workspace.dependencies]
anyhow = "1"
serde = { version = "1", features = ["derive"] }

[profile.dev]
opt-level = 1
`;

	test("synthesizeVirtualManifest prunes members and keeps workspace.package/workspace.dependencies verbatim", () => {
		const manifest = synthesizeVirtualManifest(ROOT_MANIFEST_TEXT, [
			"crates/imp-execution",
			"crates/imp-store",
		]);

		expect(manifest).toContain(
			'members = ["crates/imp-execution", "crates/imp-store"]',
		);
		expect(manifest).toContain('resolver = "2"');
		expect(manifest).toContain("[workspace.package]");
		expect(manifest).toContain('version = "0.1.0"');
		expect(manifest).toContain("[workspace.dependencies]");
		expect(manifest).toContain('anyhow = "1"');
		// No [package]/[[bin]]/[profile.*] — this repo's root manifest is a
		// pure virtual workspace (see crates/imp/'s split from root), and a
		// synthesized manifest never needs to fabricate one.
		expect(manifest).not.toContain("[package]");
		expect(manifest).not.toContain("[profile.dev]");
	});

	test("synthesizeVirtualManifest omits workspace.dependencies when the real manifest has none", () => {
		const manifest = synthesizeVirtualManifest(
			'[workspace]\nmembers = ["crates/*"]\n',
			["crates/imp-store"],
		);

		expect(manifest).toContain('members = ["crates/imp-store"]');
		expect(manifest).not.toContain("[workspace.dependencies]");
		expect(manifest).not.toContain("[workspace.package]");
	});
});
