// Computes, for one `workspaceMember` crate, the split between "full"
// source (its own transitive path-dependency closure — actually compiled)
// and "shallow" source (every *other* real member of the same workspace —
// cargo needs to know these exist and what targets they declare, but never
// reads anything beyond their manifest + each declared target's entry-point
// file unless they're a real dependency of what's being built). Also
// exposes a whole-workspace variant (every real member, in full) used by
// the shared lint/test-build tasks (rules/rust/lint.js, rules/rust/test.js).
//
// Cargo eagerly resolves every manifest listed in a `[workspace] members`
// array before it can build anything, even members unrelated to what's
// being built — confirmed experimentally. This used to be solved by
// synthesizing a *replacement* root manifest whose `members` list was
// pruned down to the closure — but this repo's one shared `Cargo.lock`
// covers every real member, and a narrowed member list makes cargo want to
// trim the now-unreachable lock entries on every invocation, which
// `--locked` then refuses (confirmed directly: a pure removal, never a
// version change — but `--locked` can't distinguish "harmless trim" from
// "real re-resolution" and blocks both). So instead: keep the real root
// `Cargo.toml`/`Cargo.lock` completely unmodified (nothing to trim,
// `--locked` trivially satisfied), and get the same cache-locality benefit
// by staging a *shallow* file set for non-closure members instead of
// omitting them from the manifest.
//
// This module only handles the read-only build/test/lint path. No task in
// this codebase regenerates `Cargo.lock` — if one is ever added, it must
// run against the real, complete root `Cargo.toml` directly, same as today.

import { glob, memo, run } from "imp:core";

import { rustTool } from "//rules/rust/toolchain";

const METADATA_INPUTS = [
	glob({
		root: ".",
		include: ["**/Cargo.toml", "Cargo.lock", "**/*.rs"],
		exclude: ["target/**"],
	}),
];

// Runs `cargo metadata` directly against *this crate's own* manifest rather
// than a hardcoded repo-root constant — cargo itself walks up and finds
// whichever real ancestor `[workspace]` applies (the same mechanism a real
// build already relies on), so this generalizes cleanly to multiple
// independent workspaces living in the same repo (each crate's own call
// discovers its own root, with no assumption shared between them), and
// still works for a crate that turns out not to be in any real workspace.
// Memoized per (path, toolchainVersion) rather than shared by discovered
// workspace root: the call is cheap (no network, no compilation — confirmed
// sub-100ms cold-cache), so per-crate duplication within one workspace
// isn't worth the complexity of pre-discovering a shared root to key a
// cross-crate memo by.
const workspaceMetadata = memo(
	async function workspaceMetadata(path, toolchainVersion) {
		const toolSpec = await rustTool(toolchainVersion);
		const result = await run({
			argv: [
				"sh",
				"-c",
				'cargo metadata --locked --no-deps --format-version=1 --manifest-path "$1"',
				"cargo-metadata-closure",
				`${path}/Cargo.toml`,
			],
			tools: toolSpec.tools,
			env: [
				`RUSTUP_HOME=${toolSpec.rustupHome}`,
				`CARGO_HOME=${toolSpec.cargoHome}`,
			],
			// `cargo metadata` infers implicit lib/bin targets from what's on
			// disk, so it needs to see every manifest and source file in the
			// workspace, not just manifests — same reasoning sources() itself
			// used to need for a whole-repo glob, just for this one cheap,
			// non-compiling task instead of every build/test/lint task.
			inputs: METADATA_INPUTS,
			materialize: false,
			display: `cargo metadata (workspace closure) ${path}`,
		});
		return JSON.parse(result.stdout);
	},
);

export async function workspaceMetadataFor(path, toolchainVersion) {
	return workspaceMetadata(path, toolchainVersion);
}

function manifestDirRelativeTo(manifestPath, workspaceRoot) {
	const rel = manifestPath.slice(workspaceRoot.length).replace(/^\/+/, "");
	const index = rel.lastIndexOf("/");
	return index < 0 ? "." : rel.slice(0, index);
}

