import {
	Target,
	artifact,
	configuration,
	file_set,
	glob,
	hydrateTarget,
	memo,
	output,
	output_path,
	paths,
	platformInfo,
	product,
	productFor,
	run,
	sourcesField,
	targetAddress,
	BUILD,
	PACKAGE,
	TEST,
} from "imp:core";

import {
	RUST_LINKER,
	RUST_LINK_DRIVER,
	RUST_BUILD_CACHE,
} from "//rules/rust/products";
import { CargoPackage, normalize_deps } from "//rules/rust/cargo_package";
export { CargoPackage, normalize_deps } from "//rules/rust/cargo_package";

import {
	defaultRustToolchain,
	resolveRustToolchainVersion,
	rustTool,
	rustToolchain,
} from "//rules/rust/toolchain";

import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";

import { defaultGccToolchain } from "//rules/c/gcc/toolchain";

import { workspaceClosureFor } from "//rules/rust/workspace_closure";

import { resources as resource_package_sources } from "//rules/asset";

// Registers the "build" goal's artifact summary callback for consumers that
// import Rust build rules without importing the workflows layer explicitly.
import "//rules/workflows/build_workflow";

// Registers the rust_test fan-out (expandCargoTests + rust_test's build/test
// products) for consumers that import Rust build rules without importing
// //rules/rust/test explicitly — same reasoning as the build_workflow import
// above. Side-effect only; nothing exported from it is used in this file.
import "//rules/rust/test";

// Registers the "generate-build" product (auto-declaring cargoPackage()
// targets for unowned Cargo.toml files) for the same reason.
import "//rules/rust/generate_build";
import { RUST_TOOL } from "//rules/rust/toolchain";

export {
	acquireRustToolchain,
	defaultRustToolchain,
	defaultRustToolchainVersion,
	resolveRustToolchainVersion,
	rustArtifactName,
	rustBin,
	rustCacheKey,
	rustDownloadUrl,
	rustTool,
	rustToolchain,
} from "//rules/rust/toolchain";

// ---------------------------------------------------------------------------
// Path helpers (same pattern as rules/odin/index.js, rules/c/cmake/index.js)
// ---------------------------------------------------------------------------

function normalize_workspace_path(path) {
	const parts = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			throw new Error(`Rust paths must stay within the workspace: ${path}`);
		}
		parts.push(part);
	}
	return parts.length === 0 ? "." : parts.join("/");
}

function safe_target_address(handle) {
	if (!handle || handle.__imp !== true) return null;
	try {
		return targetAddress(handle);
	} catch (_) {
		return null;
	}
}

function declaring_directory(handle) {
	const address = safe_target_address(handle);
	if (!address || !address.startsWith("//")) return ".";
	const scope = address.slice(2).split(":")[0];
	return scope.length === 0 ? "." : scope;
}

export function declared_path(handle, path = ".") {
	const base = declaring_directory(handle);
	const local = path || ".";
	if (base === ".") return normalize_workspace_path(local);
	if (local === ".") return base;
	return normalize_workspace_path(`${base}/${local}`);
}

// ---------------------------------------------------------------------------
// Source discovery
// ---------------------------------------------------------------------------

// Just the crate's .rs files — used by fmt, which only ever reformats source
// files (not Cargo.toml/Cargo.lock).
export const rust_file_sources = memo(async function rust_file_sources(handle) {
	const root = declared_path(handle, handle.attrs.path || ".");
	return glob({ root, include: ["**/*.rs"], exclude: ["target/**"] });
});

