// Canonical Rust BUILD-generation entrypoint.
// Auto-generates a cargoPackage() declaration for every unowned Cargo.toml
// in the workspace, for the `imp generate-build` goal. Mirrors
// rules/odin/index.js's generateBuild ("odin-build-generator"), but Cargo
// gives us authoritative package/target data straight from the toolchain
// (`cargo metadata`), so there's no dependency-inference machinery to port
// over: a directory with a Cargo.toml just becomes one `cargoPackage({...})`,
// named after that package rather than after its directory, with `bin` set
// only when the package actually has bin-kind cargo targets — a lib-only
// package (or one with both a lib and one or more bins, see cargoPackage's
// now-optional `bin`) is represented just as accurately either way.
//
// Runs through the golden path (see //rules/workflows/generate_build.js),
// so run() — needed to shell out to `cargo metadata` — is available.

import {
	allUnowned,
	defineConfigSchema,
	field,
	glob,
	memo,
	registerBuildRule,
	run,
} from "imp:core";

import { cargoPackageHandles } from "//rules/rust";
import { rustTool } from "//rules/rust/toolchain";
import { registerBuildGenerator } from "//rules/workflows/generate_build";

registerBuildRule({
	rule: "cargoPackage",
	importFrom: "//rules/rust",
});

/**
 * Declarative workspace configuration schema for Rust.
 *
 * `buildGenerate` enables `imp goal generate-build` for unowned
 * `Cargo.toml` manifests (off by default).
 */
export const rustConfigSchema = {
	buildGenerate: field.bool({ default: false }),
	// The workspace default for cargoPackage() doc-tests. A package can
	// override this with its own `doctest` option.
	doctest: field.bool({ default: true }),
};

defineConfigSchema("rust", rustConfigSchema);

// "**/vendor/**" matters here beyond the usual convention: `cargo vendor`
// writes a full Cargo.toml for every vendored dependency, none of which are
// real, independently-buildable crates of this workspace.
const DEFAULT_GENERATE_BUILD_EXCLUDES = [
	"**/.*/**",
	"**/build/**",
	"**/coverage/**",
	"**/dist/**",
	"**/obj/**",
	"**/target/**",
	"**/vendor/**",
];

function dirname(path) {
	const index = path.lastIndexOf("/");
	return index < 0 ? "." : path.slice(0, index);
}

function normalize_workspace_path(path) {
	const parts = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		parts.push(part);
	}
	return parts.length === 0 ? "." : parts.join("/");
}

function sanitize_identifier(raw) {
	let name = raw.replace(/[^A-Za-z0-9_$]/g, "_");
	if (name.length === 0) name = "root";
	if (!/^[A-Za-z_$]/.test(name)) name = `_${name}`;
	return name;
}

function build_file_for_dir(dir) {
	return dir === "." ? "BUILD.js" : `${dir}/BUILD.js`;
}

function append_build_target(result, file, target) {
	if (!result[file]) result[file] = [];
	result[file].push(target);
}

// `cargo metadata`'s package list always includes every workspace member
// (not just the one at `manifestPath`) once `manifestPath` resolves inside a
// workspace — `--no-deps` only skips the dependency graph, not the member
// list — so the package for *this* manifest has to be picked out by matching
// `manifest_path`. The sandboxed run sees an absolute path that never equals
// the host-side workspace-relative `manifestPath`, so match by suffix
// instead; every manifest this generator considers includes at least one
// directory component (bare top-level "Cargo.toml" manifests are always
// pre-owned by a declared target in practice), so the suffix is unambiguous.
export function package_for_manifest(metadata, manifestPath) {
	const root = String(metadata.workspace_root || "").replace(/\/+$/, "");
	const suffix = `/${manifestPath}`;
	return (
		(metadata.packages || []).find(
			(pkg) =>
				manifestPath === "Cargo.toml"
					? pkg.manifest_path === `${root}/Cargo.toml`
					: pkg.manifest_path.endsWith(suffix),
		) || null
	);
}

function manifest_dir(manifestPath) {
	const index = manifestPath.lastIndexOf("/");
	return index < 0 ? "" : manifestPath.slice(0, index);
}

// True when this package's own manifest directory differs from cargo's
// resolved workspace root — i.e. it's a member of a workspace rooted in an
// ancestor directory, not a standalone crate or a workspace root itself. See
// cargoPackage's `workspaceMember` option (//rules/rust) for why this
// distinction matters for sandboxed build/test/fmt inputs.
function is_workspace_member(metadata, pkg) {
	return manifest_dir(pkg.manifest_path) !== metadata.workspace_root;
}

// Shells out to the real toolchain rather than hand-parsing TOML (CMake's
// rule shells out to real `cmake` instead of parsing CMakeLists.txt for the
// same reason) — this is what needs `run()`, and thus the golden path.
async function cargoMetadataFor(manifestPath) {
	const toolSpec = await rustTool();
	const result = await run({
		argv: [
			"sh",
			"-c",
			'cargo metadata --locked --no-deps --format-version=1 --manifest-path "$1"',
			"cargo-metadata",
			manifestPath,
		],
		tools: toolSpec.tools,
		env: [
			`RUSTUP_HOME=${toolSpec.rustupHome}`,
			`CARGO_HOME=${toolSpec.cargoHome}`,
		],
		// Cargo infers implicit lib/bin targets (src/lib.rs, src/main.rs,
		// src/bin/*.rs) from what's actually on disk, even for `cargo
		// metadata` — manifests/lockfile alone aren't enough, cargo errors
		// with "no targets specified" if the source files it expects to
		// find aren't there, so this needs the same broad glob sources()
		// uses for a real build, not just the manifests.
		inputs: [
			glob({
				root: ".",
				include: ["**/Cargo.toml", "Cargo.lock", "**/*.rs"],
				exclude: DEFAULT_GENERATE_BUILD_EXCLUDES,
			}),
		],
		materialize: false,
		display: `cargo metadata ${manifestPath}`,
	});
	return JSON.parse(result.stdout);
}

export const generateBuild = memo(
	async function generateBuild() {
		const manifests = allUnowned({
			root: ".",
			include: ["**/Cargo.toml"],
			exclude: DEFAULT_GENERATE_BUILD_EXCLUDES,
		});

		const existingPaths = new Set(
			cargoPackageHandles().map((h) => normalize_workspace_path(h.path)),
		);

		const result = {};
		for (const manifestPath of manifests) {
			const dir = dirname(manifestPath);
			if (existingPaths.has(normalize_workspace_path(dir))) continue;

			const metadata = await cargoMetadataFor(manifestPath);
			const pkg = package_for_manifest(metadata, manifestPath);
			if (!pkg) continue;

			const bins = (pkg.targets || [])
				.filter((t) => Array.isArray(t.kind) && t.kind.includes("bin"))
				.map((t) => t.name);

			const props = {};
			if (bins.length > 0) props.bin = bins.length === 1 ? bins[0] : bins;
			if (is_workspace_member(metadata, pkg)) props.workspaceMember = true;

			append_build_target(result, build_file_for_dir(dir), {
				name: sanitize_identifier(pkg.name),
				rule: "cargoPackage",
				props,
			});
		}
		return result;
	},
	{ display: "generate Rust BUILD files", level: "info" },
);

registerBuildGenerator({ namespace: "rust", generate: generateBuild });
