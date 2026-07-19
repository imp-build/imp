// Computes, for one `workspaceMember` crate, the minimal synthetic root
// `Cargo.toml` its build/test/lint sandbox actually needs to see — just that
// crate's transitive path-dependency closure, instead of the whole repo.
//
// Cargo eagerly resolves every manifest listed in a `[workspace] members`
// array (and the entry-point files its targets imply) before it can build
// anything, even members unrelated to what's being built — confirmed
// experimentally against real cargo. So `sources()` (//rules/rust) can't
// just narrow its glob; it also has to synthesize a *replacement* root
// manifest whose `members` list is pruned to the closure, since the real
// repo's `members = ["crates/*"]` would otherwise still pull every crate in.
//
// This module only handles the read-only build/test/lint path. No task in
// this codebase regenerates `Cargo.lock` (no `cargo update`/
// `generate-lockfile`) — if one is ever added, it must run against the real,
// complete, unpruned root `Cargo.toml`, not through this module: resolving
// from a pruned member subset isn't guaranteed to match the full workspace's
// resolution.

import { glob, memo, read_file, run } from "imp:core";

import { rustTool } from "//rules/rust/toolchain";

const ROOT_MANIFEST = "Cargo.toml";

// `cargo metadata --no-deps` already reports each package's manifest-declared
// `dependencies[].path` fields (confirmed against this repo's real output),
// so the path-dependency graph is derivable without a full, registry-
// resolving metadata call. Always called against the fixed root manifest
// (not each crate's own) and memo()'d, so every crate's closure computation
// shares one `cargo metadata` task-cache entry instead of one each.
//
// Deliberately not shared with generate_build.js's own `cargoMetadataFor`:
// that module already imports from this one (`//rules/rust`), so importing
// back from it here would be a cycle. The two calls are small and cheap
// (pure manifest parsing, no compilation) — duplicating this one is simpler
// than restructuring the import graph to share it.
const workspaceMetadata = memo(
	async function workspaceMetadata(toolchainVersion) {
		const toolSpec = await rustTool(toolchainVersion);
		const result = await run({
			argv: [
				"sh",
				"-c",
				'cargo metadata --no-deps --format-version=1 --manifest-path "$1"',
				"cargo-metadata-closure",
				ROOT_MANIFEST,
			],
			tools: toolSpec.tools,
			env: [
				`RUSTUP_HOME=${toolSpec.rustupHome}`,
				`CARGO_HOME=${toolSpec.cargoHome}`,
			],
			// `cargo metadata` infers implicit lib/bin targets from what's on
			// disk, so it needs to see every manifest and source file in the
			// workspace, not just manifests — same reasoning as sources()'s old
			// whole-repo glob, just for this one cheap, non-compiling task
			// instead of every build/test/lint task.
			inputs: [
				glob({
					root: ".",
					include: ["**/Cargo.toml", "Cargo.lock", "**/*.rs"],
					exclude: ["target/**"],
				}),
			],
			materialize: false,
			display: "cargo metadata (workspace closure)",
		});
		return JSON.parse(result.stdout);
	},
);

export async function workspaceMetadataFor(toolchainVersion) {
	return workspaceMetadata(toolchainVersion);
}

function manifestDirRelativeTo(manifestPath, workspaceRoot) {
	const rel = manifestPath.slice(workspaceRoot.length).replace(/^\/+/, "");
	const index = rel.lastIndexOf("/");
	return index < 0 ? "." : rel.slice(0, index);
}

// Pure graph walk: given `--no-deps` metadata and one package's absolute
// manifest path, return the sorted, deduplicated workspace-relative
// directories of every workspace-internal path-dependency it transitively
// depends on, including itself. `dep.path` (when present) is always
// absolute, same as `pkg.manifest_path`, so no relative-path juggling is
// needed to match them up.
export function transitiveClosureDirs(metadata, startManifestPath) {
	const byManifestPath = new Map(
		(metadata.packages || []).map((pkg) => [pkg.manifest_path, pkg]),
	);
	const workspaceRoot = metadata.workspace_root;

	const visited = new Set();
	const stack = [startManifestPath];
	while (stack.length > 0) {
		const current = stack.pop();
		if (visited.has(current) || !byManifestPath.has(current)) continue;
		visited.add(current);
		const pkg = byManifestPath.get(current);
		for (const dep of pkg.dependencies || []) {
			if (!dep.path) continue;
			const depManifest = `${dep.path}/Cargo.toml`;
			if (byManifestPath.has(depManifest) && !visited.has(depManifest)) {
				stack.push(depManifest);
			}
		}
	}

	return [...visited]
		.map((manifestPath) => manifestDirRelativeTo(manifestPath, workspaceRoot))
		.sort();
}