// Everything cargo build needs to see: manifests, lockfile (if present), and
// sources.
//
// A crate declared with `workspaceMember: true` (set by
// //rules/rust/generate_build.js when `cargo metadata` reports its
// workspace_root as an ancestor directory, not itself) needs cargo to
// resolve the real `[workspace]` it belongs to — cargo walks up from
// --manifest-path to find the enclosing workspace manifest, and (since
// workspace members here declare real path-dependencies on each other,
// e.g. crates/imp-execution on crates/imp-store) needs every crate in
// its transitive path-dependency closure visible too. Rather than glob the
// *entire* repo (any Rust edit anywhere would invalidate every crate's
// build/test/lint task), this synthesizes a replacement root manifest whose
// `members` list is pruned to just that closure — see
// //rules/rust/workspace_closure for why a straight `members` prune alone
// isn't enough and how the synthesis works.
//
// A standalone crate (no `workspaceMember`) must stay scoped to its own
// directory: including an *unrelated* ancestor `[workspace]` manifest that
// doesn't list it as a member makes cargo fail with "current package
// believes it's in a workspace when it's not" (confirmed directly against
// rules/rust/example, which sits under this repo's own root Cargo.toml but
// isn't one of its `members`).
//
// @returns {Promise<{ files: FileSet, manifest: string|null }>} `manifest`
// is the synthesized replacement root Cargo.toml's text for `workspaceMember`
// crates, or `null` when the real root manifest applies unmodified.
export const sources = memo(async function sources(handle) {
	const path = declared_path(handle, handle.attrs.path || ".");
	if (!handle.attrs.workspaceMember) {
		return {
			files: glob({
				root: path,
				include: ["**/Cargo.toml", "Cargo.lock", "**/*.rs"],
				exclude: ["target/**"],
			}),
			manifest: null,
		};
	}

	const toolchainVersion = rust_toolchain_version(handle);
	const { dirs, manifest } = await workspaceClosureFor(path, toolchainVersion);
	const include = dirs.flatMap((dir) => [
		`${dir}/Cargo.toml`,
		`${dir}/**/*.rs`,
	]);
	include.push("Cargo.lock");
	return {
		files: glob({ root: ".", include, exclude: ["target/**"] }),
		manifest,
	};
});

// Wraps a cargo-invoking script so that, when `sources()` narrowed a
// `workspaceMember` crate's inputs (`manifest` non-null), the synthesized
// replacement root Cargo.toml is written into place before the script's own
// cargo invocation runs. A no-op (aside from one harmless extra shell
// variable) when `manifest` is null, so every callsite can wrap
// unconditionally instead of branching. Callers must prepend the returned
// `arg` to their own argv, ahead of their existing positional args — the
// prelude's own `shift 1` restores the original numbering ($1, $2, ... in
// the wrapped script) for the rest of the script unchanged.
export function withManifestOverride(script, manifest) {
	return {
		script:
			"manifest_override=$1; shift 1; " +
			'if [ -n "$manifest_override" ]; then printf %s "$manifest_override" > Cargo.toml; fi; ' +
			script,
		arg: manifest || "",
	};
}

// FileSet of a cargoPackage's declared resource-package deps (see
// //rules/asset's resourcePackage) — same pattern rules/odin/index.js's
// `resources` uses, minus the transitive-package-dep recursion (a
// cargoPackage has no notion of depending on another cargoPackage the way
// an odinPackage depends on other odin-package targets; Cargo itself owns
// crate-to-crate deps via Cargo.toml/the registry).
export const resources = memo(async function resources(handle) {
	const sets = (hydrateTarget(handle).deps || [])
		.map((dep) => dep.handle)
		.filter((dep) => dep && dep.kind === "resource-package");
	if (sets.length === 0) return file_set.literal([]);
	const resolved = await Promise.all(sets.map(resource_package_sources));
	return resolved.length === 1 ? resolved[0] : file_set.union(...resolved);
});

export function rust_toolchain_version(handle) {
	const toolchainHandle = handle.attrs.toolchain;
	return toolchainHandle
		? toolchainHandle.attrs.version
		: resolveRustToolchainVersion(handle.attrs.toolchainVersion);
}

// cargo/rustc need a real C link driver in the hermetic sandbox — rustc
// shells out to a program literally named "cc" by default. Reuse the gcc
// toolchain Odin already relies on for the same reason (rules/odin/index.js's
// odinScriptTools): its "rust-link-driver" product exposes a "clang"-named
// wrapper script on PATH that execs the real (prefixed) gcc binary, so
// pointing rustc's linker at "clang" sidesteps needing a "cc" alias of our
// own. A workspace can additionally opt into a faster backend linker (e.g.
// mold) via rustToolchain({ linker: moldToolchain() }); by default no extra
// -fuse-ld= flag is added.
//
// Windows has no pinned toolchain to plug into this abstraction (the Bootlin
// gcc archive is Linux-only) — it always uses the host's own MinGW gcc,
// discovered via PATH, regardless of any declared rustToolchain/linkDriver.
export async function rustLinkerTools(toolchainHandle) {
	if (platformInfo().os === "windows") {
		return {
			tools: [await nativeToolSpec(nativeTool("gcc"))],
			rustflags: "-C linker=gcc",
			env: [],
		};
	}
	const linkDriverHandle =
		(toolchainHandle && toolchainHandle.attrs.linkDriver) ||
		defaultGccToolchain();
	if (!linkDriverHandle) {
		throw new Error(
			"cargo builds need a declared gccToolchain() default, or a rustToolchain({ linkDriver }) — see //rules/c/gcc",
		);
	}
	const linkDriver = await productFor(linkDriverHandle, RUST_LINK_DRIVER);

	const linkerHandle = toolchainHandle && toolchainHandle.attrs.linker;
	const linker = linkerHandle
		? await productFor(linkerHandle, RUST_LINKER)
		: null;

	const sccacheActive = !!(toolchainHandle && toolchainHandle.attrs.sccache);
	const tools = [
		...(await linkDriver.tools()),
		...(linker ? await linker.tools() : []),
	];
	const rustflags = [
		...(await linkDriver.rustflags()),
		...(linker ? await linker.rustflags() : []),
	].join(" ");
	const env = await linkDriver.env(sccacheActive);
	return { tools, rustflags, env };
}

