import { Target, product, namedCache, run, output, output_path, platformInfo, cachePut, cacheGet, cacheHas } from "imp:core";

import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";
import { generateToolLockfile } from "//rules/workflows/lockfiles";

const ZOLA_TOOLCHAIN_CACHE = "zola-toolchains";

// Zola publishes prebuilt binaries for these targets; see
// https://github.com/getzola/zola/releases.
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
        throw new Error(`unsupported zola toolchain platform: ${plat.os}/${plat.arch}`);
    }
    return triple;
}

/**
 * Return the zola release artifact filename for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function zolaArtifactName(version, plat) {
    const ext = plat.os === "windows" ? "zip" : "tar.gz";
    return `zola-v${version}-${targetTriple(plat)}.${ext}`;
}

/**
 * Return the zola release download URL for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function zolaDownloadUrl(version, plat) {
    return `https://github.com/getzola/zola/releases/download/v${version}/${zolaArtifactName(version, plat)}`;
}

/**
 * Return the platforms zola publishes release archives for, derived from the
 * module's TARGET_TRIPLES map (keyed "os-arch").
 *
 * @returns {Array<{ os: string, arch: string }>}
 */
export function zolaSupportedPlatforms() {
    return Object.keys(TARGET_TRIPLES).map((key) => {
        const sep = key.indexOf("-");
        return { os: key.slice(0, sep), arch: key.slice(sep + 1) };
    });
}

/**
 * Return the named-cache key for a zola toolchain version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function zolaCacheKey(version, plat) {
    return `${version}/${plat.os}-${plat.arch}`;
}

// Bare coreutils used by the install script below. The sandbox is fully
// hermetic — even `mkdir`/`tar` must be declared tools, not resolved from an
// ambient or fixed-base PATH. GNU tar shells out to a separate `gzip`
// process to decompress `.tar.gz`.
const CORE_TOOL_NAMES = ["curl", "mkdir", "tar", "gzip"];

export class ZolaToolchain extends Target {
    static kind = "zola-toolchain";
    constructor({ version }) {
        super({ kind: ZolaToolchain.kind, attrs: { version } });
    }
}

let defaultVersion = null;
let defaultToolchain = null;
// Declared lazily, once, the first time a toolchain is declared — target()
// addresses are only assigned at workspace-load time, so this must happen
// at BUILD.js top level rather than inside acquireToolchain() at execution time.
let coreToolHandles = null;

export function __resetZolaToolchainStateForTest() {
    defaultVersion = null;
    defaultToolchain = null;
    coreToolHandles = null;
}

/**
 * Declare a zola toolchain version and optionally set it as the default.
 *
 * @category configuration
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @returns {object} Target handle for this zola toolchain.
 */
export function zolaToolchain(version, opts = {}) {
    namedCache({ name: ZOLA_TOOLCHAIN_CACHE, shared: true });
    if (!coreToolHandles) {
        coreToolHandles = CORE_TOOL_NAMES.map((name) => nativeTool(name));
    }

    const toolchain = new ZolaToolchain({ version });

    if (opts.default) {
        defaultVersion = version;
        defaultToolchain = toolchain;
    }

    return toolchain;
}

/**
 * Install a local zola toolchain directory into the named cache.
 *
 * @category configuration
 * @param {string} version
 * @param {string} source Path to the toolchain root.
 * @returns {string|null} Local path to the cached toolchain root.
 */
export function installZolaToolchain(version, source) {
    namedCache({ name: ZOLA_TOOLCHAIN_CACHE, shared: true });
    const plat = platformInfo();
    const key = zolaCacheKey(version, plat);
    cachePut(ZOLA_TOOLCHAIN_CACHE, key, source);
    return cacheGet(ZOLA_TOOLCHAIN_CACHE, key);
}

/**
 * Acquire a zola toolchain, downloading and caching it if not already
 * installed in the named cache.
 *
 * @category configuration
 * @param {string} version
 * @returns {Promise<string>} Local path to the toolchain root.
 */
export async function acquireZolaToolchain(version) {
    const plat = platformInfo();
    const key = zolaCacheKey(version, plat);

    if (cacheHas(ZOLA_TOOLCHAIN_CACHE, key)) {
        return cacheGet(ZOLA_TOOLCHAIN_CACHE, key);
    }
    if (!coreToolHandles) {
        throw new Error("no zola toolchain declared via zolaToolchain(); nothing to acquire");
    }

    const coreTools = await Promise.all(coreToolHandles.map((handle) => nativeToolSpec(handle)));

    const url = zolaDownloadUrl(version, plat);
    const extractPath = `.imp/zola-toolchains/${key}`;
    // Zola's release tarball ships the `zola` binary at the archive root
    // (no wrapping directory), so no --strip-components is needed. tar
    // can't sniff compression from a pipe, so -z (gzip) must be explicit on
    // the tar.gz (unix) release; the windows .zip release isn't a filter
    // format, so plain -xf works.
    const tarFlags = plat.os === "windows" ? "-xf" : "-xzf";

    await run({
        argv: ["sh", "-c", `mkdir -p "$2" && curl -fSL "$1" | tar ${tarFlags} - -C "$2"`, "install-zola", url, extractPath],
        tools: coreTools,
        outputs: [
            output(output_path(extractPath), {
                kind: "directory",
                namedCache: { name: ZOLA_TOOLCHAIN_CACHE, key },
            }),
        ],
        materialize: false,
        display: `install zola ${version} (${plat.os}/${plat.arch})`,
    });

    return cacheGet(ZOLA_TOOLCHAIN_CACHE, key);
}

/**
 * Resolve an explicit or default zola toolchain version.
 *
 * @category configuration
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveZolaToolchainVersion(version) {
    if (version) {
        return version;
    }
    return defaultVersion;
}

/**
 * Return the zola executable path for a toolchain version.
 *
 * @category configuration
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function zolaBin(version) {
    const resolved = resolveZolaToolchainVersion(version);
    if (!resolved) {
        throw new Error("no zola toolchain version specified and no default set");
    }
    const dir = await acquireZolaToolchain(resolved);
    const plat = platformInfo();
    return plat.os === "windows" ? `${dir}/zola.exe` : `${dir}/zola`;
}

/**
 * Return a named-cache-backed zola tool descriptor for sandbox execution.
 *
 * @category configuration
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function zolaTool(version) {
    const resolved = resolveZolaToolchainVersion(version);
    if (!resolved) {
        throw new Error("no zola toolchain version specified and no default set");
    }
    await acquireZolaToolchain(resolved);
    const plat = platformInfo();
    return {
        kind: "tool",
        name: "zola",
        cache: ZOLA_TOOLCHAIN_CACHE,
        key: zolaCacheKey(resolved, plat),
        binDirs: ["."],
    };
}

/**
 * Return the currently configured default zola toolchain version.
 *
 * @category configuration
 * @returns {string|null}
 */
export function defaultZolaToolchainVersion() {
    return defaultVersion;
}

/**
 * Return the currently configured default zola toolchain target handle.
 *
 * @category configuration
 * @returns {object|null}
 */
export function defaultZolaToolchain() {
    return defaultToolchain;
}

product("zola-toolchain", "gen-lockfiles", (handle) =>
    generateToolLockfile({
        handle,
        name: "zola",
        platforms: zolaSupportedPlatforms(),
        downloadUrl: zolaDownloadUrl,
        artifactName: zolaArtifactName,
        lockfile: "//rules/zola/zola.lock",
    }));
