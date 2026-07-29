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
	read_file,
	run,
	sourcesField,
	targetAddress,
	targetOutputSlug,
	workspaceTargets,
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

import {
	wholeWorkspaceFor,
	workspaceClosureFor,
	workspaceRootRelativeFor,
} from "//rules/rust/workspace_closure";

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

function declared_workspace_target_path(target) {
	const address = target.address || "//";
	const scope = address.slice(2).split(":")[0] || ".";
	const path = target.attrs.path || ".";
	if (scope === ".") return normalize_workspace_path(path);
	if (path === ".") return scope;
	return normalize_workspace_path(`${scope}/${path}`);
}

function cargo_doctest_enabled(handle) {
	if (typeof handle.attrs.doctest === "boolean") {
		return handle.attrs.doctest;
	}
	const rust = configuration("rust", {}) || {};
	return rust.doctest !== false;
}

// Resolve enabled doc-test package names for one Cargo workspace. Package
// settings override the workspace default. Unrepresented Cargo members use
// that default too, so generated/partially-declared workspaces retain Cargo's
// ordinary `--workspace` coverage.
function workspace_doctest_packages(workspaceRootRelative, docTestNames) {
	const rust = configuration("rust", {}) || {};
	const workspaceDefault = rust.doctest !== false;
	const settings = new Map(
		workspaceTargets(CargoPackage.kind).map((target) => [
			declared_workspace_target_path(target),
			target.attrs.doctest,
		]),
	);
	const prefix =
		workspaceRootRelative === "." ? "" : `${workspaceRootRelative}/`;
	const enabled = [];
	let hasDisabledPackage = false;
	for (const [memberDir, info] of docTestNames) {
		const setting = settings.get(
			normalize_workspace_path(`${prefix}${memberDir}`),
		);
		const isEnabled = typeof setting === "boolean" ? setting : workspaceDefault;
		if (!isEnabled) {
			hasDisabledPackage = true;
			continue;
		}
		// `cargo test --doc -p` errors for a bin-only package, while
		// `--workspace` silently skips it. Only select packages with a lib or
		// proc-macro target when we need an explicit subset.
		if (info.libName) enabled.push(info.packageName);
	}
	return { enabled, hasDisabledPackage };
}

// ---------------------------------------------------------------------------
// Source discovery
// ---------------------------------------------------------------------------

// Just the crate's .rs files — used by fmt, which only ever reformats source
// files (not Cargo.toml/Cargo.lock).
export const rust_file_sources = memo(
	async function rust_file_sources(handle) {
		const root = declared_path(handle, handle.attrs.path || ".");
		return glob({ root, include: ["**/*.rs"], exclude: ["target/**"] });
	},
	{ display: "Rust file sources {0}", level: "debug" },
);

// Everything cargo build needs to see: manifests, lockfile, and sources.
//
// A crate declared with `workspaceMember: true` (set by
// //rules/rust/generate_build.js when `cargo metadata` reports its
// workspace_root as an ancestor directory, not itself) needs cargo to
// resolve the real `[workspace]` it belongs to — cargo walks up from
// --manifest-path to find the enclosing workspace manifest, and (since
// workspace members here declare real path-dependencies on each other,
// e.g. crates/imp-execution on crates/imp-store) needs every crate in
// its transitive path-dependency closure visible too, plus enough of every
// *other* real member to resolve the workspace at all: a manifest + its
// declared targets' entry-point files (see
// //rules/rust/workspace_closure's docstring for why this "shallow" set is
// enough, and why it replaced synthesizing a narrowed manifest — the real,
// unmodified root Cargo.toml/Cargo.lock stay valid input as-is, so
// `--locked` on cargoBuild/cargoTest/cargoClippy/buildTestBinaries is never
// fighting a lockfile trim cargo would otherwise want to do).
//
// A standalone crate (no `workspaceMember`) must stay scoped to its own
// directory: including an *unrelated* ancestor `[workspace]` manifest that
// doesn't list it as a member makes cargo fail with "current package
// believes it's in a workspace when it's not" (confirmed directly against
// rules/rust/example, which sits under this repo's own root Cargo.toml but
// isn't one of its `members`).
//
// @returns {Promise<{ files: FileSet }>}
export const sources = memo(
	async function sources(handle) {
		const path = declared_path(handle, handle.attrs.path || ".");
		if (!handle.attrs.workspaceMember) {
			return {
				files: glob({
					root: path,
					include: ["**/Cargo.toml", "Cargo.lock", "**/*.rs"],
					exclude: ["target/**"],
				}),
			};
		}

		const toolchainVersion = rust_toolchain_version(handle);
		const { dirs, shallowFiles, workspaceRootRelative } =
			await workspaceClosureFor(path, toolchainVersion);
		const prefix =
			workspaceRootRelative === "." ? "" : `${workspaceRootRelative}/`;
		const include = dirs.flatMap((dir) => [
			`${prefix}${dir}/Cargo.toml`,
			`${prefix}${dir}/**/*.rs`,
		]);
		include.push(`${prefix}Cargo.toml`, `${prefix}Cargo.lock`, ...shallowFiles);
		return {
			files: glob({ root: ".", include, exclude: ["target/**"] }),
		};
	},
	{ display: "sources {0}", level: "debug" },
);