// Optional rustc build-caching layer (e.g. sccache, //rules/rust/sccache),
// wired independently of the linker abstraction above since it wraps rustc
// itself rather than the link step. Opt in via
// rustToolchain({ sccache: sccacheToolchain() }); no-ops otherwise.
export async function rustBuildCacheTools(toolchainHandle) {
	const sccacheHandle = toolchainHandle && toolchainHandle.attrs.sccache;
	if (!sccacheHandle) {
		return { tools: [], env: [] };
	}
	const wrapper = await productFor(sccacheHandle, RUST_BUILD_CACHE);
	return {
		tools: await wrapper.tools(),
		env: await wrapper.env(),
	};
}

// Resolve RUSTUP_HOME/CARGO_HOME/PATH for invoking cargo/rustc.
//
// Normally these are sandbox-relative "tool" mount aliases (toolSpec.tools +
// toolSpec.rustupHome/cargoHome) — reproducible and explicitly tracked as
// build inputs, per the sandbox's usual hermeticity model.
//
// When sccache is wrapping rustc, that per-sandbox aliasing itself becomes a
// bug: sccache's long-lived server caches detected "compiler info" keyed by
// the *canonicalized* exe path (resolving the sandbox symlink down to the
// same real, stable toolchain directory every time — see
// mozilla/sccache's src/server.rs `compiler_info()`), but the *literal*
// (uncanonicalized) exe path embedded in that cached entry — the one
// actually used to spawn the compiler on a cache miss — is whichever
// sandbox's path happened to be seen first. Once that first sandbox is torn
// down, every later build sharing the same server fails with "No such file
// or directory" trying to invoke a compiler at a path that no longer
// exists, even though the exact same toolchain is trivially reachable via
// the *current* sandbox's own (different) symlink.
//
// The fix is to make the literal exe path identical across every sandbox in
// the first place: when sccache is active, resolve cargo/rustc through the
// real, absolute, stable named-cache directory (toolSpec.rustupHomeAbs/
// cargoHomeAbs) instead of the sandbox-relative alias, and skip mounting
// the sandbox "tool" copies at all — mirroring the same real-path-over-
// sandbox-mount tradeoff already made for sccache's own data directory (see
// sccacheDataDir() in //rules/rust/sccache/toolchain).
export function rustToolEnv(toolSpec, sccacheActive) {
	if (!sccacheActive) {
		return {
			tools: toolSpec.tools,
			env: [
				`RUSTUP_HOME=${toolSpec.rustupHome}`,
				`CARGO_HOME=${toolSpec.cargoHome}`,
			],
		};
	}
	return {
		tools: [],
		env: [
			`RUSTUP_HOME=${toolSpec.rustupHomeAbs}`,
			`CARGO_HOME=${toolSpec.cargoHomeAbs}`,
			`PATH=${toolSpec.rustupHomeAbs}/toolchains/${toolSpec.toolchainId}/bin:${toolSpec.cargoHomeAbs}/bin`,
		],
	};
}

// ---------------------------------------------------------------------------
// Product functions
// ---------------------------------------------------------------------------

/**
 * Build a Cargo binary crate.
 *
 * @param {object} handle Target handle returned by cargoPackage().
 * @returns {Promise<object>} Run result, plus `outputPaths`: the built
 * binaries' workspace-relative paths, one per `bin` entry.
 */