// TOML table headers always start at column 0 with `[` — good enough to
// lift whole blocks out verbatim without a real parser (none exists anywhere
// in this codebase, and none is needed here: the real file is never
// modified, just read from). Returns a Map from table name (e.g.
// "workspace.dependencies") to that table's raw text, header line included.
function extractTomlBlocks(text, wanted) {
	const blocks = new Map();
	let current = null;
	let buf = [];
	const flush = () => {
		if (current !== null && wanted.includes(current)) {
			blocks.set(current, buf.join("\n"));
		}
		buf = [];
	};
	for (const line of text.split("\n")) {
		const header = line.match(/^\[([^\]]+)\]\s*$/);
		if (header) {
			flush();
			current = header[1];
			buf.push(line);
		} else if (current !== null) {
			buf.push(line);
		}
	}
	flush();
	return blocks;
}

// Builds a fresh, minimal virtual workspace manifest: `[workspace]` with
// `members` pruned to just `memberDirs` (plus the real `resolver`), and the
// real `[workspace.package]`/`[workspace.dependencies]` tables copied
// verbatim — crates rely on `foo.workspace = true`/`edition.workspace = true`
// inheritance from those tables. Deliberately omits any `[package]` section:
// this repo's root manifest used to combine `[workspace]` with the `imp`
// binary's own `[package]`, which made root an *implicit* member of its own
// workspace regardless of `members` — confirmed experimentally that this
// forced root's own path-dependencies to exist even for unrelated builds.
// Splitting the binary into its own crate (crates/imp/) removed that
// wrinkle: root is now purely a `[workspace]` manifest, so every synthesized
// replacement can stay `[workspace]`-only too.
export function synthesizeVirtualManifest(rootManifestText, memberDirs) {
	const blocks = extractTomlBlocks(rootManifestText, [
		"workspace",
		"workspace.package",
		"workspace.dependencies",
	]);

	const workspaceBlock = blocks.get("workspace") || "";
	const resolverMatch = workspaceBlock.match(/^resolver\s*=\s*(.+)$/m);
	const resolverLine = resolverMatch ? `resolver = ${resolverMatch[1]}\n` : "";

	const membersLine = `members = [${memberDirs
		.map((dir) => JSON.stringify(dir))
		.join(", ")}]\n`;

	const parts = [`[workspace]\n${membersLine}${resolverLine}`];
	if (blocks.has("workspace.package"))
		parts.push(blocks.get("workspace.package"));
	if (blocks.has("workspace.dependencies")) {
		parts.push(blocks.get("workspace.dependencies"));
	}
	return `${parts.join("\n")}\n`;
}

// Full narrowing pipeline for one `workspaceMember` crate: resolves its
// transitive path-dependency closure and synthesizes the pruned manifest
// text to replace the real root Cargo.toml with in its build/test/lint
// sandbox.
//
// @param {string} path Crate's own workspace-relative directory (e.g.
//   "crates/imp-store"), as returned by declared_path().
// @param {string} [toolchainVersion] Resolved Rust toolchain version.
// @returns {Promise<{ dirs: string[], manifest: string }>}
export async function workspaceClosureFor(path, toolchainVersion) {
	const metadata = await workspaceMetadataFor(toolchainVersion);
	const startManifest = `${metadata.workspace_root}/${path}/Cargo.toml`;
	const dirs = transitiveClosureDirs(metadata, startManifest);
	const rootManifestText = read_file(ROOT_MANIFEST);
	const manifest = synthesizeVirtualManifest(rootManifestText, dirs);
	return { dirs, manifest };
}
