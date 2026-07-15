import { Toolchain, product, namedCache, run, output, output_path, platformInfo, cachePut, cacheGet, cacheHas, toolName } from "imp:core";

import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";
import { downloadToolArtifact, lockedDownloadTools } from "//rules/imp/lockfile";
import { extractArchive } from "//rules/imp/archive";
import { generateToolLockfile, GEN_LOCKFILES, registerToolchainLockfile } from "//rules/workflows/lockfiles";

// Declared tool identity for products this toolchain implements; also
// consumed by rule modules registering uv-driven products.
export const UV_TOOL = toolName("uv");

const UV_TOOLCHAIN_CACHE = "uv-toolchains";
const UV_LOCKFILE = "//rules/python/uv-toolchain.lock";

// uv's own wheel/package download cache ($UV_CACHE_DIR) and the interpreters
// its automatic Python management provisions. Both are internally content-
// addressed by uv itself (by package/interpreter identity, never by sandbox
// identity), so sharing a single directory across every sandbox and uv
// version is safe — same reasoning as ZIG_BUILD_CACHE in
// rules/c/zig/toolchain.js. Left unpinned, uv would instead default under the
// sandbox's fresh-every-run HOME, paying a full re-download on every build.
// Keyed by a fixed "shared" key (not per-version) rather than per-toolchain-
// version/platform like UV_TOOLCHAIN_CACHE below, since this cache's content
// is addressed by uv, not by which uv binary is reading it.
const UV_CACHE_DIR_CACHE = "uv-cache-dir";
const UV_CACHE_KEY = "shared";

// uv's release target triples: https://github.com/astral-sh/uv/releases.
// Broader than Zig's linux+windows-only matrix (rules/c/zig/toolchain.js) —
// uv publishes macOS builds too.
const TARGET_TRIPLES = {
    "linux-x86_64": "x86_64-unknown-linux-gnu",
    "linux-aarch64": "aarch64-unknown-linux-gnu",
    "macos-x86_64": "x86_64-apple-darwin",
    "macos-aarch64": "aarch64-apple-darwin",
    "windows-x86_64": "x86_64-pc-windows-msvc",
};

function targetTriple(plat) {
    const triple = TARGET_TRIPLES[`${plat.os}-${plat.arch}`];
    if (!triple) {
        throw new Error(`unsupported uv toolchain platform: ${plat.os}/${plat.arch}`);
    }
    return triple;
}

/**
 * Return the uv release archive filename for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function uvArtifactName(version, plat) {
    const ext = plat.os === "windows" ? "zip" : "tar.gz";
    return `uv-${targetTriple(plat)}.${ext}`;
}

/**
 * Return the uv release download URL for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function uvDownloadUrl(version, plat) {
    return `https://github.com/astral-sh/uv/releases/download/${version}/${uvArtifactName(version, plat)}`;
}

/**
 * Return the named-cache key for a uv toolchain version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function uvCacheKey(version, plat) {
    return `${version}/${plat.os}-${plat.arch}`;
}

// The platforms this module acquires uv for and publishes lockfile entries
// for (see TARGET_TRIPLES).
export function uvSupportedPlatforms() {
    return Object.keys(TARGET_TRIPLES).map((key) => {
        const sep = key.indexOf("-");
        return { os: key.slice(0, sep), arch: key.slice(sep + 1) };
    });
}

// Bare coreutils the download/extract scripts need — even these must be
// declared tools, not resolved from an ambient PATH, since the sandbox is
// fully hermetic. uv ships .tar.gz on unix and .zip on windows. GNU tar
// shells out to a separate `gzip` process to decompress .tar.gz (it doesn't
// inline gzip support the way it does for some other formats), so gzip must
// be declared too — same reason Zig's toolchain.js declares `xz` for its
// .tar.xz archives. Bare `sh` only auto-resolves on unix.
function coreToolNames(plat) {
    const extract = plat.os === "windows" ? ["tar"] : ["tar", "gzip"];
    return [...new Set([...lockedDownloadTools(plat), ...extract])];
}

export class UvToolchain extends Toolchain {
    static kind = "uv-toolchain";
    static tool = UV_TOOL;
    constructor({ version, unverified }, opts) {
        super({
            kind: UvToolchain.kind,
            attrs: { version, ...(unverified ? { unverified } : {}) },
        }, opts);
    }

    bin() {
        return uvBin(this.attrs.version);
    }
}

// Declared lazily, once — target() addresses are only assigned at
// workspace-load time, so tool handles must be created when a toolchain is
// declared at BUILD.js top level, not inside acquireUvToolchain().
let coreToolHandles = null;

export function __resetUvToolchainStateForTest() {
    UvToolchain.clearDefault();
    coreToolHandles = null;
}

/**
 * Declare a uv toolchain version and optionally set it as the default.
 *
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @param {boolean} [opts.unverified=false] Allow downloading without a
 *   matching lockfile entry (warns instead of failing).
 * @returns {object} Target handle for this uv toolchain.
 * @category configuration
 */