// Full source for every real member of the same workspace, not just one
// crate's own closure — for the shared whole-workspace lint/test-build
// tasks (see wholeWorkspaceFor's docstring, //rules/rust/workspace_closure,
// for why lint/test stopped fanning out one cargo invocation per crate).
export async function wholeWorkspaceSources(
	workspaceRootRelative,
	toolchainVersion,
) {
	const { memberDirs } = await wholeWorkspaceFor(
		workspaceRootRelative,
		toolchainVersion,
	);
	const prefix =
		workspaceRootRelative === "." ? "" : `${workspaceRootRelative}/`;
	const include = memberDirs.flatMap((dir) => [
		`${prefix}${dir}/Cargo.toml`,
		`${prefix}${dir}/**/*.rs`,
	]);
	include.push(`${prefix}Cargo.toml`, `${prefix}Cargo.lock`);
	return {
		files: glob({ root: ".", include, exclude: ["target/**"] }),
		memberDirs,
	};
}

// FileSet of a cargoPackage's declared resource-package deps (see
// //rules/asset's resourcePackage) — same pattern rules/odin/index.js's
// `resources` uses, minus the transitive-package-dep recursion (a
// cargoPackage has no notion of depending on another cargoPackage the way
// an odinPackage depends on other odin-package targets; Cargo itself owns
// crate-to-crate deps via Cargo.toml/the registry).
export const resources = memo(
	async function resources(handle) {
		const sets = (hydrateTarget(handle).deps || [])
			.map((dep) => dep.handle)
			.filter((dep) => dep && dep.kind === "resource-package");
		if (sets.length === 0) return file_set.literal([]);
		const resolved = await Promise.all(sets.map(resource_package_sources));
		return resolved.length === 1 ? resolved[0] : file_set.union(...resolved);
	},
	{ display: "Rust resources {0}", level: "debug" },
);

// Union of resources() across every declared cargo-package target whose
// own directory is one of `dirs` — used by the shared whole-workspace
// lint/test-build tasks (rules/rust/lint.js, rules/rust/test.js), which
// compile every member of a real workspace in one cargo invocation and so
// need every member's resource-package inputs, not just the one crate that
// happened to trigger the shared task.
export async function resourcesForDirs(dirs) {
	const dirSet = new Set(dirs);
	const handles = workspaceTargets("cargo-package")
		.map(({ handle }) => handle)
		.filter((h) => dirSet.has(declared_path(h, h.attrs.path || ".")));
	if (handles.length === 0) return file_set.literal([]);
	const sets = await Promise.all(handles.map(resources));
	return sets.length === 1 ? sets[0] : file_set.union(...sets);
}