// `metadata.workspace_root` and every `packages[].manifest_path`/
// `targets[].src_path` are absolute filesystem paths from cargo's
// perspective, but every other path used throughout the Rust rules
// (`declared_path()`, glob roots, ...) is repo-root-relative. The absolute
// repo root isn't otherwise known (it's a sandbox-specific path chosen at
// execution time) — recover it by diffing *this same* crate's own known
// repo-relative manifest path against what cargo reported for it. This
// also generalizes to a workspace root that ISN'T the repo root itself (a
// second, independent workspace living in some subdirectory): nothing here
// assumes `workspace_root` equals the repo root, only that this one crate's
// own repo-relative path is known.
function repoRelativeConverter(metadata, path) {
	const ownManifestRel = `${path}/Cargo.toml`;
	const ownPkg = (metadata.packages || []).find((pkg) =>
		pkg.manifest_path.endsWith(`/${ownManifestRel}`),
	);
	if (!ownPkg) {
		throw new Error(
			`cargo metadata didn't report a package for ${ownManifestRel}`,
		);
	}
	const repoRootAbs = ownPkg.manifest_path.slice(
		0,
		-(ownManifestRel.length + 1),
	);
	return (absPath) =>
		absPath === repoRootAbs ? "." : absPath.slice(repoRootAbs.length + 1);
}

// Just the repo-relative directory of the real workspace root a crate
// belongs to — the cheap half of workspaceClosureFor(), for callers (the
// shared whole-workspace lint/test-build tasks) that only need to know
// *which* workspace to join, not this one crate's own closure/shallow set.
export async function workspaceRootRelativeFor(path, toolchainVersion) {
	const metadata = await workspaceMetadataFor(path, toolchainVersion);
	return repoRelativeConverter(metadata, path)(metadata.workspace_root);
}

// Pure graph walk: given `--no-deps` metadata and one package's absolute
// manifest path, return the sorted, deduplicated workspace-relative
// directories of every workspace-internal path-dependency it transitively
// depends on, including itself. `dep.path` (when present) is always
// absolute, same as `pkg.manifest_path`, so no relative-path juggling is
// needed to match them up. A path-dependency reaching a package *outside*
// the workspace's own directory tree (cargo transparently absorbs those
// into the current resolution even though they're not listed in
// `members`) is handled the same way with no special-casing: if cargo
// resolved it, it's in `metadata.packages` with a `manifest_path`, and this
// walk picks it up like any other.
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

// Full narrowing pipeline for one `workspaceMember` crate: resolves its
// transitive path-dependency closure, and everything needed to stage a
// *shallow* view of every other real member of the same workspace.
//
// @param {string} path Crate's own workspace-relative directory (e.g.
//   "crates/imp-store"), as returned by declared_path().
// @param {string} [toolchainVersion] Resolved Rust toolchain version.
// @returns {Promise<{
//   dirs: string[],
//   shallowFiles: string[],
//   workspaceRootRelative: string,
// }>} `dirs` is the crate's own closure (full source needed); `shallowFiles`
// are repo-relative paths (manifests + declared target entry points) for
// every other real member of the same workspace; `workspaceRootRelative` is
// that workspace's root directory, repo-relative (`"."` when it is the
// repo root).
export async function workspaceClosureFor(path, toolchainVersion) {
	const metadata = await workspaceMetadataFor(path, toolchainVersion);
	const startManifest = `${metadata.workspace_root}/${path}/Cargo.toml`;
	const dirs = transitiveClosureDirs(metadata, startManifest);
	const toRepoRelative = repoRelativeConverter(metadata, path);
	const workspaceRootRelative = toRepoRelative(metadata.workspace_root);

	const byId = new Map((metadata.packages || []).map((pkg) => [pkg.id, pkg]));
	const shallowFiles = [];
	for (const id of metadata.workspace_members || []) {
		const pkg = byId.get(id);
		if (!pkg) continue;
		const dir = manifestDirRelativeTo(
			pkg.manifest_path,
			metadata.workspace_root,
		);
		if (dirs.includes(dir)) continue; // already staged in full via `dirs`
		shallowFiles.push(toRepoRelative(pkg.manifest_path));
		for (const target of pkg.targets || []) {
			shallowFiles.push(toRepoRelative(target.src_path));
		}
	}

	return { dirs, shallowFiles, workspaceRootRelative };
}