export function uvToolchain(version, opts = {}) {
    namedCache({ name: UV_TOOLCHAIN_CACHE, shared: true });
    namedCache({ name: UV_CACHE_DIR_CACHE });
    if (!coreToolHandles) {
        coreToolHandles = coreToolNames(platformInfo()).map((name) => nativeTool(name));
    }

    return new UvToolchain(
        { version, unverified: opts.unverified },
        { default: opts.default },
    );
}

/**
 * Install a local uv toolchain directory into the named cache.
 *
 * @param {string} version
 * @param {string} source Path to the toolchain root.
 * @returns {string|null} Local path to the cached toolchain root.
 */
export function installUvToolchain(version, source) {
    namedCache({ name: UV_TOOLCHAIN_CACHE, shared: true });
    const plat = platformInfo();
    const key = uvCacheKey(version, plat);
    cachePut(UV_TOOLCHAIN_CACHE, key, source);
    return cacheGet(UV_TOOLCHAIN_CACHE, key);
}

/**
 * Acquire a uv toolchain, downloading and caching it if not already
 * installed in the named cache.
 *
 * @param {string} version
 * @returns {Promise<string>} Local path to the toolchain root.
 */
export async function acquireUvToolchain(version) {
    const plat = platformInfo();
    const key = uvCacheKey(version, plat);

    if (!coreToolHandles) {
        throw new Error("no uv toolchain declared via uvToolchain(); nothing to acquire");
    }
    const coreTools = await Promise.all(coreToolHandles.map((handle) => nativeToolSpec(handle)));

    if (!cacheHas(UV_TOOLCHAIN_CACHE, key)) {
        const downloadPath = `.imp/uv-downloads/${key}/${uvArtifactName(version, plat)}`;
        await downloadToolArtifact({
            lockfile: UV_LOCKFILE,
            tool: "uv-toolchain",
            version,
            plat,
            url: uvDownloadUrl(version, plat),
            downloadPath,
            tools: coreTools,
            display: `download uv ${version} (${plat.os}/${plat.arch})`,
            unverified: UvToolchain.resolveUnverified(version),
        });

        // uv's release archives extract a single top-level uv-<triple>/
        // directory containing `uv` (and `uvx`) — strip it so the cache
        // root holds the binaries directly, same shape acquireZigToolchain
        // uses.
        await extractArchive({
            archive: downloadPath,
            dest: `.imp/uv-toolchains/${key}`,
            format: plat.os === "windows" ? "zip" : "tar.gz",
            stripComponents: 1,
            tools: coreTools,
            namedCache: { name: UV_TOOLCHAIN_CACHE, key },
            display: `extract uv ${version} (${plat.os}/${plat.arch})`,
        });
    }

    // A named-cache "tool" mount (see uvCacheDirTool) requires its cache
    // path to already exist as a real directory — materialize_tools_into_
    // sandbox in src/exec.rs bails otherwise — so seed it with an empty
    // directory here, guarded independently of the toolchain cacheHas()
    // above since this cache is keyed "shared", not per-version (same
    // independent-guard pattern as ZIG_BUILD_CACHE's seeding in
    // rules/c/zig/toolchain.js).
    if (!cacheHas(UV_CACHE_DIR_CACHE, UV_CACHE_KEY)) {
        const seedPath = ".imp/uv-cache-dir-seed";
        await run({
            argv: ["sh", "-c", 'mkdir -p "$1"', "seed-uv-cache-dir", seedPath],
            tools: coreTools,
            outputs: [
                output(output_path(seedPath), {
                    kind: "directory",
                    namedCache: { name: UV_CACHE_DIR_CACHE, key: UV_CACHE_KEY },
                }),
            ],
            materialize: true,
            display: "seed uv cache dir",
        });
    }

    return cacheGet(UV_TOOLCHAIN_CACHE, key);
}