// Union of every declared cargo-package target's own testTools within
// `dirs` — same rationale as resourcesForDirs above, for the shared
// whole-workspace doc-test run (runWorkspaceDocTests below), which actually
// *runs* every member's doc-tests in one process and so needs every
// member's own testTools on PATH, not just the one crate that happened to
// trigger the shared task. Deduplicated by target handle identity: a
// testTools entry is always a shared target-constant reference (e.g.
// rules/imp/native_tool's testTar/testGzip/testGit, imported by every
// BUILD.js that uses them), so reference equality is enough — no two
// distinct nativeTool() targets are ever meant to collapse into one mount.
async function testToolsForDirs(dirs) {
	const dirSet = new Set(dirs);
	const handles = workspaceTargets("cargo-package")
		.map(({ handle }) => handle)
		.filter((h) => dirSet.has(declared_path(h, h.attrs.path || ".")));
	const seen = new Set();
	const specs = [];
	for (const h of handles) {
		for (const toolHandle of h.attrs.testTools || []) {
			if (seen.has(toolHandle)) continue;
			seen.add(toolHandle);
			specs.push(await nativeToolSpec(toolHandle));
		}
	}
	return specs;
}

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
			"cargo builds need the GCC rule default or a rustToolchain({ linkDriver }) — see //rules/c/gcc",
		);
	}
	const linkDriver = await productFor(linkDriverHandle, RUST_LINK_DRIVER);

	const linkerHandle = toolchainHandle && toolchainHandle.attrs.linker;
	const linker = linkerHandle
		? await productFor(linkerHandle, RUST_LINKER)
		: null;

	const kacheActive = !!(toolchainHandle && toolchainHandle.attrs.kache);
	const tools = [
		...(await linkDriver.tools()),
		...(linker ? await linker.tools() : []),
	];
	const rustflags = [
		...(await linkDriver.rustflags()),
		...(linker ? await linker.rustflags() : []),
	].join(" ");
	const env = await linkDriver.env(kacheActive);
	return { tools, rustflags, env };
}

// Optional rustc build-caching layer (e.g. kache, //rules/rust/kache),
// wired independently of the linker abstraction above since it wraps rustc
// itself rather than the link step. Opt in via
// rustToolchain({ kache: kacheToolchain() }); no-ops otherwise.
export async function rustBuildCacheTools(toolchainHandle) {
	const kacheHandle = toolchainHandle && toolchainHandle.attrs.kache;
	if (!kacheHandle) {
		return { tools: [], env: [], scriptPreamble: "" };
	}
	const wrapper = await productFor(kacheHandle, RUST_BUILD_CACHE);
	return {
		tools: await wrapper.tools(),
		env: await wrapper.env(),
		scriptPreamble: wrapper.scriptPreamble(),
	};
}

// Shared script building blocks for cargoBuild/cargoTest/cargoClippy/
// buildTestBinaries: all four invoke cargo the same way (a manifest/
// target-dir/rustflags positional trio, then command-specific args), and all
// four need the same sandbox-root capture once a build-cache layer (e.g.
// kache) needs it — see RustKacheWrapper.scriptPreamble()'s doc comment
// for why that capture has to happen in script text rather than via run()'s
// own env:.
//
// `imp_sandbox_root` is captured unconditionally (cheap, and $(pwd) is
// always the sandbox root here — none of the four callers `cd` before
// invoking cargo) so scriptPreamble/remap can both stay simple string
// splices instead of each needing their own conditional capture.
export function cargoScriptPreamble(scriptPreamble = "") {
	return (
		'imp_sandbox_root="$(pwd)"; manifest=$1; target_dir=$2; rustflags=$3; shift 3; ' +
		scriptPreamble
	);
}

// Appended to rustc's args (via RUSTFLAGS) when kache is active: keeps the
// volatile sandbox path out of rustc's own diagnostics/debug info, and
// kache recognizes --remap-path-prefix and folds it into its own
// cache-key normalization alongside KACHE_BASE_DIR.
export function cargoRemapFlag(kacheActive) {
	return kacheActive
		? ' --remap-path-prefix="$imp_sandbox_root"=/imp-src'
		: "";
}

// The common case: `cargoScriptPreamble` followed by one RUSTFLAGS-prefixed
// cargo invocation. cargoTest's doc-test script wraps its cargo invocation
// in extra shell logic, so it composes cargoScriptPreamble/cargoRemapFlag
// directly instead of using this helper.
export function cargoInvocationScript(cargoCommand, opts = {}) {
	return (
		cargoScriptPreamble(opts.scriptPreamble) +
		`RUSTFLAGS="$rustflags${cargoRemapFlag(opts.kacheActive)}" ${cargoCommand}`
	);
}