export const cargoBuild = product(
	CargoPackage,
	BUILD,
	RUST_TOOL,
	async function cargoBuild(handle) {
		if (handle.attrs.bins.length === 0) {
			return { outputPaths: [] };
		}
		const toolSpec = await rustTool(rust_toolchain_version(handle));
		const toolchainHandle = handle.attrs.toolchain || defaultRustToolchain();
		const {
			tools: linkerTools,
			rustflags,
			env: linkerEnv,
		} = await rustLinkerTools(toolchainHandle);
		const { tools: cacheTools, env: cacheEnv } =
			await rustBuildCacheTools(toolchainHandle);
		const { tools: rustTools, env: rustEnv } = rustToolEnv(
			toolSpec,
			!!(toolchainHandle && toolchainHandle.attrs.sccache),
		);

		const path = declared_path(handle, handle.attrs.path || ".");
		const { files: srcs, manifest } = await sources(handle);
		const resourceInputs = await resources(handle);

		// A target-local release opt-in remains authoritative, while a workspace
		// may supply the ordinary debug/release default through its opt axis.
		// Read the namespace directly so the reusable Rust rules keep their
		// existing debug behavior in workspaces that do not declare that axis.
		const mode = configuration("imp.mode", {}) || {};
		const release = handle.attrs.release || mode.opt === "release";
		const profile = release ? "release" : "debug";
		const buildDir = output_path(`build/rust/${path === "." ? "root" : path}`);
		const plat = platformInfo();
		const exeSuffix = plat.os === "windows" ? ".exe" : "";
		const outPaths = handle.attrs.bins.map(
			(name) => `${buildDir}/${profile}/${name}${exeSuffix}`,
		);

		const { script, arg: manifestArg } = withManifestOverride(
			"manifest=$1; target_dir=$2; rustflags=$3; shift 3; " +
				'RUSTFLAGS="$rustflags" cargo build --manifest-path "$manifest" --target-dir "$target_dir" "$@"',
			manifest,
		);

		const result = await run({
			argv: [
				"sh",
				"-c",
				script,
				"cargo-build",
				manifestArg,
				`${path}/Cargo.toml`,
				buildDir,
				rustflags,
				...(release ? ["--release"] : []),
				...handle.attrs.cargoArgs,
			],
			tools: [...rustTools, ...linkerTools, ...cacheTools],
			env: [...rustEnv, ...linkerEnv, ...cacheEnv],
			inputs: [srcs, resourceInputs],
			outputs: outPaths.map((p) => output(output_path(p))),
			materialize: false,
			display: `cargo build ${path}`,
		});

		return { ...result, outputPaths: outPaths, buildDir };
	},
);

export const cargoDistPackage = product(
	CargoPackage,
	PACKAGE,
	RUST_TOOL,
	async function cargoDistPackage(handle) {
		const result = await cargoBuild(handle);
		if (handle.attrs.bins.length === 0) {
			return null;
		}
		return artifact(result.outputDigest, { from: result.buildDir });
	},
);

/**
 * Run a Cargo binary crate's doc-tests.
 *
 * //rules/rust/test.js's expandCargoTests fan-out already discovers and runs
 * every unit/integration test binary (via `cargo test --no-run`, one
 * `rust_test` target per binary) — running the whole crate's tests again
 * here would duplicate all of that work under a package/recursive selector.
 * Doc-tests aren't discoverable via `--no-run` though (they only ever run
 * through a real `cargo test`), so this stays scoped to `--doc` as the one
 * piece the fan-out can't cover.
 *
 * @param {object} handle Target handle returned by cargoPackage().
 * @returns {Promise<object>} Run result from `cargo test --doc`.
 */
