import {
	Toolchain,
	namedCache,
	output,
	platformInfo,
	cachePut,
	cacheGet,
	toolName,
	tool as graphTool,
	task,
} from "imp:core";

import { nativeTool } from "//rules/imp/native-tool";
import {
	downloadToolArtifact,
	lockfileAddressToPath,
	lockfileFor,
} from "//rules/imp/lockfile";
import { toolchainBin, toolchainToolSpec } from "//rules/imp/toolchain";
import {
	graphGenerateToolLockfile,
	GEN_LOCKFILES,
	registerToolchainLockfile,
} from "//rules/workflows/lockfiles";

// Declared tool identity for products this toolchain implements; also
// consumed by rule modules registering pex-driven products.
export const PEX_TOOL = toolName("pex");

const PEX_TOOLCHAIN_CACHE = "pex-toolchains";
// The bundled lockfile ships with the rule library (it lives inside
// rules/**); a workspace overrides it with a file at the same address, or
// by declaring the toolchain with a `lockfile` address of its own.
const DEFAULT_LOCKFILE = "//rules/python/pex-toolchain.lock";
// pex publishes one platform-independent artifact; its lock entries are
// keyed under this pseudo-platform (see LOCKFILE_SPEC.platforms below).
const PEX_LOCK_PLATFORM = { os: "any", arch: "any" };

// PEX's own PEX_ROOT (default ~/.pex): installed_wheels + venvs caches that
// back its "exact subset, no global venv" symlink/hardlink-from-cache
// behavior (see docs/notes in the plan this module implements). Must be a
// real, persistent, shared directory across sandboxes for that caching to
// ever pay off — left unpinned, every sandboxed pex invocation gets a fresh
// empty PEX_ROOT and re-extracts every wheel every time, the same failure
// mode ZIG_BUILD_CACHE's doc comment (rules/c/zig/index.js) describes
// for ZIG_GLOBAL_CACHE_DIR. Fixed "shared" key: PEX_ROOT's content is
// addressed by what it's caching (wheel hashes, venv fingerprints), not by
// which pex version is reading it.
const PEX_ROOT_CACHE = "pex-root";
const PEX_ROOT_KEY = "shared";

// PEX ships as a single pure-Python zipapp asset per version — unlike uv/zig,
// there are no per-OS/arch release variants, so the toolchain cache is keyed
// by version alone (a deliberate divergence from the sibling toolchains'
// "${version}/${os}-${arch}" key shape).
export function pexCacheKey(version) {
	return version;
}

/**
 * Return the pex zipapp download URL for a version.
 *
 * @param {string} version
 * @returns {string}
 */
export function pexDownloadUrl(version) {
	return `https://github.com/pantsbuild/pex/releases/download/v${version}/pex`;
}

export class PexToolchain extends Toolchain {
	static kind = "pex-toolchain";
	static tool = PEX_TOOL;
	constructor({ version, lockfile, unverified }, opts) {
		super(
			{
				kind: PexToolchain.kind,
				attrs: {
					version,
					lockfile,
					...(unverified ? { unverified } : {}),
				},
			},
			opts,
		);
	}

	bin() {
		return pexBin(this.attrs.version);
	}
}

// Built once per declared version, at declaration time: task() refuses to add
// graph nodes during execution, so anything that resolves a toolchain while
// the graph is running must find a handle here rather than build one.
let graphToolchains = new Map();

function graphToolFor(version) {
	return graphToolchains.get(version) ?? pexGraphTool(version);
}

export function __resetPexToolchainStateForTest() {
	PexToolchain.clearDefault();
	graphToolchains = new Map();
}

/**
 * Declare a pex toolchain version and optionally set it as the default.
 *
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @param {string} [opts.lockfile] Lockfile address pinning download SHA-256s;
 *   defaults to the bundled `//rules/python/pex-toolchain.lock`. Point this at
 *   your own lock (regenerate via `imp goal gen-lockfiles`) when pinning a
 *   version the bundled lock does not know.
 * @param {boolean} [opts.unverified=false] Allow downloading without a
 *   matching lockfile entry (warns instead of failing).
 * @returns {object} Target handle for this pex toolchain.
 * @category configuration
 */