// Resolve RUSTUP_HOME/CARGO_HOME/PATH for invoking cargo/rustc.
//
// Normally these are sandbox-relative "tool" mount aliases (toolSpec.tools +
// toolSpec.rustupHome/cargoHome) — reproducible and explicitly tracked as
// build inputs, per the sandbox's usual hermeticity model.
//
// When kache is wrapping rustc, that per-sandbox aliasing itself becomes a
// risk: a long-lived compiler-cache daemon like kache's can cache detected
// "compiler info" keyed by the *canonicalized* exe path (resolving the
// sandbox symlink down to the same real, stable toolchain directory every
// time — this is exactly the class of bug sccache had in its own
// src/server.rs `compiler_info()`), but the *literal* (uncanonicalized) exe
// path embedded in that cached entry — the one actually used to spawn the
// compiler on a cache miss — would be whichever sandbox's path happened to
// be seen first. Once that first sandbox is torn down, every later build
// sharing the same daemon would fail with "No such file or directory" trying
// to invoke a compiler at a path that no longer exists, even though the
// exact same toolchain is trivially reachable via the *current* sandbox's
// own (different) symlink.
//
// The fix is to make the literal exe path identical across every sandbox in
// the first place: when kache is active, resolve cargo/rustc through the
// real, absolute, stable named-cache directory (toolSpec.rustupHomeAbs/
// cargoHomeAbs) instead of the sandbox-relative alias, and skip mounting
// the sandbox "tool" copies at all — mirroring the same real-path-over-
// sandbox-mount tradeoff already made for kache's own data directory (see
// kacheDataDir() in //rules/rust/kache/toolchain).
export function rustToolEnv(toolSpec, kacheActive) {
	if (!kacheActive) {
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

async function runCargoBuild({
	path,
	bins,
	cargoArgs,
	release,
	toolchainHandle,
	toolchainVersion,
	outputSlug,
	srcs,
	resourceInputs,
}) {
	if (bins.length === 0) {
		return { outputPaths: [] };
	}
	const toolSpec = await rustTool(toolchainVersion);
	const kacheActive = !!(toolchainHandle && toolchainHandle.attrs.kache);
	const {
		tools: linkerTools,
		rustflags,
		env: linkerEnv,
	} = await rustLinkerTools(toolchainHandle);
	const {
		tools: cacheTools,
		env: cacheEnv,
		scriptPreamble,
	} = await rustBuildCacheTools(toolchainHandle);
	const { tools: rustTools, env: rustEnv } = rustToolEnv(toolSpec, kacheActive);

	const profile = release ? "release" : "debug";
	const buildDir = output_path(`build/rust/${outputSlug}`);
	const plat = platformInfo();
	const exeSuffix = plat.os === "windows" ? ".exe" : "";
	const outPaths = bins.map(
		(name) => `${buildDir}/${profile}/${name}${exeSuffix}`,
	);

	const script = cargoInvocationScript(
		'cargo build --locked --manifest-path "$manifest" --target-dir "$target_dir" "$@"',
		{ scriptPreamble, kacheActive },
	);

	const result = await run({
		argv: [
			"sh",
			"-c",
			script,
			"cargo-build",
			`${path}/Cargo.toml`,
			buildDir,
			rustflags,
			...(release ? ["--release"] : []),
			...cargoArgs,
		],
		tools: [...rustTools, ...linkerTools, ...cacheTools],
		env: [...rustEnv, ...linkerEnv, ...cacheEnv],
		inputs: [srcs, resourceInputs],
		outputs: outPaths.map((p) => output(output_path(p))),
		materialize: false,
		display: `cargo build ${path}`,
	});

	return { ...result, outputPaths: outPaths, buildDir };
}

export const cargoBuild = product(
	CargoPackage,
	BUILD,
	RUST_TOOL,
	async function cargoBuild(handle) {
		const path = declared_path(handle, handle.attrs.path || ".");
		const { files: srcs } = await sources(handle);
		const resourceInputs = await resources(handle);
		const toolchainHandle = handle.attrs.toolchain || defaultRustToolchain();

		// A target-local release opt-in remains authoritative, while a workspace
		// may supply the ordinary debug/release default through its opt axis.
		// Read the namespace directly so the reusable Rust rules keep their
		// existing debug behavior in workspaces that do not declare that axis.
		const mode = configuration("imp.mode", {}) || {};
		const release = handle.attrs.release || mode.opt === "release";

		return runCargoBuild({
			path,
			bins: handle.attrs.bins,
			cargoArgs: handle.attrs.cargoArgs,
			release,
			toolchainHandle,
			toolchainVersion: rust_toolchain_version(handle),
			outputSlug: targetOutputSlug(handle),
			srcs,
			resourceInputs,
		});
	},
	{ display: "build {0}", level: "info" },
);

function readFileOrNull(path) {
	try {
		return read_file(path);
	} catch {
		return null;
	}
}

function deriveBinsFromCargoToml(path) {
	const text = readFileOrNull(`${path}/Cargo.toml`);
	if (text == null) {
		throw new Error(`no Cargo.toml at ${path}`);
	}
	let section = null;
	const explicitBins = [];
	let packageName = null;
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line.startsWith("[")) {
			section = line;
			continue;
		}
		const nameMatch = line.match(/^name\s*=\s*"([^"]+)"/);
		if (!nameMatch) continue;
		if (section === "[[bin]]") explicitBins.push(nameMatch[1]);
		else if (section === "[package]" && packageName == null)
			packageName = nameMatch[1];
	}
	if (explicitBins.length > 0) return explicitBins;
	if (packageName && readFileOrNull(`${path}/src/main.rs`) != null) {
		return [packageName];
	}
	return [];
}