/**
 * Resolve an explicit or default uv toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveUvToolchainVersion(version) {
    return UvToolchain.resolveVersion(version);
}

/**
 * Return the uv executable path for a toolchain version.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function uvBin(version) {
    const resolved = UvToolchain.requireVersion(version);
    const dir = await acquireUvToolchain(resolved);
    const exe = platformInfo().os === "windows" ? "uv.exe" : "uv";
    return `${dir}/${exe}`;
}

/**
 * Return a named-cache-backed uv tool descriptor for sandbox execution.
 *
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function uvTool(version) {
    const resolved = UvToolchain.requireVersion(version);
    await acquireUvToolchain(resolved);
    const plat = platformInfo();
    return {
        kind: "tool",
        name: "uv",
        cache: UV_TOOLCHAIN_CACHE,
        key: uvCacheKey(resolved, plat),
        binDirs: ["."],
    };
}

/**
 * Return a named-cache-backed tool descriptor mounting uv's shared package/
 * interpreter cache at a stable path, read-write across every sandbox. Not
 * put on PATH (binDirs empty) — pair with uvCacheDirEnv() to point
 * $UV_CACHE_DIR at its mount path.
 *
 * @returns {object}
 */
export function uvCacheDirTool() {
    return {
        kind: "tool",
        name: UV_CACHE_DIR_CACHE,
        cache: UV_CACHE_DIR_CACHE,
        key: UV_CACHE_KEY,
        binDirs: [],
    };
}

/**
 * Return the `run()` env entries pointing uv at its shared cache-dir tool
 * mount (see uvCacheDirTool). Any run() using this must also include that
 * tool, or the path won't exist in the sandbox. Values are relative to the
 * sandbox root — callers must export them as absolute paths (capturing
 * `$(pwd)` before any `cd`) rather than passing them via run()'s own `env:`,
 * exactly as zigGlobalCacheEnv()'s doc comment in rules/c/zig/toolchain.js
 * explains for ZIG_GLOBAL_CACHE_DIR.
 *
 * Also pins UV_PYTHON_INSTALL_DIR alongside UV_CACHE_DIR: left at its
 * default, uv's automatic Python management downloads interpreters under
 * the sandbox's own ephemeral $HOME (see src/exec.rs's sandbox_home_tmp) —
 * freshly empty every run, so the interpreter itself is redownloaded (and
 * discarded) every single build, same failure mode ZIG_BUILD_CACHE's doc
 * comment describes for an unpinned ZIG_GLOBAL_CACHE_DIR. Nested under the
 * uv-cache-dir mount rather than its own separate named cache, since it's
 * still uv-managed, content-addressed state safe to share the same way.
 *
 * @returns {string[]}
 */
export function uvCacheDirEnv() {
    return [
        `UV_CACHE_DIR=.imp/tools/${UV_CACHE_DIR_CACHE}`,
        `UV_PYTHON_INSTALL_DIR=.imp/tools/${UV_CACHE_DIR_CACHE}/python-install`,
    ];
}

/**
 * Return the currently configured default uv toolchain version.
 *
 * @returns {string|null}
 */
export function defaultUvToolchainVersion() {
    return UvToolchain.defaultVersion();
}

/**
 * Return the currently configured default uv toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultUvToolchain() {
    return UvToolchain.default();
}

// Passing name: "uv" here would collide with a real project's own uv.lock
// (uv's native per-project dependency lock — not ours to name), so
// "uv-toolchain" is used instead for both the `tool` field and the lockfile
// stem.
const LOCKFILE_SPEC = registerToolchainLockfile({
    name: "uv-toolchain",
    platforms: uvSupportedPlatforms(),
    downloadUrl: uvDownloadUrl,
    artifactName: uvArtifactName,
    lockfile: UV_LOCKFILE,
}, ["0.11.16"]);
product(UvToolchain, GEN_LOCKFILES, UV_TOOL, (handle) =>
    generateToolLockfile({ handle, ...LOCKFILE_SPEC }));