export function pexToolchain(version, opts = {}) {
	namedCache({ name: PEX_ROOT_CACHE });

	const lockfile = opts.lockfile ?? DEFAULT_LOCKFILE;
	// Fail on a malformed address at declaration time, not at first acquire.
	lockfileAddressToPath(lockfile);
	new PexToolchain(
		{ version, lockfile, unverified: opts.unverified },
		{ default: opts.default },
	);
	const graph = pexGraphTool(version);
	graphToolchains.set(version, graph);
	return graph;
}

/**
 * The `[GEN_LOCKFILES]` root for a pex toolchain version.
 *
 * This is a separate function from pexToolchain(). pexToolchain() returns a
 * frozen tool() handle. A frozen object cannot hold an extra
 * property.
 *
 * @param {string} [version]
 * @param {object} [opts]
 * @param {string} [opts.lockfile] Write this lockfile address instead of the
 *   one declared on the toolchain. Defaults to the address
 *   pexToolchain(version, { lockfile }) declared, so a workspace states it
 *   once.
 * @returns {object} `{ [GEN_LOCKFILES]: ... }`.
 */
export function pexGenLockfiles(version, opts = {}) {
	const resolved = PexToolchain.requireVersion(version);
	return {
		[GEN_LOCKFILES]: graphGenerateToolLockfile({
			version: resolved,
			...LOCKFILE_SPEC,
			lockfile:
				opts.lockfile ?? lockfileFor(PexToolchain, resolved, DEFAULT_LOCKFILE),
		}),
	};
}

/** Return the CAS-backed graph PEX tool. */
export function pexGraphTool(version) {
	const resolved = PexToolchain.requireVersion(version);
	const plat = platformInfo();
	namedCache({ name: PEX_TOOLCHAIN_CACHE, shared: true });
	const archive = downloadToolArtifact({
		lockfile: lockfileFor(PexToolchain, resolved, DEFAULT_LOCKFILE),
		tool: "pex-toolchain",
		version: resolved,
		plat,
		lockPlat: PEX_LOCK_PLATFORM,
		url: pexDownloadUrl(resolved),
		output: `.imp/pex-downloads/${pexCacheKey(resolved)}/pex`,
		display: `download pex ${resolved}`,
		unverified: PexToolchain.resolveUnverified(resolved),
	});
	const shell = nativeTool("sh");
	const cp = nativeTool("cp");
	const mkdir = nativeTool("mkdir");
	const chmod = plat.os === "windows" ? null : nativeTool("chmod");
	const install = task({
		display: `install pex ${resolved}`,
		inputs: { archive, shell, cp, mkdir, ...(chmod ? { chmod } : {}) },
		outputs: { directory: output.artifact() },
		async run(exec, inputs) {
			const result = await exec.action({
				argv: [
					exec.tool(inputs.shell, "sh"),
					"-c",
					plat.os === "windows"
						? 'mkdir -p "$2" && cp "$1" "$2/pex"'
						: 'mkdir -p "$2" && cp "$1" "$2/pex" && chmod +x "$2/pex"',
					"install-pex",
					exec.path(inputs.archive),
					"toolchain",
				],
				tools: [
					inputs.shell,
					inputs.cp,
					inputs.mkdir,
					...(inputs.chmod ? [inputs.chmod] : []),
				],
				outputs: {
					directory: output.directory("toolchain", {
						namedCache: {
							name: PEX_TOOLCHAIN_CACHE,
							key: pexCacheKey(resolved),
						},
					}),
				},
			});
			return { directory: result.outputs.directory };
		},
	});
	return graphTool(install.outputs.directory, {
		binDirs: ["."],
		mount: {
			name: "pex",
			cache: PEX_TOOLCHAIN_CACHE,
			key: pexCacheKey(resolved),
		},
	});
}

/**
 * Install a local pex zipapp into the named cache.
 *
 * @param {string} version
 * @param {string} source Path to the pex zipapp file.
 * @returns {string|null} Local path to the cached zipapp.
 */
