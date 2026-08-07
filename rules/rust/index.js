// Canonical Rust rule entrypoint (graph-native).
//
// cargoPackage() builds a task()/expand() graph: [BUILD]/[PACKAGE] are
// per-crate tasks defined here; [LINT]/[FMT]/[TEST] delegate to
// workspace_expansion.js's keyed expand() (one shared cargo invocation per
// real workspace, attributed per crate — see that module's docstring).
//
// The linker/link-driver roles (gcc, mold) are graph-native as of #60:
// rustLinkerTools() consumes gccGraphToolchain()/moldGraphToolchain()
// (//rules/c/gcc, //rules/c/mold) directly via linkerHandlesFor() below.
// Both resolve to the real, absolute, stable named-cache path for their
// respective toolchain (via cacheGet()) rather than a produced tool()
// binding's sandbox-relative exec.tool()/exec.path() alias — a relative
// `-C linker=<path>`/`-fuse-ld=<path>` breaks in practice, confirmed by a
// real `imp lint //crates/imp:imp` failure (rustc's linker subprocess isn't
// guaranteed to run with the sandbox root as its cwd) — see
// gccRustLinkDriverEnv()/moldRustLinkerEnv()'s docstrings for the details,
// including why mold's flag additionally has to stay in its legacy bare
// `-fuse-ld=mold` PATH-search form (this repo's gcc build rejects an
// absolute `-fuse-ld=` value outright).
//
// The build-cache role (RUST_BUILD_CACHE, kache) is explicitly out of scope
// for #31/#60 — rustBuildCacheTools() still resolves it dynamically via
// productFor() against rules/rust/kache's legacy RustKacheWrapper. Its
// already-resolved legacy tool-spec result ({name, cache, key, binDirs})
// passes straight through exec.action()'s tools: array unchanged (the
// engine's legacy-tool-spec passthrough, graph_core.js's addTool).
//
// Known simplifications versus the pre-migration factory:
//   - `bin` auto-detection from Cargo.toml is not ported; omitting `bin`
//     means "no binaries" (lib-only). Every real crates/*/BUILD.js in this
//     repo either omits `bin` (lib-only) or declares it explicitly
//     (crates/imp/BUILD.js), so this is not a regression here.
//   - A workspaceMember crate's BUILD/PACKAGE inputs use the whole-repo
//     source glob (manifestSources(".")) rather than a narrowed
//     transitive-dependency closure — correct, but coarser build-cache
//     granularity. Assumes the real workspace root is "." (true for this
//     repo).
//   - No per-package `doctest` override (workspace_expansion.js respects
//     only the workspace-wide `rustConfig.doctest` default). No real crate
//     here uses a per-package override today.

import {
	BUILD,
	FMT,
	LINT,
	PACKAGE,
	TEST,
	file,
	files,
	output,
	packagePath,
	platformInfo,
	productFor,
	task,
} from "imp:core";

import { RUST_BUILD_CACHE } from "//rules/rust/products";
import {
	defaultRustToolchain,
	rustGraphToolEnv,
	rustGraphToolchain,
} from "//rules/rust/toolchain";

import { nativeTool, nativeToolSpec } from "//rules/imp/native-tool";

import { defaultGccGraphToolchain, gccRustLinkDriverEnv } from "//rules/c/gcc";
import { moldRustLinkerEnv } from "//rules/c/mold";

import {
	cargoStandaloneExpansion,
	cargoWorkspaceExpansion,
} from "//rules/rust/workspace_expansion";

// Registers the "build" goal's artifact summary callback for consumers that
// import Rust build rules without importing the workflows layer explicitly.
import "//rules/workflows/build";

// Registers the direct "generate-build" callback (declaring cargoPackage()
// declarations for unowned Cargo.toml files) for the same reason.
import "//rules/rust/generate_build";

// ---------------------------------------------------------------------------
// Linker / build-cache bridging (unchanged bridging spirit; see module
// docstring above)
// ---------------------------------------------------------------------------

