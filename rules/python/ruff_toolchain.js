import { Target, product, namedCache, run, output, output_path, platformInfo, cachePut, cacheGet, cacheHas } from "imp:core";

import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";
import { resolveToolLockfile, shaCheckedDownloadScript, shaToolName } from "//rules/imp/lockfile";
import { generateToolLockfile } from "//rules/workflows/lockfiles";

const RUFF_TOOLCHAIN_CACHE = "ruff-toolchains";
// The bundled lockfile ships embedded in the binary (it lives inside
// rules/**); a workspace overrides it with a file at the same address, or
// by declaring the toolchain with a `lockfile` address of its own.
const DEFAULT_LOCKFILE = "//rules/python/ruff-toolchain.lock";

// ruff's release target triples: https://github.com/astral-sh/ruff/releases.
// Same platform set as uv (rules/python/uv_toolchain.js) minus the musl/arm
// variants that toolchain doesn't publish either — this repo only builds for
// the standard glibc/msvc/darwin hosts.
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
        throw new Error(`unsupported ruff toolchain platform: ${plat.os}/${plat.arch}`);
    }
    return triple;
}

/**
 * Return the ruff release archive filename for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function ruffArtifactName(version, plat) {
    const ext = plat.os === "windows" ? "zip" : "tar.gz";
    return `ruff-${targetTriple(plat)}.${ext}`;
}

/**
 * Return the ruff release download URL for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function ruffDownloadUrl(version, plat) {
    return `https://github.com/astral-sh/ruff/releases/download/${version}/${ruffArtifactName(version, plat)}`;
}

/**
 * Return the named-cache key for a ruff toolchain version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function ruffCacheKey(version, plat) {
    return `${version}/${plat.os}-${plat.arch}`;
}

// The platforms this module acquires ruff for and publishes lockfile entries
// for (see TARGET_TRIPLES).
export function ruffSupportedPlatforms() {
    return Object.keys(TARGET_TRIPLES).map((key) => {
        const sep = key.indexOf("-");
        return { os: key.slice(0, sep), arch: key.slice(sep + 1) };
    });
}

// Bare coreutils the download/extract scripts need — same reasoning as
// coreToolNames in uv_toolchain.js: the sandbox is fully hermetic, so even
// these must be declared tools, not resolved from an ambient PATH.
function coreToolNames(plat) {
    return plat.os === "windows"
        ? ["curl", "mkdir", "dirname", "tar", "sh", shaToolName(plat)]
        : ["curl", "mkdir", "dirname", "tar", "gzip", shaToolName(plat)];
}

export class RuffToolchain extends Target {
    static kind = "ruff-toolchain";
    constructor({ version, lockfile, unverified }) {
        super({ kind: RuffToolchain.kind, attrs: { version, lockfile, unverified } });
    }
}

let defaultVersion = null;
let defaultToolchain = null;
let defaultLockfile = DEFAULT_LOCKFILE;
let defaultUnverified = false;
// Declared lazily, once — target() addresses are only assigned at
// workspace-load time, so tool handles must be created when a toolchain is
// declared at BUILD.js top level, not inside acquireRuffToolchain().
let coreToolHandles = null;

export function __resetRuffToolchainStateForTest() {
    defaultVersion = null;
    defaultToolchain = null;
    defaultLockfile = DEFAULT_LOCKFILE;
    defaultUnverified = false;
    coreToolHandles = null;
}

function requireVersion(version) {
    const resolved = resolveRuffToolchainVersion(version);
    if (!resolved) {
        throw new Error("no ruff toolchain version specified and no default set");
    }
    return resolved;
}

/**
 * Declare a ruff toolchain version and optionally set it as the default.
 *
 * @category configuration
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @param {string} [opts.lockfile] Lockfile address pinning download SHA-256s;
 *   defaults to the bundled `//rules/python/ruff-toolchain.lock`. Point this
 *   at your own lock (regenerate via `imp goal gen-lockfiles`) when pinning
 *   a non-default version.
 * @param {boolean} [opts.unverified=false] Allow downloading without a
 *   matching lockfile entry (warns instead of failing).
 * @returns {object} Target handle for this ruff toolchain.
 */
export function ruffToolchain(version, opts = {}) {
    namedCache({ name: RUFF_TOOLCHAIN_CACHE, shared: true });
    if (!coreToolHandles) {
        coreToolHandles = coreToolNames(platformInfo()).map((name) => nativeTool(name));
    }

    const lockfile = opts.lockfile ?? DEFAULT_LOCKFILE;
    const unverified = opts.unverified ?? false;
    const toolchain = new RuffToolchain({ version, lockfile, unverified });

    if (opts.default) {
        defaultVersion = version;
        defaultToolchain = toolchain;
        defaultLockfile = lockfile;
        defaultUnverified = unverified;
    }

    return toolchain;
}

/**
 * Install a local ruff toolchain directory into the named cache.
 *
 * @category configuration
 * @param {string} version
 * @param {string} source Path to the directory containing the `ruff` binary.
 * @returns {string|null} Local path to the cached toolchain root.
 */
