import { Target, product, namedCache, run, output, output_path, platformInfo, cachePut, cacheGet, cacheHas } from "imp:core";

import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";
import { generateToolLockfile } from "//rules/workflows/lockfiles";

const CRANE_TOOLCHAIN_CACHE = "crane-toolchains";

// crane (google/go-containerregistry) publishes prebuilt binaries for these
// targets; see https://github.com/google/go-containerregistry/releases. The
// release tarball is flat (crane/gcrane/krane/LICENSE/README.md at the
// archive root, no wrapping directory) for every platform, including
// Windows — unlike zola there's no separate .zip variant to special-case.
const TARGET_OS = {
    linux: "Linux",
    macos: "Darwin",
    windows: "Windows",
};

const TARGET_ARCH = {
    x86_64: "x86_64",
    aarch64: "arm64",
};

function platformParts(plat) {
    const os = TARGET_OS[plat.os];
    const arch = TARGET_ARCH[plat.arch];
    if (!os || !arch) {
        throw new Error(`unsupported crane toolchain platform: ${plat.os}/${plat.arch}`);
    }
    return { os, arch };
}

/**
 * Return the crane release artifact filename for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function craneArtifactName(version, plat) {
    const { os, arch } = platformParts(plat);
    return `go-containerregistry_${os}_${arch}.tar.gz`;
}

/**
 * Return the crane release download URL for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function craneDownloadUrl(version, plat) {
    return `https://github.com/google/go-containerregistry/releases/download/v${version}/${craneArtifactName(version, plat)}`;
}

// The platforms crane publishes release archives for, keyed "os-arch".
const CRANE_SUPPORTED_PLATFORMS = [
    { os: "linux", arch: "x86_64" },
    { os: "linux", arch: "aarch64" },
    { os: "macos", arch: "x86_64" },
    { os: "macos", arch: "aarch64" },
    { os: "windows", arch: "x86_64" },
];

/**
 * Return the platforms crane publishes release archives for.
 *
 * @returns {Array<{ os: string, arch: string }>}
 */
export function craneSupportedPlatforms() {
    return CRANE_SUPPORTED_PLATFORMS.map((plat) => ({ ...plat }));
}

/**
 * Return the named-cache key for a crane toolchain version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function craneCacheKey(version, plat) {
    return `${version}/${plat.os}-${plat.arch}`;
}

// Bare coreutils used by the download/extract scripts below. The sandbox is
// fully hermetic — even `mkdir`/`tar` must be declared tools, not resolved
// from an ambient or fixed-base PATH. GNU tar shells out to a separate
// `gzip` process to decompress `.tar.gz`.
const CORE_TOOL_NAMES = ["curl", "mkdir", "dirname", "tar", "gzip"];

export class CraneToolchain extends Target {
    static kind = "crane-toolchain";
    constructor({ version }) {
        super({ kind: CraneToolchain.kind, attrs: { version } });
    }
}

let defaultVersion = null;
let defaultToolchain = null;
// Declared lazily, once, the first time a toolchain is declared — target()
// addresses are only assigned at workspace-load time, so this must happen
// at BUILD.js top level rather than inside acquireToolchain() at execution time.
let coreToolHandles = null;

export function __resetCraneToolchainStateForTest() {
    defaultVersion = null;
    defaultToolchain = null;
    coreToolHandles = null;
}

/**
 * Declare a crane toolchain version and optionally set it as the default.
 *
 * @category configuration
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @returns {object} Target handle for this crane toolchain.
 */
export function craneToolchain(version, opts = {}) {
    namedCache({ name: CRANE_TOOLCHAIN_CACHE });
    if (!coreToolHandles) {
        coreToolHandles = CORE_TOOL_NAMES.map((name) => nativeTool(name));
    }

    const toolchain = new CraneToolchain({ version });

    if (opts.default) {
        defaultVersion = version;
        defaultToolchain = toolchain;
    }

    return toolchain;
}

/**
 * Install a local crane toolchain directory into the named cache.
 *
 * @category configuration
 * @param {string} version
 * @param {string} source Path to the toolchain root.
 * @returns {string|null} Local path to the cached toolchain root.
 */