// Runs `cargo metadata` directly against the workspace ROOT's own manifest
// (`${workspaceRootRelative}/Cargo.toml`) rather than any one particular
// crate's — valid even when, as in every workspace in this repo, the root
// manifest is a pure `[workspace]` table with no `[package]` of its own
// (cargo still resolves and reports the full member/package graph from
// there). Bootstrapping from workspace identity alone, instead of from
// whichever crate happens to call in first, is what lets every crate in
// the same workspace share one memoized entry (keyed by
// `workspaceRootRelative` itself) — the whole point of collapsing per-crate
// lint/test-build invocations into one shared one.
const wholeWorkspaceMetadata = memo(
	async function wholeWorkspaceMetadata(
		workspaceRootRelative,
		toolchainVersion,
	) {
		const toolSpec = await rustTool(toolchainVersion);
		const prefix =
			workspaceRootRelative === "." ? "" : `${workspaceRootRelative}/`;
		const result = await run({
			argv: [
				"sh",
				"-c",
				'cargo metadata --locked --no-deps --format-version=1 --manifest-path "$1"',
				"cargo-metadata-workspace",
				`${prefix}Cargo.toml`,
			],
			tools: toolSpec.tools,
			env: [
				`RUSTUP_HOME=${toolSpec.rustupHome}`,
				`CARGO_HOME=${toolSpec.cargoHome}`,
			],
			inputs: METADATA_INPUTS,
			materialize: false,
			display: `cargo metadata (whole workspace) ${workspaceRootRelative}`,
		});
		return JSON.parse(result.stdout);
	},
);

// Every real member of the same workspace, in full (not shallow) — for the
// shared, whole-workspace lint/test-build tasks (rules/rust/lint.js,
// rules/rust/test.js), which genuinely need to compile/check every member,
// not just one crate's own closure. Per-crate narrowing bought little in
// practice anyway: most crates' own closures already cover most or all of a
// typical workspace (confirmed against this repo: 8 of 9 crates), so lint
// and test collapse to one shared invocation per real workspace root
// instead of one per crate, relying on the Rust build cache (kache, already
// wired into build/test/clippy) to keep a one-crate edit cheap in practice.
//
// @param {string} workspaceRootRelative As returned by
//   workspaceRootRelativeFor()/workspaceClosureFor().
// @returns {Promise<{ memberDirs: string[] }>}
export async function wholeWorkspaceFor(
	workspaceRootRelative,
	toolchainVersion,
) {
	const metadata = await wholeWorkspaceMetadata(
		workspaceRootRelative,
		toolchainVersion,
	);
	const byId = new Map((metadata.packages || []).map((pkg) => [pkg.id, pkg]));
	const members = (metadata.workspace_members || [])
		.map((id) => byId.get(id))
		.filter(Boolean);
	const memberDirs = members
		.map((pkg) =>
			manifestDirRelativeTo(pkg.manifest_path, metadata.workspace_root),
		)
		.sort();

	// Per-member name pair for doc-test attribution (see
	// rules/rust/index.js's runWorkspaceDocTests): cargo's own `Doc-tests
	// <name>` status header uses the lib/proc-macro target's name (always
	// underscored), while its `-p <name> --doc` failure references use the
	// package name (hyphens intact, as declared) — the two are never
	// interchangeable. Keyed by the same repo-relative dir memberDirs
	// reports. `libName` is null for a lib-less (bin-only) package, which
	// `cargo test --doc --workspace` silently skips rather than erroring.
	const docTestNames = new Map();
	for (const pkg of members) {
		const dir = manifestDirRelativeTo(
			pkg.manifest_path,
			metadata.workspace_root,
		);
		const libTarget = (pkg.targets || []).find((t) =>
			(t.kind || []).some((k) => k === "lib" || k === "proc-macro"),
		);
		docTestNames.set(dir, {
			packageName: pkg.name,
			libName: libTarget ? libTarget.name : null,
		});
	}

	return { memberDirs, docTestNames };
}