export function installRuffToolchain(version, source) {
    namedCache({ name: RUFF_TOOLCHAIN_CACHE, shared: true });
    const plat = platformInfo();
    const key = ruffCacheKey(version, plat);
    cachePut(RUFF_TOOLCHAIN_CACHE, key, source);
    return cacheGet(RUFF_TOOLCHAIN_CACHE, key);
}

/**
 * Acquire a ruff toolchain, downloading and caching it if not already
 * installed in the named cache.
 *
 * @category configuration
 * @param {string} version
 * @returns {Promise<string>} Local path to the toolchain root.
 */
export async function acquireRuffToolchain(version) {
    const plat = platformInfo();
    const key = ruffCacheKey(version, plat);

    if (!coreToolHandles) {
        throw new Error("no ruff toolchain declared via ruffToolchain(); nothing to acquire");
    }
    const coreTools = await Promise.all(coreToolHandles.map((handle) => nativeToolSpec(handle)));

    if (!cacheHas(RUFF_TOOLCHAIN_CACHE, key)) {
        // Verification only runs on this cold path — warm named-cache
        // contents were verified when inserted, or seeded deliberately via
        // installRuffToolchain.
        const lockEntry = resolveToolLockfile({
            address: defaultLockfile,
            tool: "ruff-toolchain",
            version,
            plat,
            unverified: defaultUnverified,
        });
        const artifact = ruffArtifactName(version, plat);
        const url = lockEntry ? lockEntry.url : ruffDownloadUrl(version, plat);
        const downloadPath = `.imp/ruff-downloads/${key}/${artifact}`;
        const extractPath = `.imp/ruff-toolchains/${key}`;

        const downloadArgv = lockEntry
            ? ["sh", "-c", shaCheckedDownloadScript(plat), "download-ruff", downloadPath, url, lockEntry.sha256]
            : ["sh", "-c", 'mkdir -p "$(dirname "$1")" && curl -fSL -o "$1" "$2"', "download-ruff", downloadPath, url];
        try {
            await run({
                argv: downloadArgv,
                tools: coreTools,
                outputs: [output(output_path(downloadPath))],
                materialize: true,
                display: `download ruff ${version} (${plat.os}/${plat.arch})`,
            });
        } catch (e) {
            if (lockEntry) {
                throw new Error(
                    `download of ruff ${version} from ${url} failed transfer or sha256 verification ` +
                    `(expected ${lockEntry.sha256} from ${defaultLockfile}); if you intentionally ` +
                    `changed versions, run \`imp goal gen-lockfiles\`: ${e && e.message ? e.message : e}`,
                );
            }
            throw e;
        }

        // ruff's release archives extract a single top-level
        // ruff-<triple>/ directory containing the `ruff` binary — strip it
        // so the cache root holds the binary directly, same shape
        // acquireUvToolchain uses.
        const extractScript = plat.os === "windows"
            ? 'mkdir -p "$2" && tar -xf "$1" -C "$2" --strip-components=1'
            : 'mkdir -p "$2" && tar -xzf "$1" -C "$2" --strip-components=1';

        await run({
            argv: ["sh", "-c", extractScript, "extract-ruff", downloadPath, extractPath],
            tools: coreTools,
            inputs: [{ kind: "file", path: downloadPath }],
            outputs: [
                output(output_path(extractPath), {
                    kind: "directory",
                    namedCache: { name: RUFF_TOOLCHAIN_CACHE, key },
                }),
            ],
            materialize: true,
            display: `extract ruff ${version} (${plat.os}/${plat.arch})`,
        });
    }

    return cacheGet(RUFF_TOOLCHAIN_CACHE, key);
}

/**
 * Resolve an explicit or default ruff toolchain version.
 *
 * @category configuration
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveRuffToolchainVersion(version) {
    if (version) {
        return version;
    }
    return defaultVersion;
}

/**
 * Return the ruff executable path for a toolchain version.
 *
 * @category configuration
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function ruffBin(version) {
    const resolved = requireVersion(version);
    const dir = await acquireRuffToolchain(resolved);
    const exe = platformInfo().os === "windows" ? "ruff.exe" : "ruff";
    return `${dir}/${exe}`;
}

/**
 * Return a named-cache-backed ruff tool descriptor for sandbox execution.
 *
 * @category configuration
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function ruffTool(version) {
    const resolved = requireVersion(version);
    await acquireRuffToolchain(resolved);
    const plat = platformInfo();
    return {
        kind: "tool",
        name: "ruff",
        cache: RUFF_TOOLCHAIN_CACHE,
        key: ruffCacheKey(resolved, plat),
        binDirs: ["."],
    };
}

/**
 * Return the currently configured default ruff toolchain version.
 *
 * @category configuration
 * @returns {string|null}
 */
export function defaultRuffToolchainVersion() {
    return defaultVersion;
}

/**
 * Return the currently configured default ruff toolchain target handle.
 *
 * @category configuration
 * @returns {object|null}
 */
export function defaultRuffToolchain() {
    return defaultToolchain;
}

product("ruff-toolchain", "gen-lockfiles", (handle) =>
    generateToolLockfile({
        handle,
        name: "ruff-toolchain",
        platforms: ruffSupportedPlatforms(),
        downloadUrl: ruffDownloadUrl,
        artifactName: ruffArtifactName,
        lockfile: handle.attrs.lockfile ?? DEFAULT_LOCKFILE,
    }));