export const cargoTest = product(
	CargoPackage,
	TEST,
	RUST_TOOL,
	async function cargoTest(handle) {
		const toolSpec = await rustTool(rust_toolchain_version(handle));
		const toolchainHandle = handle.attrs.toolchain || defaultRustToolchain();
		const {
			tools: linkerTools,
			rustflags,
			env: linkerEnv,
		} = await rustLinkerTools(toolchainHandle);
		const { tools: cacheTools, env: cacheEnv } =
			await rustBuildCacheTools(toolchainHandle);
		const { tools: rustTools, env: rustEnv } = rustToolEnv(
			toolSpec,
			!!(toolchainHandle && toolchainHandle.attrs.sccache),
		);
		const testTools = await Promise.all(
			(handle.attrs.testTools || []).map(nativeToolSpec),
		);

		const path = declared_path(handle, handle.attrs.path || ".");
		const { files: srcs, manifest } = await sources(handle);
		const resourceInputs = await resources(handle);
		const buildDir = output_path(`build/rust/${path === "." ? "root" : path}`);

		// --workspace so member-crate doc-tests run too when the manifest is a
		// workspace root; on a plain single crate it's a no-op. A generated
		// workspace-member target must test only its own package, otherwise
		// every member target redundantly retests the entire workspace using
		// that member's narrower resources and test-tool declarations.
		//
		// --doc: see cargoTest's docstring above — everything else is covered
		// by the rust_test fan-out in //rules/rust/test.js.
		//
		// A bin-only crate (no `[lib]` target) has no doc-tests by
		// definition, but `cargo test --doc` still hard-errors on it
		// ("no library targets found in package ...", exit 101) instead of
		// just finding zero doc-tests — so that specific message is treated
		// as a benign no-op rather than a real test failure.
		const { script, arg: manifestArg } = withManifestOverride(
			"manifest=$1; target_dir=$2; rustflags=$3; shift 3; " +
				'out=$(RUSTFLAGS="$rustflags" cargo test --doc --manifest-path "$manifest" --target-dir "$target_dir" "$@" 2>&1); ec=$?; ' +
				'printf "%s\\n" "$out"; ' +
				'case $ec,"$out" in ' +
				"0,*) exit 0 ;; " +
				'*,*"no library targets found"*) exit 0 ;; ' +
				"esac; " +
				"exit $ec",
			manifest,
		);

		// No outputs/materialize: test binaries aren't user-addressable
		// artifacts. No impure flag: a passing run is cached like any other
		// task, replayed on a later run with unchanged inputs; a failing run
		// bails before any cache record is written, so it's guaranteed to
		// rerun next time rather than replaying a stale failure.
		return run({
			argv: [
				"sh",
				"-c",
				script,
				"cargo-test",
				manifestArg,
				`${path}/Cargo.toml`,
				buildDir,
				rustflags,
				...(handle.attrs.workspaceMember ? [] : ["--workspace"]),
				...handle.attrs.testArgs,
			],
			tools: [...rustTools, ...linkerTools, ...cacheTools, ...testTools],
			env: [...rustEnv, ...linkerEnv, ...cacheEnv],
			inputs: [srcs, resourceInputs],
			display: `Run cargo doc-tests for ${path}`,
		});
	},
);

// ---------------------------------------------------------------------------
// Target constructor
// ---------------------------------------------------------------------------

/**
 * Declare a Cargo package target: a self-contained crate, a cargo workspace
 * root (member manifests are globbed via `**\/Cargo.toml`), or one member of
 * an outer workspace declared elsewhere (see `workspaceMember`). `bin` is
 * optional — a lib-only package is a fully valid target for `fmt`/`test`,
 * just not for `build`/`package`.
 *
 * @category target
 * @param {object} opts
 * @param {string} [opts.path="."] Workspace-relative directory containing Cargo.toml.
 * @param {string|string[]} [opts.bin] Binary name(s) cargo produces (matches `[[bin]]`/package name in Cargo.toml). Omit for a lib-only package.
 * @param {boolean} [opts.release=false] Always build with `cargo build --release`,
 *   even when the workspace `opt` mode is `debug`.
 * @param {object|string} [opts.toolchain] Rust toolchain target handle or version string.
 * @param {string[]} [opts.cargoArgs=[]] Extra arguments appended to `cargo build`.
 * @param {string[]} [opts.testArgs=[]] Extra arguments appended to `cargo test`.
 * @param {Array<object>} [opts.testTools=[]] nativeTool() handles exposed on PATH while running `cargo test`.
 * @param {Array<object>} [opts.deps=[]] Extra deps, e.g. a resourcePackage() (see //rules/asset) providing non-.rs files an `include_str!`/`include_bytes!` needs.
 * @param {boolean} [opts.workspaceMember=false] This package is a member of
 *   a cargo workspace rooted in an ancestor directory (not this one) — build/
 *   test/fmt sandbox inputs glob from the repo root instead of just `path`,
 *   so cargo can resolve the enclosing `[workspace]` and any path-deps on
 *   sibling members. Leave false for a self-contained crate or a workspace
 *   root itself.
 * @returns {object} Target handle.
 */
export function cargoPackage({
	path = ".",
	bin,
	release = false,
	toolchain,
	cargoArgs = [],
	testArgs = [],
	testTools = [],
	deps = [],
	workspaceMember = false,
}) {
	return new CargoPackage({
		path,
		bin,
		release,
		toolchain,
		cargoArgs,
		testArgs,
		testTools,
		deps,
		workspaceMember,
	});
}