// cargo/rustc need a real C link driver in the hermetic sandbox — rustc
// shells out to a program literally named "cc" by default. Reuse the gcc
// toolchain Odin already relies on for the same reason (rules/odin/index.js's
// odinScriptTools): gccRustLinkDriverEnv() resolves a "clang"-named wrapper
// script's absolute path that execs the real (prefixed) gcc binary, so
// pointing rustc's linker at it sidesteps needing a "cc" alias of our own. A
// workspace can additionally opt into a faster backend linker (e.g. mold)
// via rustToolchain({ linker: moldGraphToolchain() }); by default no extra
// -fuse-ld= flag is added.
//
// Windows has no pinned toolchain to plug into this abstraction (the Bootlin
// gcc archive is Linux-only) — it always uses the host's own MinGW gcc,
// discovered via PATH, regardless of any declared rustToolchain/linkDriver.
//
// Resolve the graph-native gcc/mold link-driver/linker handles for a Rust
// toolchain's legacy .attrs.linkDriver/.attrs.linker (or gcc's own default).
// Must run at graph-construction time, never inside a task's run() body:
// gccGraphToolchain()/defaultGccGraphToolchain() call task() internally,
// which task() itself forbids once execution has started. See
// linkerToolInputs() below for threading the resulting `.tool` handles
// through a task's own `inputs:` so toolEnvAndTools() can resolve them at
// run time without re-deriving these records.
export function linkerHandlesFor(legacyToolchainHandle) {
	if (platformInfo().os === "windows") {
		return { gcc: null, mold: null };
	}
	const gcc =
		(legacyToolchainHandle && legacyToolchainHandle.attrs.linkDriver) ||
		defaultGccGraphToolchain();
	if (!gcc) {
		throw new Error(
			"cargo builds need the GCC rule default or a rustToolchain({ linkDriver }) — see //rules/c/gcc",
		);
	}
	const mold =
		(legacyToolchainHandle && legacyToolchainHandle.attrs.linker) || null;
	return { gcc, mold };
}

// Lazily computes and caches linkerHandlesFor()'s result on `specLike`
// (crateSpec()'s own spec object, or workspace_expansion.js's toolchainSpec)
// the first time it's actually needed — a lib-only cargoPackage() (no
// [BUILD]/[PACKAGE]) never touches this, so it never needs a declared gcc
// default, matching the pre-migration factory's equally lazy
// (run()-time-only) gcc resolution. Safe to call repeatedly (idempotent,
// content-addressed task() dedup) but memoized anyway so a single spec's
// gcc/mold handles are computed once and reused by every task built from it.
export function linkerHandlesForSpec(specLike) {
	if (!specLike.linkerHandles) {
		specLike.linkerHandles = linkerHandlesFor(specLike.legacyToolchainHandle);
	}
	return specLike.linkerHandles;
}

// The task()-input slice contributed by linkerHandlesFor()'s result — merge
// into any task's own `inputs:` map (crateBuildTask below, or
// workspace_expansion.js's clippy/testBuild/fmt/doctest tasks) so the graph
// scheduler orders gcc/mold's install tasks first and toolEnvAndTools() can
// resolve them inside run() via exec.tool().
export function linkerToolInputs(linkerHandles) {
	return {
		...(linkerHandles.gcc
			? { gccTool: linkerHandles.gcc.tool, dirnameTool: nativeTool("dirname") }
			: {}),
		...(linkerHandles.mold ? { moldTool: linkerHandles.mold.tool } : {}),
	};
}

export async function rustLinkerTools(exec, input, linkerHandles, kacheActive) {
	if (platformInfo().os === "windows") {
		return {
			tools: [await nativeToolSpec(nativeTool("gcc"))],
			rustflags: "-C linker=gcc",
			env: [],
			pathDirs: [],
		};
	}
	const gccResult = gccRustLinkDriverEnv(
		exec,
		input.gccTool,
		linkerHandles.gcc.version,
		kacheActive,
	);
	const moldResult = linkerHandles.mold
		? moldRustLinkerEnv(exec, input.moldTool, linkerHandles.mold.version)
		: null;
	return {
		// Always mounted, even when kache is active: rustc still resolves
		// "clang" via PATH itself for the *link* step (its own direct
		// subprocess spawn, not something kache wraps/caches), and that
		// wrapper script does `exec "$(dirname "$0")/..." "$@"` — mirrors
		// the legacy RustGccLinkDriver.tools()'s own dirname mount above.
		tools: [input.dirnameTool],
		rustflags: [
			...gccResult.rustflags,
			...(moldResult ? moldResult.rustflags : []),
		].join(" "),
		env: gccResult.env,
		pathDirs: [
			...gccResult.pathDirs,
			...(moldResult ? moldResult.pathDirs : []),
		],
	};
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

// Shared script building blocks for the cargo build task below: a manifest/
// target-dir/rustflags positional trio, then command-specific args, plus the
// sandbox-root capture a build-cache layer (e.g. kache) needs — see
// RustKacheWrapper.scriptPreamble()'s doc comment for why that capture has to
// happen in script text rather than via exec.action()'s own env.
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
	return kacheActive ? ' --remap-path-prefix="$imp_sandbox_root"=/imp-src' : "";
}

