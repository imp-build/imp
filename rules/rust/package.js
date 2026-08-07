// Graph-native cargoPackage() factory (PR 3 of the rules/rust migration —
// see the migration plan's PR 3 section for the full design). Deliberately
// lives in its own module rather than overwriting rules/rust/index.js's
// legacy cargoPackage() export: every real crates/*/BUILD.js still calls the
// legacy factory today, and nothing in this repo can dual-run both shapes
// under the same export name — swapping it here would break the self-hosted
// build the moment this file's real consumer (the migration's cutover PR)
// isn't also landing in the same commit. This file is purely additive: until
// that cutover PR flips crates/*/BUILD.js over to it and deletes the legacy
// code, it's unused by anything but its own test suite.
//
// [LINT]/[FMT]/[TEST] delegate to workspace_expansion.js's keyed expand()
// (one shared cargo invocation per real workspace, attributed per crate).
// [BUILD]/[PACKAGE] are new tasks here — build/package were out of scope for
// that expansion (see its module docstring) since they're inherently
// per-crate (different `bin`s, no cross-crate dedup opportunity the way
// clippy/test-build/fmt/doctest have).
//
// Known simplifications versus the legacy factory, deliberately deferred to
// the migration's cutover PR (where real crates/*/BUILD.js usage constrains
// what's actually needed):
//   - `bin` auto-detection from Cargo.toml (legacy deriveBinsFromCargoToml)
//     is not ported; omitting `bin` here means "no binaries" (lib-only),
//     whereas the legacy factory reads Cargo.toml off disk to infer it. 8 of
//     this repo's 9 real crates rely on that auto-detected empty case today
//     (confirmed by grep — only crates/imp/BUILD.js passes bin explicitly),
//     so this needs revisiting before the cutover, not before this PR merges.
//   - A workspaceMember crate's BUILD/PACKAGE inputs use the whole-repo
//     source glob (manifestSources(".")) rather than the legacy's narrowed
//     transitive-dependency closure (workspace_closure.js's
//     workspaceClosureFor) — correct, but coarser build-cache granularity.
//     Also assumes the real workspace root is "." (true for this repo today
//     — every workspaceMember crate here is rooted at the top-level
//     Cargo.toml); a workspace rooted elsewhere would need its own
//     workspaceRootRelative resolution, which this file doesn't attempt.
//   - `deps`/`testDeps` accept only already-resolved graph-native handles
//     (arbitrary extra `files()`/`file()`/task-output bindings unioned into
//     the relevant action's inputs), not legacy resourcePackage() targets —
//     crates/imp/BUILD.js's `deps: [engineAssets, protoAssets]` needs a
//     legacy→graph bridge that doesn't exist yet; flagged in the migration
//     plan's PR 4 as needing resolution before that crate migrates.

import {
	BUILD,
	FMT,
	LINT,
	PACKAGE,
	TEST,
	file,
	files,
	output,
	platformInfo,
	task,
} from "imp:core";

import { rustBuildCacheTools, rustLinkerTools } from "//rules/rust";
import { cargoRemapFlag, cargoScriptPreamble } from "//rules/rust";
import {
	defaultRustToolchain,
	rustGraphToolEnv,
	rustGraphToolchain,
} from "//rules/rust/toolchain";
import {
	cargoStandaloneExpansion,
	cargoWorkspaceExpansion,
} from "//rules/rust/workspace_expansion";

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
// productFor() bridge below), a plain version string, or omitted (workspace
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

async function toolEnvAndTools(exec, input, spec) {
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
// resolve a no-op task, matching the legacy factory's "package == null"
// short circuit.
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
		path = ".",
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
 * Declare a graph-native Cargo package target. Additive sibling of
 * rules/rust's legacy cargoPackage() — see this module's docstring for why
 * it lives here instead of replacing that export, and for the known
 * simplifications versus the legacy factory.
 *
 * @category target
 * @param {object} opts
 * @param {string} [opts.path="."] Workspace-relative directory containing Cargo.toml.
 * @param {string|string[]} [opts.bin] Binary name(s) cargo produces. Omit for a lib-only package (no Cargo.toml auto-detection — see module docstring).
 * @param {boolean} [opts.release=false] Always build with `cargo build --release`.
 * @param {object|string} [opts.toolchain] rustGraphToolchain()/legacy rustToolchain() handle, or a version string.
 * @param {string[]} [opts.cargoArgs=[]] Extra arguments appended to `cargo build`.
 * @param {string[]} [opts.testArgs=[]] Extra arguments appended to `cargo test`.
 * @param {Array<object>} [opts.testTools=[]] nativeTool() specifications exposed on PATH while running tests.
 * @param {Array<object>} [opts.deps=[]] Extra graph-native input handles the build needs (see module docstring's `deps`/`testDeps` limitation).
 * @param {Array<object>} [opts.testDeps=[]] Extra graph-native input handles the test run needs but the build doesn't.
 * @param {boolean} [opts.workspaceMember=false] This package is a member of a workspace rooted at "." (see module docstring's limitation on non-root workspace roots).
 * @returns {object} Frozen object with lazy `[BUILD]`/`[TEST]`/`[LINT]`/`[FMT]`/`[PACKAGE]` getters.
 */
export function cargoPackage(opts = {}) {
	const spec = crateSpec(opts);
	const expansion = spec.workspaceMember
		? cargoWorkspaceExpansion(".", spec.toolchain.tool)
		: cargoStandaloneExpansion(spec.path, spec.toolchain.tool);
	// A workspaceMember crate is keyed by its real crate *name* in the shared
	// expansion (see workspace_expansion.js), not its path — but this
	// factory only knows the declared `path`. Resolving the true crate name
	// would need the expansion's own `cargo metadata` result; deferred here
	// (see module docstring) — for now, workspaceMember crates key by the
	// last path segment, which matches this repo's real crates (each one's
	// directory name equals its Cargo.toml package name, e.g.
	// crates/imp-store -> "imp-store").
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
		get [TEST]() {
			return expansion.get(crateKey, TEST);
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