export function installCraneToolchain(version, source) {
    namedCache({ name: CRANE_TOOLCHAIN_CACHE });
    const plat = platformInfo();
    const key = craneCacheKey(version, plat);
    cachePut(CRANE_TOOLCHAIN_CACHE, key, source);
    return cacheGet(CRANE_TOOLCHAIN_CACHE, key);
}

/**
 * Acquire a crane toolchain, downloading and caching it if not already
 * installed in the named cache.
 *
 * @category configuration
 * @param {string} version
 * @returns {Promise<string>} Local path to the toolchain root.
 */
export async function acquireCraneToolchain(version) {
    const plat = platformInfo();
    const key = craneCacheKey(version, plat);

    if (cacheHas(CRANE_TOOLCHAIN_CACHE, key)) {
        return cacheGet(CRANE_TOOLCHAIN_CACHE, key);
    }
    if (!coreToolHandles) {
        throw new Error("no crane toolchain declared via craneToolchain(); nothing to acquire");
    }

    const coreTools = await Promise.all(coreToolHandles.map((handle) => nativeToolSpec(handle)));

    const artifact = craneArtifactName(version, plat);
    const url = craneDownloadUrl(version, plat);
    const downloadPath = `.imp/crane-downloads/${key}/${artifact}`;
    const extractPath = `.imp/crane-toolchains/${key}`;

    await run({
        argv: ["sh", "-c", 'mkdir -p "$(dirname "$1")" && curl -fSL -o "$1" "$2"', "download-crane", downloadPath, url],
        tools: coreTools,
        outputs: [output(output_path(downloadPath))],
        materialize: true,
        display: `download crane ${version} (${plat.os}/${plat.arch})`,
    });

    // crane's release tarball ships crane/gcrane/krane at the archive root
    // (no wrapping directory), so no --strip-components is needed.
    await run({
        argv: ["sh", "-c", 'mkdir -p "$2" && tar -xf "$1" -C "$2"', "extract-crane", downloadPath, extractPath],
        tools: coreTools,
        inputs: [{ kind: "file", path: downloadPath }],
        outputs: [
            output(output_path(extractPath), {
                kind: "directory",
                namedCache: { name: CRANE_TOOLCHAIN_CACHE, key },
            }),
        ],
        materialize: true,
        display: `extract crane ${version} (${plat.os}/${plat.arch})`,
    });

    return cacheGet(CRANE_TOOLCHAIN_CACHE, key);
}

/**
 * Resolve an explicit or default crane toolchain version.
 *
 * @category configuration
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveCraneToolchainVersion(version) {
    if (version) {
        return version;
    }
    return defaultVersion;
}

/**
 * Return the crane executable path for a toolchain version.
 *
 * @category configuration
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function craneBin(version) {
    const resolved = resolveCraneToolchainVersion(version);
    if (!resolved) {
        throw new Error("no crane toolchain version specified and no default set");
    }
    const dir = await acquireCraneToolchain(resolved);
    const plat = platformInfo();
    return plat.os === "windows" ? `${dir}/crane.exe` : `${dir}/crane`;
}

/**
 * Return a named-cache-backed crane tool descriptor for sandbox execution.
 *
 * @category configuration
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function craneTool(version) {
    const resolved = resolveCraneToolchainVersion(version);
    if (!resolved) {
        throw new Error("no crane toolchain version specified and no default set");
    }
    await acquireCraneToolchain(resolved);
    const plat = platformInfo();
    return {
        kind: "tool",
        name: "crane",
        cache: CRANE_TOOLCHAIN_CACHE,
        key: craneCacheKey(resolved, plat),
        binDirs: ["."],
    };
}

/**
 * Return the currently configured default crane toolchain version.
 *
 * @category configuration
 * @returns {string|null}
 */
export function defaultCraneToolchainVersion() {
    return defaultVersion;
}

/**
 * Return the currently configured default crane toolchain target handle.
 *
 * @category configuration
 * @returns {object|null}
 */
export function defaultCraneToolchain() {
    return defaultToolchain;
}

product("crane-toolchain", "gen-lockfiles", (handle) =>
    generateToolLockfile({
        handle,
        name: "crane",
        platforms: craneSupportedPlatforms(),
        downloadUrl: craneDownloadUrl,
        artifactName: craneArtifactName,
    }));