// The common case: cargoScriptPreamble followed by one RUSTFLAGS-prefixed
// cargo invocation.
export function cargoInvocationScript(cargoCommand, opts = {}) {
	return (
		cargoScriptPreamble(opts.scriptPreamble) +
		`RUSTFLAGS="$rustflags${cargoRemapFlag(opts.kacheActive)}" ${cargoCommand}`
	);
}

// ---------------------------------------------------------------------------
// cargoPackage() registry — declaration order, read by generate_build's
// dedup check and by workspace_expansion.js's per-crate testTools lookup
// (see testToolsForDir there). Mirrors rules/odin/index.js's graphPackages.
// ---------------------------------------------------------------------------

const _cargoPackageSpecs = [];

export function cargoPackageHandles() {
	return _cargoPackageSpecs.slice();
}

// ---------------------------------------------------------------------------
// cargoPackage() factory
// ---------------------------------------------------------------------------

function normalizeWorkspacePath(path) {
	const parts = [];
	for (const part of (path || ".").split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			throw new Error(`Rust paths must stay within the workspace: ${path}`);
		}
		parts.push(part);
	}
	return parts.length === 0 ? "." : parts.join("/");
}

function manifestSources(root) {
	return files({
		root,
		include: ["**/Cargo.toml", "Cargo.lock", "**/*.rs"],
		exclude: ["target/**"],
	});
}

