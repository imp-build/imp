import { Target, product, namedCache, run, output, output_path, platformInfo, cachePut, cacheGet, cacheHas } from "imp:core";

import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";
import { generateToolLockfile, registerBuiltinLockfile, GEN_LOCKFILES } from "//rules/workflows/lockfiles";

const PEX_TOOLCHAIN_CACHE = "pex-toolchains";

// PEX's own PEX_ROOT (default ~/.pex): installed_wheels + venvs caches that
// back its "exact subset, no global venv" symlink/hardlink-from-cache
// behavior (see docs/notes in the plan this module implements). Must be a
// real, persistent, shared directory across sandboxes for that caching to
// ever pay off — left unpinned, every sandboxed pex invocation gets a fresh
// empty PEX_ROOT and re-extracts every wheel every time, the same failure
// mode ZIG_BUILD_CACHE's doc comment (rules/c/zig/toolchain.js) describes
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

// Bare coreutils the download script needs — even these must be declared
// tools, not resolved from an ambient PATH, since the sandbox is fully
// hermetic. No tar/extraction step (pex is a single file, not an archive).
function coreToolNames(plat) {
    return plat.os === "windows"
        ? ["curl", "mkdir", "dirname"]
        : ["curl", "mkdir", "dirname", "chmod"];
}

export class PexToolchain extends Target {
    static kind = "pex-toolchain";
    constructor({ version }) {
        super({ kind: PexToolchain.kind, attrs: { version } });
    }
}

let defaultVersion = null;
let defaultToolchain = null;
// Declared lazily, once — target() addresses are only assigned at
// workspace-load time, so tool handles must be created when a toolchain is
// declared at BUILD.js top level, not inside acquirePexToolchain().
let coreToolHandles = null;

export function __resetPexToolchainStateForTest() {
    defaultVersion = null;
    defaultToolchain = null;
    coreToolHandles = null;
}

function requireVersion(version) {
    const resolved = resolvePexToolchainVersion(version);
    if (!resolved) {
        throw new Error("no pex toolchain version specified and no default set");
    }
    return resolved;
}

/**
 * Declare a pex toolchain version and optionally set it as the default.
 *
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @returns {object} Target handle for this pex toolchain.
 * @category configuration
 */
export function pexToolchain(version, opts = {}) {
    namedCache({ name: PEX_TOOLCHAIN_CACHE, shared: true });
    namedCache({ name: PEX_ROOT_CACHE });
    if (!coreToolHandles) {
        coreToolHandles = coreToolNames(platformInfo()).map((name) => nativeTool(name));
    }

    const toolchain = new PexToolchain({ version });

    if (opts.default) {
        defaultVersion = version;
        defaultToolchain = toolchain;
    }

    return toolchain;
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
 * Acquire a pex toolchain, downloading and caching it if not already
 * installed in the named cache.
 *
 * @param {string} version
 * @returns {Promise<string>} Local path to the toolchain directory (containing `pex`).
 */
export async function acquirePexToolchain(version) {
    const plat = platformInfo();
    const key = pexCacheKey(version);

    if (!coreToolHandles) {
        throw new Error("no pex toolchain declared via pexToolchain(); nothing to acquire");
    }
    const coreTools = await Promise.all(coreToolHandles.map((handle) => nativeToolSpec(handle)));

    if (!cacheHas(PEX_TOOLCHAIN_CACHE, key)) {
        const url = pexDownloadUrl(version);
        const dir = `.imp/pex-toolchains/${key}`;

        // Single download+chmod step, not split like uv/zig's download-then-
        // extract — there's no archive to extract here, just one file to
        // fetch and mark executable, so there's only one real cacheable
        // unit of work.
        const script = plat.os === "windows"
            ? 'mkdir -p "$2" && curl -fSL -o "$2/pex" "$1"'
            : 'mkdir -p "$2" && curl -fSL -o "$2/pex" "$1" && chmod +x "$2/pex"';

        await run({
            argv: ["sh", "-c", script, "download-pex", url, dir],
            tools: coreTools,
            outputs: [
                output(output_path(dir), {
                    kind: "directory",
                    namedCache: { name: PEX_TOOLCHAIN_CACHE, key },
                }),
            ],
            materialize: true,
            display: `download pex ${version}`,
        });
    }

    // A named-cache "tool" mount (see pexRootTool) requires its cache path
    // to already exist as a real directory — materialize_tools_into_sandbox
    // in src/exec.rs bails otherwise — so seed it with an empty directory
    // here, guarded independently of the toolchain cacheHas() above since
    // this cache is keyed "shared", not per-version (same independent-guard
    // pattern as ZIG_BUILD_CACHE's seeding in rules/c/zig/toolchain.js).
    if (!cacheHas(PEX_ROOT_CACHE, PEX_ROOT_KEY)) {
        const seedPath = ".imp/pex-root-seed";
        await run({
            argv: ["sh", "-c", 'mkdir -p "$1"', "seed-pex-root", seedPath],
            tools: coreTools,
            outputs: [
                output(output_path(seedPath), {
                    kind: "directory",
                    namedCache: { name: PEX_ROOT_CACHE, key: PEX_ROOT_KEY },
                }),
            ],
            materialize: true,
            display: "seed pex root",
        });
    }

    return cacheGet(PEX_TOOLCHAIN_CACHE, key);
}

/**
 * Resolve an explicit or default pex toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolvePexToolchainVersion(version) {
    if (version) {
        return version;
    }
    return defaultVersion;
}

/**
 * Return the pex zipapp path for a toolchain version.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function pexBin(version) {
    const resolved = requireVersion(version);
    const dir = await acquirePexToolchain(resolved);
    return `${dir}/pex`;
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
    const resolved = requireVersion(version);
    await acquirePexToolchain(resolved);
    return {
        kind: "tool",
        name: "pex",
        cache: PEX_TOOLCHAIN_CACHE,
        key: pexCacheKey(resolved),
        binDirs: ["."],
    };
}

/**
 * Return a named-cache-backed tool descriptor mounting PEX's shared
 * PEX_ROOT cache at a stable path, read-write across every sandbox. Not put
 * on PATH (binDirs empty) — pair with pexRootEnv() to point $PEX_ROOT at its
 * mount path.
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
 * exactly as zigGlobalCacheEnv()'s doc comment in rules/c/zig/toolchain.js
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
    return defaultVersion;
}

/**
 * Return the currently configured default pex toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultPexToolchain() {
    return defaultToolchain;
}

// pex has exactly one artifact for all platforms, so generateToolLockfile
// (which expects a per-platform downloadUrl/artifactName) is given a single
// degenerate platform entry; downloadUrl/artifactName below ignore their
// `plat` argument. This reuses generateToolLockfile unmodified rather than
// forking it for a single-artifact case.
const LOCKFILE_SPEC = {
    name: "pex-toolchain",
    platforms: [{ os: "any", arch: "any" }],
    downloadUrl: (version) => pexDownloadUrl(version),
    artifactName: () => "pex",
    lockfile: "//rules/python/pex-toolchain.lock",
};
product(PexToolchain, GEN_LOCKFILES, (handle) =>
    generateToolLockfile({ handle, ...LOCKFILE_SPEC }));
registerBuiltinLockfile({ ...LOCKFILE_SPEC, versions: ["2.97.1"] });
