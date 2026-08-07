// Canonical Rust rule entrypoint (graph-native).
//
// cargoPackage() builds a task()/expand() graph: [BUILD]/[PACKAGE] are
// per-crate tasks defined here; [LINT]/[FMT]/[TEST] delegate to
// workspace_expansion.js's keyed expand() (one shared cargo invocation per
// real workspace, attributed per crate — see that module's docstring).
//
// The linker (RUST_LINKER/RUST_LINK_DRIVER) and build-cache (RUST_BUILD_CACHE)
// roles are still resolved dynamically via productFor() against whichever
// legacy Toolchain subclass registered them (rules/c/gcc's RustGccLinkDriver,
// rules/rust/kache's RustKacheWrapper, rules/c/mold — none of which are
// migrating in this issue; see the migration plan's decision #3). Their
// already-resolved legacy tool-spec results ({name, cache, key, binDirs})
// pass straight through exec.action()'s tools: array unchanged (the engine's
// legacy-tool-spec passthrough, graph_core.js's addTool).
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

import {
	RUST_LINKER,
	RUST_LINK_DRIVER,
	RUST_BUILD_CACHE,
} from "//rules/rust/products";
import {
	defaultRustToolchain,
	rustGraphToolEnv,
	rustGraphToolchain,
} from "//rules/rust/toolchain";

import { nativeTool, nativeToolSpec } from "//rules/imp/native-tool";

import { defaultGccToolchain } from "//rules/c/gcc";

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

export async function toolEnvAndTools(exec, input, spec) {
	const kacheActive = kacheActiveFor(spec.legacyToolchainHandle);
	const [linker, cache] = await Promise.all([
		rustLinkerTools(spec.legacyToolchainHandle),
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
		env: [...rustEnv, ...linker.env, ...cache.env],
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