function outputSlugFor(path) {
	return path === "." ? "root" : path.replace(/\//g, "_");
}

// A bare toolchain option is either a rustGraphToolchain()-shaped record
// (identified by its unique `toolchainId` field — a raw tool()/task() handle
// also has `__imp_graph_handle === true`, so that alone can't distinguish
// the two), a legacy RustToolchain target handle (has .attrs.version and
// optionally .linkDriver/.linker/.kache — the only source of those for the
// productFor() bridge above), a plain version string, or omitted (workspace
// default). The legacy handle, when given, is kept around unresolved purely
// so rustLinkerTools()/rustBuildCacheTools() can still read its attrs — it
// is never passed into a task() input.
function resolveToolchain(toolchain) {
	if (toolchain && typeof toolchain.toolchainId === "string") {
		return { graph: toolchain, legacy: null };
	}
	if (toolchain && toolchain.__imp === true) {
		return {
			graph: rustGraphToolchain(toolchain.attrs.version),
			legacy: toolchain,
		};
	}
	if (typeof toolchain === "string") {
		return { graph: rustGraphToolchain(toolchain), legacy: null };
	}
	const legacy = defaultRustToolchain();
	if (!legacy) {
		throw new Error(
			"cargoPackage() needs a rustToolchain() declared as the workspace default, or an explicit toolchain option",
		);
	}
	return { graph: rustGraphToolchain(legacy.attrs.version), legacy };
}

function extraInputs(deps) {
	return (deps || []).filter((dep) => dep && dep.__imp_graph_handle === true);
}

function kacheActiveFor(legacyToolchainHandle) {
	return !!(legacyToolchainHandle && legacyToolchainHandle.attrs.kache);
}

// Folds extraDirs into env's existing PATH entry (prepended, so they win
// searches), or adds a new PATH entry if none exists yet. Env entries are
// plain "KEY=VALUE" strings later resolved into one map (see
// crates/imp-execution/src/exec.rs's resolve_env docstring) — a second
// literal "PATH=" entry would silently clobber the first rather than merge,
// so any additional PATH-worthy directory (e.g. moldRustLinkerEnv()'s
// pathDirs, //rules/c/mold) must be combined here instead of appended as
// its own env string.
function mergeEnvPath(env, extraDirs) {
	if (!extraDirs || extraDirs.length === 0) return env;
	const index = env.findIndex((entry) => entry.startsWith("PATH="));
	if (index === -1) return [...env, `PATH=${extraDirs.join(":")}`];
	const merged = [...env];
	merged[index] =
		`PATH=${extraDirs.join(":")}:${env[index].slice("PATH=".length)}`;
	return merged;
}

export async function toolEnvAndTools(exec, input, spec) {
	const kacheActive = kacheActiveFor(spec.legacyToolchainHandle);
	const [linker, cache] = await Promise.all([
		rustLinkerTools(exec, input, spec.linkerHandles, kacheActive),
		rustBuildCacheTools(spec.legacyToolchainHandle),
	]);
	const { env: rustEnv } = rustGraphToolEnv(
		exec,
		input.rustupHomeTool,
		input.cargoHomeTool,
		spec.toolchain.toolchainId,
		spec.toolchain.version,
		kacheActive,
	);
	return {
		kacheActive,
		tools: [...linker.tools, ...cache.tools],
		env: mergeEnvPath(
			[...rustEnv, ...linker.env, ...cache.env],
			linker.pathDirs,
		),
		rustflags: linker.rustflags,
		scriptPreamble: cache.scriptPreamble,
	};
}

// [BUILD]/[PACKAGE]: one task producing every declared `bin`'s binary
// artifact. No outputs at all when there are no bins (lib-only package) —
// callers should omit [BUILD]/[PACKAGE] entirely in that case rather than
// resolve a no-op task.
function crateBuildTask(spec) {
	const manifest = file(`${spec.path}/Cargo.toml`);
	const manifests = spec.workspaceMember
		? manifestSources(".")
		: manifestSources(spec.path);
	const bins = spec.bin;
	const profile = spec.release ? "release" : "debug";
	const buildDir = `build/rust/${spec.outputSlug}`;

	return task({
		display: `cargo build ${spec.path}`,
		inputs: {
			manifest,
			manifests,
			rustupHomeTool: spec.toolchain.tool,
			cargoHomeTool: spec.toolchain.cargoHomeTool,
			...linkerToolInputs(linkerHandlesForSpec(spec)),
			...Object.fromEntries(spec.deps.map((d, i) => [`dep${i}`, d])),
		},
		outputs: Object.fromEntries(bins.map((name) => [name, output.artifact()])),
		async run(exec, input) {
			const { kacheActive, tools, env, rustflags, scriptPreamble } =
				await toolEnvAndTools(exec, input, spec);
			const script = cargoScriptPreamble(scriptPreamble).concat(
				`RUSTFLAGS="$rustflags${cargoRemapFlag(kacheActive)}" cargo build --locked --manifest-path "$manifest" --target-dir "$target_dir" "$@"`,
			);
			const exeSuffix = platformInfo().os === "windows" ? ".exe" : "";
			const result = await exec.action({
				argv: [
					"sh",
					"-c",
					script,
					"cargo-build",
					exec.path(input.manifest),
					buildDir,
					rustflags,
					...(spec.release ? ["--release"] : []),
					...spec.cargoArgs,
				],
				tools,
				env,
				inputs: [input.manifests, ...spec.deps.map((_, i) => input[`dep${i}`])],
				outputs: Object.fromEntries(
					bins.map((name) => [
						name,
						output.file(`${buildDir}/${profile}/${name}${exeSuffix}`),
					]),
				),
			});
			return Object.fromEntries(
				bins.map((name) => [name, result.outputs[name]]),
			);
		},
	});
}

function crateSpec(opts) {
	const {
		path = packagePath(),
		bin,
		release = false,
		toolchain,
		cargoArgs = [],
		testArgs = [],
		testTools = [],
		deps = [],
		testDeps = [],
		workspaceMember = false,
	} = opts || {};
	const normalizedPath = normalizeWorkspacePath(path);
	const { graph, legacy } = resolveToolchain(toolchain);
	return {
		path: normalizedPath,
		bin: bin === undefined ? [] : Array.isArray(bin) ? [...bin] : [bin],
		release,
		toolchain: graph,
		legacyToolchainHandle: legacy,
		cargoArgs: [...cargoArgs],
		testArgs: [...testArgs],
		testTools: [...testTools],
		deps: extraInputs(deps),
		testDeps: extraInputs(testDeps),
		workspaceMember,
		outputSlug: outputSlugFor(normalizedPath),
	};
}

/**
 * Declare a Cargo package target: a self-contained crate, a cargo workspace
 * root (member manifests are globbed via `**\/Cargo.toml`), or one member of
 * an outer workspace declared elsewhere (see `workspaceMember`). `bin` is
 * optional — a lib-only package is a fully valid target for `fmt`/`test`,
 * just not for `build`/`package`.
 *
 * @category target
 * @param {object} opts
 * @param {string} [opts.path] Workspace-relative directory containing Cargo.toml. Defaults to the calling BUILD.js's own directory.
 * @param {string|string[]} [opts.bin] Binary name(s) cargo produces. Omit for a lib-only package (no Cargo.toml auto-detection — see module docstring).
 * @param {boolean} [opts.release=false] Always build with `cargo build --release`.
 * @param {object|string} [opts.toolchain] rustGraphToolchain()/legacy rustToolchain() handle, or a version string.
 * @param {string[]} [opts.cargoArgs=[]] Extra arguments appended to `cargo build`.
 * @param {string[]} [opts.testArgs=[]] Extra arguments appended to `cargo test`.
 * @param {Array<object>} [opts.testTools=[]] nativeTool() specifications exposed on PATH while running tests (including doc-tests in a real workspace's shared run).
 * @param {Array<object>} [opts.deps=[]] Extra graph-native input handles the build needs (e.g. a resourcePackage()'s `.files`).
 * @param {Array<object>} [opts.testDeps=[]] Extra graph-native input handles the test run needs but the build doesn't.
 * @param {boolean} [opts.workspaceMember=false] This package is a member of a workspace rooted at "." (see module docstring's limitation on non-root workspace roots).
 * @returns {object} Frozen object with lazy `[BUILD]`/`[TEST]`/`[LINT]`/`[FMT]`/`[PACKAGE]` getters.
 */
export function cargoPackage(opts = {}) {
	const spec = crateSpec(opts);
	_cargoPackageSpecs.push(spec);
	// linkerHandles is deliberately omitted here — workspace_expansion.js's
	// toolchainInputs() lazily computes and caches it on this same
	// toolchainSpec object via linkerHandlesForSpec() the first time a
	// LINT/FMT/TEST task actually needs it, independent of `spec`'s own
	// (also lazy) cache used by crateBuildTask()'s [BUILD]/[PACKAGE] path.
	const toolchainSpec = {
		toolchain: spec.toolchain,
		legacyToolchainHandle: spec.legacyToolchainHandle,
	};
	const expansion = spec.workspaceMember
		? cargoWorkspaceExpansion(".", toolchainSpec)
		: cargoStandaloneExpansion(spec.path, toolchainSpec);
	// A workspaceMember crate is keyed by its real crate *name* in the shared
	// expansion (see workspace_expansion.js), not its path — but this
	// factory only knows the declared `path`. For this repo's real crates,
	// each directory's basename equals its Cargo.toml package name (e.g.
	// crates/imp-store -> "imp-store"), so that's used directly rather than
	// resolving the true crate name from `cargo metadata`.
	const crateKey = spec.workspaceMember
		? spec.path === "."
			? "."
			: spec.path.slice(spec.path.lastIndexOf("/") + 1)
		: spec.path;

	let build = null;
	function buildTask() {
		if (!build) build = crateBuildTask(spec);
		return build;
	}

	const value = {
		spec,
		get [LINT]() {
			return expansion.get(crateKey, LINT);
		},
		get [FMT]() {
			return expansion.get(crateKey, FMT);
		},
		// A bare expansion.get(key, TEST) (no facet) would hand the engine's
		// root-collection walk a single "resolve TEST, no facet" placeholder
		// handle — but workspace_expansion.js's TEST facet is itself a named
		// object ({unit, doctests}), not a bare handle, so that placeholder
		// would fail to resolve. Root-collection only expands a *plain object*
		// value into per-facet roots (see imp_core.js's
		// __imp_collect_graph_exports), so the facets are constructed directly
		// here instead.
		get [TEST]() {
			return {
				unit: expansion.get(crateKey, TEST, "unit"),
				doctests: expansion.get(crateKey, TEST, "doctests"),
			};
		},
	};
	if (spec.bin.length > 0) {
		Object.defineProperty(value, BUILD, {
			enumerable: true,
			get: () => buildTask().outputs,
		});
		Object.defineProperty(value, PACKAGE, {
			enumerable: true,
			get: () => buildTask().outputs,
		});
	}
	return Object.freeze(value);
}