// Plain-data action used by the exported-label Rust factory. It is not a CLI
// entry point: command-line selection goes through a label and its goal
// handler. Explicit options come from the factory declaration; there is no
// parallel path-keyed build.js configuration.
export const cargoBuildPath = memo(
	async function cargoBuildPath(path, opts = {}) {
		const mode = configuration("imp.mode", {}) || {};
		const toolchainHandle = defaultRustToolchain();
		return runCargoBuild({
			path,
			bins: opts.bins || deriveBinsFromCargoToml(path),
			cargoArgs: opts.cargoArgs || [],
			release: opts.release ?? mode.opt === "release",
			toolchainHandle,
			toolchainVersion: toolchainHandle.attrs.version,
			outputSlug: path.replace(/\//g, "_"),
			srcs: glob({
				root: path,
				include: ["**/Cargo.toml", "Cargo.lock", "**/*.rs"],
				exclude: ["target/**"],
			}),
			resourceInputs: file_set.literal([]),
		});
	},
	{ display: "build {0}", level: "info" },
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
	{ display: "package {0}", level: "info" },
);

// Parses `cargo test --doc --workspace --no-fail-fast` stderr for per-crate
// attribution. Doc-tests have no `--message-format=json` equivalent (an
// upstream cargo limitation — unlike clippy, there's no structured output
// mode for `--doc`), so this relies on two distinct textual markers cargo
// prints instead:
//
//   - a `   Doc-tests <lib_name>` status header once per package cargo
//     actually attempted (confirmed directly: cargo pads every status verb
//     to the same column, so leading whitespace varies — 3 spaces for
//     "Doc-tests", 4 for "Finished", etc. — hence the flexible `\s*`).
//     `lib_name` is the lib/proc-macro target's own name, always
//     underscored (e.g. "imp_daemon"), NOT the package name.
//   - a `` `-p <package_name> --doc` `` reference once per package whose
//     doc-tests failed — printed both inline right after that package's own
//     failure and again in the trailing "N targets failed" summary, so a
//     global match naturally dedupes via the Set. `package_name` here is
//     the literal package name (hyphens intact, as declared in Cargo.toml)
//     — never interchangeable with the header's underscored lib_name.
//
// @param {string} stderr
// @returns {{ attemptedLibNames: Set<string>, failedPackageNames: Set<string> }}
export function parseDocTestOutput(stderr) {
	const attemptedLibNames = new Set(
		[...stderr.matchAll(/^\s*Doc-tests (\S+)\s*$/gm)].map((m) => m[1]),
	);
	const failedPackageNames = new Set(
		[...stderr.matchAll(/`-p (\S+) --doc`/g)].map((m) => m[1]),
	);
	return { attemptedLibNames, failedPackageNames };
}

// Shared, memoized `cargo test --doc --workspace --no-fail-fast` run for one
// real workspace root + toolchain configuration — or the enabled package
// subset when a package opts out — same collapsing rationale
// as runWorkspaceClippy (rules/rust/lint.js) and buildWorkspaceTestBinaries
// (rules/rust/test.js): every workspaceMember crate's own doc-test
// invocation would otherwise independently recompile the same internal
// dependency graph from an empty per-sandbox target-dir, once per crate
// that (transitively) depends on it, instead of once for the whole real
// workspace.
//
// `--no-fail-fast` is load-bearing, not cosmetic: plain `cargo test --doc
// --workspace` stops at the very first package whose doc-tests fail and
// never even attempts any package ordered after it — confirmed directly
// against real cargo (1.94), not assumed. Without it, one crate's doctest
// failure would silently swallow every later crate's doctest result for
// that run: a real regression from today's fully independent per-crate
// invocations, not just lost signal.
//
// Uses its own `build/rust-doctest/` tree rather than reusing
// buildWorkspaceTestBinaries'/cargoBuild's `build/rust/` — purely for
// output-path/log hygiene (matching runWorkspaceClippy's own
// `build/rust-clippy/` tree), not to avoid any lock contention: every
// run() executes in its own ephemeral sandbox (see
// crates/imp-execution/src/exec.rs), so a `target_dir` argument is never
// actually shared storage between concurrent invocations unless explicitly
// bound through a `named_cache` — which none of these are.
const runWorkspaceDocTests = memo(
	async function runWorkspaceDocTests(
		workspaceRootRelative,
		toolchainVersion,
		toolchainHandle,
	) {
		const toolSpec = await rustTool(toolchainVersion);
		const kacheActive = !!(toolchainHandle && toolchainHandle.attrs.kache);
		const {
			tools: linkerTools,
			rustflags,
			env: linkerEnv,
		} = await rustLinkerTools(toolchainHandle);
		const {
			tools: cacheTools,
			env: cacheEnv,
			scriptPreamble,
		} = await rustBuildCacheTools(toolchainHandle);
		const { tools: rustTools, env: rustEnv } = rustToolEnv(
			toolSpec,
			kacheActive,
		);

		const { memberDirs, docTestNames } = await wholeWorkspaceFor(
			workspaceRootRelative,
			toolchainVersion,
		);
		const { enabled, hasDisabledPackage } = workspace_doctest_packages(
			workspaceRootRelative,
			docTestNames,
		);
		if (hasDisabledPackage && enabled.length === 0) {
			return {
				result: null,
				docTestNames,
				attemptedLibNames: new Set(),
				failedPackageNames: new Set(),
			};
		}
		const { files: srcs } = await wholeWorkspaceSources(
			workspaceRootRelative,
			toolchainVersion,
		);
		const resourceInputs = await resourcesForDirs(memberDirs);
		const testTools = await testToolsForDirs(memberDirs);

		const prefix =
			workspaceRootRelative === "." ? "" : `${workspaceRootRelative}/`;
		const cargoArgs = hasDisabledPackage
			? enabled.flatMap((packageName) => ["-p", packageName])
			: ["--workspace"];
		const script = cargoInvocationScript(
			'cargo test --locked --doc --no-fail-fast --manifest-path "$manifest" ' +
				'--target-dir "$target_dir" "$@"',
			{ scriptPreamble, kacheActive },
		);

		const result = await run({
			argv: [
				"sh",
				"-c",
				script,
				"cargo-doctest-workspace",
				`${prefix}Cargo.toml`,
				`build/rust-doctest/${workspaceRootRelative === "." ? "root" : workspaceRootRelative}`,
				rustflags,
				...cargoArgs,
			],
			tools: [...rustTools, ...linkerTools, ...cacheTools, ...testTools],
			env: [...rustEnv, ...linkerEnv, ...cacheEnv],
			inputs: [srcs, resourceInputs],
			allowFailure: true,
			display: `cargo test --doc ${cargoArgs.join(" ")} ${workspaceRootRelative}`,
		});

		const { attemptedLibNames, failedPackageNames } = parseDocTestOutput(
			result.stderr,
		);

		return { result, docTestNames, attemptedLibNames, failedPackageNames };
	},
	{ display: "workspace doc tests {0}", level: "debug" },
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
 * A `workspaceMember` crate's doc-tests run as one shared, memoized `cargo
 * test --doc --workspace` invocation per real workspace root (see
 * runWorkspaceDocTests above), attributed back to this one crate by name —
 * same reasoning and precedent as cargoClippy/runWorkspaceClippy
 * (rules/rust/lint.js). A standalone crate has no workspace to share a run
 * with, so it keeps the simple per-crate `cargo test --doc` invocation.
 *
 * @param {object} handle Target handle returned by cargoPackage().
 * @returns {Promise<object>} Run result from `cargo test --doc`.
 */
export const cargoTest = product(
	CargoPackage,
	TEST,
	RUST_TOOL,
	async function cargoTest(handle) {
		if (!cargo_doctest_enabled(handle)) {
			return null;
		}
		const path = declared_path(handle, handle.attrs.path || ".");
		const toolchainVersion = rust_toolchain_version(handle);
		const toolchainHandle = handle.attrs.toolchain || defaultRustToolchain();

		if (handle.attrs.workspaceMember) {
			const workspaceRootRelative = await workspaceRootRelativeFor(
				path,
				toolchainVersion,
			);
			const { result, docTestNames, attemptedLibNames, failedPackageNames } =
				await runWorkspaceDocTests(
					workspaceRootRelative,
					toolchainVersion,
					toolchainHandle,
				);

			const info = docTestNames.get(path);
			if (!info || !info.libName || result === null) {
				// No lib/proc-macro target (e.g. a bin-only crate) — cargo
				// silently skips it under `--workspace` (confirmed directly;
				// unlike naming it explicitly via a standalone `--doc`
				// invocation, which hard-errors — see the standalone branch
				// below), so there's nothing to attribute and nothing failed.
				return result;
			}

			const context =
				`cargo test --doc ${workspaceRootRelative} (shared run):\n\n` +
				`${result.stdout}\n${result.stderr}`;

			if (failedPackageNames.has(info.packageName)) {
				throw new Error(
					`doc-tests failed for ${info.packageName} (//${path}):\n\n${context}`,
				);
			}
			if (!attemptedLibNames.has(info.libName)) {
				// Has a lib target but never got its own "Doc-tests" header —
				// the shared run hit a real compile error before reaching this
				// crate. Don't claim a clean pass; surface the whole run so the
				// actual problem is visible (mirrors cargoClippy's same
				// fallback for an unattributed non-zero exit).
				throw new Error(
					`doc-tests for ${info.packageName} (//${path}) were never reached — ` +
						`likely a compile error elsewhere in the shared workspace run:\n\n${context}`,
				);
			}
			return result;
		}

		// Standalone (non-workspaceMember) crate: no workspace to share a run
		// with, so this stays a simple per-crate `cargo test --doc`
		// invocation.
		const toolSpec = await rustTool(toolchainVersion);
		const kacheActive = !!(toolchainHandle && toolchainHandle.attrs.kache);
		const {
			tools: linkerTools,
			rustflags,
			env: linkerEnv,
		} = await rustLinkerTools(toolchainHandle);
		const {
			tools: cacheTools,
			env: cacheEnv,
			scriptPreamble,
		} = await rustBuildCacheTools(toolchainHandle);
		const { tools: rustTools, env: rustEnv } = rustToolEnv(
			toolSpec,
			kacheActive,
		);
		const testTools = await Promise.all(
			(handle.attrs.testTools || []).map(nativeToolSpec),
		);

		const { files: srcs } = await sources(handle);
		const resourceInputs = await resources(handle);
		const buildDir = output_path(`build/rust/${path === "." ? "root" : path}`);

		// --workspace: this standalone crate's own manifest may itself be a
		// workspace root (e.g. rules/rust/example), in which case its own
		// members' doc-tests should run too; on a plain single-package
		// manifest it's a no-op.
		//
		// A bin-only crate (no `[lib]` target) has no doc-tests by
		// definition, but `cargo test --doc` still hard-errors on it
		// ("no library targets found in package ...", exit 101) instead of
		// just finding zero doc-tests — so that specific message is treated
		// as a benign no-op rather than a real test failure.
		const script =
			cargoScriptPreamble(scriptPreamble) +
			`out=$(RUSTFLAGS="$rustflags${cargoRemapFlag(kacheActive)}" cargo test --locked --doc --manifest-path "$manifest" --target-dir "$target_dir" "$@" 2>&1); ec=$?; ` +
			'printf "%s\\n" "$out"; ' +
			'case $ec,"$out" in ' +
			"0,*) exit 0 ;; " +
			'*,*"no library targets found"*) exit 0 ;; ' +
			"esac; " +
			"exit $ec";

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
				`${path}/Cargo.toml`,
				buildDir,
				rustflags,
				"--workspace",
				...handle.attrs.testArgs,
			],
			tools: [...rustTools, ...linkerTools, ...cacheTools, ...testTools],
			env: [...rustEnv, ...linkerEnv, ...cacheEnv],
			inputs: [srcs, resourceInputs],
			display: `Run cargo doc-tests for ${path}`,
		});
	},
	{ display: "test {0}", level: "info" },
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
 * @param {boolean} [opts.doctest] Override the workspace `rustConfig.doctest`
 *   setting for this package.
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
	doctest,
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
		doctest,
		workspaceMember,
	});
}