export function installPexToolchain(version, source) {
	namedCache({ name: PEX_TOOLCHAIN_CACHE, shared: true });
	const key = pexCacheKey(version);
	cachePut(PEX_TOOLCHAIN_CACHE, key, source);
	return cacheGet(PEX_TOOLCHAIN_CACHE, key);
}

/**
 * Resolve an explicit or default pex toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolvePexToolchainVersion(version) {
	return PexToolchain.resolveVersion(version);
}

/**
 * Return the pex zipapp path for a toolchain version.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function pexBin(version) {
	const resolved = PexToolchain.requireVersion(version);
	return toolchainBin(graphToolFor(resolved), {
		name: PEX_TOOLCHAIN_CACHE,
		key: pexCacheKey(resolved),
		exe: "pex",
	});
}

/**
 * Return a named-cache-backed pex tool descriptor for sandbox execution.
 * The mounted "binary" is a pure-Python zipapp, not directly exec'able on
 * every platform — invoke it as `<python> <toolDir>/pex ...` using an
 * interpreter from a synced uv venv (see rules/python/index.js), not via
 * PATH-exec.
 *
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function pexTool(version) {
	const resolved = PexToolchain.requireVersion(version);
	return toolchainToolSpec(graphToolFor(resolved), {
		toolName: "pex",
		name: PEX_TOOLCHAIN_CACHE,
		key: pexCacheKey(resolved),
		binDirs: ["."],
	});
}

/**
 * Return a named-cache-backed tool descriptor mounting PEX's shared
 * PEX_ROOT cache at a stable path, read-write across every sandbox. Not put
 * on PATH (binDirs empty) — pair with pexRootEnv() to point $PEX_ROOT at its
 * mount path.
 *
 * WARNING: this cache has no seed task. A tool mount needs its cache path to
 * exist as a real directory (materialize_tools_into_sandbox in src/exec.rs
 * fails otherwise), so the first run() that mounts it will fail. There are no
 * callers today; give the cache a graph seed task before you add one.
 *
 * @returns {object}
 */
export function pexRootTool() {
	return {
		kind: "tool",
		name: PEX_ROOT_CACHE,
		cache: PEX_ROOT_CACHE,
		key: PEX_ROOT_KEY,
		binDirs: [],
	};
}

/**
 * Return the `run()` env entries pointing pex at its shared PEX_ROOT tool
 * mount (see pexRootTool). Any run() using this must also include that
 * tool, or the path won't exist in the sandbox. Values are relative to the
 * sandbox root — callers must export them as absolute paths (capturing
 * `$(pwd)` before any `cd`) rather than passing them via run()'s own `env:`,
 * exactly as zigGlobalCacheEnv()'s doc comment in rules/c/zig/index.js
 * explains for ZIG_GLOBAL_CACHE_DIR.
 *
 * @returns {string[]}
 */
export function pexRootEnv() {
	return [`PEX_ROOT=.imp/tools/${PEX_ROOT_CACHE}`];
}

/**
 * Return the currently configured default pex toolchain version.
 *
 * @returns {string|null}
 */
export function defaultPexToolchainVersion() {
	return PexToolchain.defaultVersion();
}

/**
 * Return the currently configured default pex toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultPexToolchain() {
	const version = PexToolchain.defaultVersion();
	return version ? (graphToolchains.get(version) ?? null) : null;
}

// Importing this rule provisions the pinned default. A workspace can replace
// it by declaring another pexToolchain(..., { default: true }).
pexToolchain("2.97.1", { default: true });

// pex has exactly one artifact for all platforms, so generateToolLockfile
// (which expects a per-platform downloadUrl/artifactName) is given a single
// degenerate platform entry; downloadUrl/artifactName below ignore their
// `plat` argument. This reuses generateToolLockfile unmodified rather than
// forking it for a single-artifact case.
const LOCKFILE_SPEC = registerToolchainLockfile(
	{
		name: "pex-toolchain",
		platforms: [{ os: "any", arch: "any" }],
		downloadUrl: (version) => pexDownloadUrl(version),
		artifactName: () => "pex",
		lockfile: DEFAULT_LOCKFILE,
	},
	["2.97.1"],
);
