import { Target, product, namedCache, download, extract, platformInfo, cachePut, cacheGet, cacheHas } from "imp:core";

import { generateToolLockfile } from "//rules/workflows/lockfiles";

const ODIN_TOOLCHAIN_CACHE = "odin-toolchains";
const ODINFMT_CACHE = "odinfmt-toolchains";

// odinfmt ships inside the OLS release zips, whose tags track Odin's monthly dev
// versions, so it is pinned to the same version as the Odin toolchain. The
// artifact triples differ from Odin's os/arch naming (see osMap/archMap).
const olsTripleMap = {
    "linux/x86_64": "x86_64-unknown-linux-gnu",
    "linux/aarch64": "arm64-unknown-linux-gnu",
    "macos/x86_64": "x86_64-darwin",
    "macos/aarch64": "arm64-darwin",
    "windows/x86_64": "x86_64-pc-windows-msvc",
};

/**
 * Return the OLS release triple for a platform.
 *
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function olsTriple(plat) {
    const triple = olsTripleMap[`${plat.os}/${plat.arch}`];
    if (!triple) {
        throw new Error(`no odinfmt build for ${plat.os}/${plat.arch}`);
    }
    return triple;
}

const osMap = { linux: "linux", macos: "macos", windows: "windows" };
const archMap = { x86_64: "amd64", aarch64: "arm64" };

function requireSupportedPlatform(plat) {
    if (!osMap[plat.os]) {
        throw new Error(`unsupported Odin toolchain OS: ${plat.os}`);
    }
    if (!archMap[plat.arch]) {
        throw new Error(`unsupported Odin toolchain architecture: ${plat.arch}`);
    }
}

function stagingPath(version, plat) {
    return `/tmp/imp-odin-${version}-${plat.arch}`;
}

/**
 * Return the named-cache key for an Odin toolchain version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function odinCacheKey(version, plat) {
    requireSupportedPlatform(plat);
    return `${version}/${plat.os}-${plat.arch}`;
}

/**
 * Return the Odin release artifact filename for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function odinArtifactName(version, plat) {
    requireSupportedPlatform(plat);
    const ext = plat.os === "windows" ? "zip" : "tar.gz";
    return `odin-${osMap[plat.os]}-${archMap[plat.arch]}-${version}.${ext}`;
}

/**
 * Return the Odin release download URL for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function odinDownloadUrl(version, plat) {
    return `https://github.com/odin-lang/Odin/releases/download/${version}/${odinArtifactName(version, plat)}`;
}


// The platforms Odin publishes a release archive for. osMap × archMap would also
// admit windows/aarch64, which Odin does not ship — so the lockfile matrix is
// curated to what actually exists on the releases page.
const ODIN_SUPPORTED_PLATFORMS = [
    { os: "linux", arch: "x86_64" },
    { os: "linux", arch: "aarch64" },
    { os: "macos", arch: "x86_64" },
    { os: "macos", arch: "aarch64" },
    { os: "windows", arch: "x86_64" },
];

/**
 * Return the platforms Odin publishes release archives for.
 *
 * @returns {Array<{ os: string, arch: string }>}
 */
export function odinSupportedPlatforms() {
    return ODIN_SUPPORTED_PLATFORMS.map((plat) => ({ ...plat }));
}

export class OdinToolchain extends Target {
    static kind = "odin-toolchain";
    constructor({ version }) {
        super({ kind: OdinToolchain.kind, attrs: { version } });
    }
}

let defaultVersion = null;
let defaultToolchain = null;

export function __resetOdinToolchainStateForTest() {
    defaultVersion = null;
    defaultToolchain = null;
}

/**
 * Declare an Odin toolchain version and optionally set it as the default.
 *
 * @category configuration
 * @param {string} version Odin release version (matches .odin-version).
 * @param {object} [opts]
 * @param {boolean} [opts.default=false] Set as the default toolchain.
 * @returns {object} Target handle for this Odin toolchain.
 */
export function odinToolchain(version, opts = {}) {
    namedCache({ name: ODIN_TOOLCHAIN_CACHE });
    namedCache({ name: ODINFMT_CACHE });

    const toolchain = new OdinToolchain({ version });

    if (opts.default) {
        defaultVersion = version;
        defaultToolchain = toolchain;
    }

    return toolchain;
}

/**
 * Acquire (download and cache) an Odin toolchain.
 *
 * @category configuration
 * @param {string} version Odin release version, e.g. "dev-2026-03".
 * @returns {string} Local path to the toolchain root containing the Odin binary.
 */
export function acquireOdinToolchain(version) {
    const plat = platformInfo();
    const key = odinCacheKey(version, plat);

    if (cacheHas(ODIN_TOOLCHAIN_CACHE, key)) {
        return cacheGet(ODIN_TOOLCHAIN_CACHE, key);
    }

    const artifact = odinArtifactName(version, plat);
    const archive = download(odinDownloadUrl(version, plat));
    const staging = stagingPath(version, plat);
    extract(archive, staging, {
        format: artifact.endsWith(".zip") ? "zip" : "tar.gz",
        strip_components: 1,
    });

    cachePut(ODIN_TOOLCHAIN_CACHE, key, staging);
    return cacheGet(ODIN_TOOLCHAIN_CACHE, key);
}

/**
 * Resolve an explicit or default Odin toolchain version.
 *
 * @category configuration
 * @param {string} [version]
 * @returns {string}
 */
export function resolveOdinToolchainVersion(version) {
    if (version) {
        return version;
    }
    if (defaultVersion) {
        return defaultVersion;
    }
    throw new Error("no Odin toolchain version specified and no default set");
}

/**
 * Return the path to the Odin binary for a toolchain version.
 *
 * @category configuration
 * @param {string} [version]
 * @returns {string}
 */
export function odinBin(version) {
    const resolved = resolveOdinToolchainVersion(version);
    const dir = acquireOdinToolchain(resolved);
    const exe = platformInfo().os === "windows" ? "odin.exe" : "odin";
    return `${dir}/${exe}`;
}

/**
 * Return a named-cache-backed Odin tool descriptor for sandbox execution.
 *
 * @category configuration
 * @param {string} [version]
 * @returns {object}
 */
export function odinTool(version) {
    const resolved = resolveOdinToolchainVersion(version);
    acquireOdinToolchain(resolved);
    const plat = platformInfo();
    return {
        kind: "tool",
        name: "odin",
        cache: ODIN_TOOLCHAIN_CACHE,
        key: odinCacheKey(resolved, plat),
        binDirs: ["."],
    };
}

/**
 * Return a named-cache-backed odinfmt tool descriptor plus the on-disk binary
 * name to invoke it with. Downloads and caches the OLS release on first use.
 *
 * @category configuration
 * @param {string} [version]
 * @returns {{ tool: object, command: string }}
 */
export function odinfmtTool(version) {
    const resolved = resolveOdinToolchainVersion(version);
    acquireOdinfmt(resolved);
    const plat = platformInfo();
    const triple = olsTriple(plat);
    return {
        tool: {
            kind: "tool",
            name: "odinfmt",
            cache: ODINFMT_CACHE,
            key: `${resolved}/${plat.os}-${plat.arch}`,
            binDirs: ["."],
        },
        // The OLS zip stores the binary under its triple-suffixed name at the
        // archive root; invoke it by that name (JS has no rename primitive).
        command: `odinfmt-${triple}${plat.os === "windows" ? ".exe" : ""}`,
    };
}

/**
 * Return the path to the odinfmt binary for an Odin toolchain version.
 *
 * @category configuration
 * @param {string} [version]
 * @returns {string}
 */
export function odinfmtBin(version) {
    const resolved = resolveOdinToolchainVersion(version);
    const dir = acquireOdinfmt(resolved);
    const plat = platformInfo();
    const triple = olsTriple(plat);
    return `${dir}/odinfmt-${triple}${plat.os === "windows" ? ".exe" : ""}`;
}

/**
 * Acquire (download and cache) odinfmt for a version and return its cache path.
 *
 * @category configuration
 * @param {string} version
 * @returns {string}
 */
export function acquireOdinfmt(version) {
    const plat = platformInfo();
    const triple = olsTriple(plat);
    const key = `${version}/${plat.os}-${plat.arch}`;

    if (cacheHas(ODINFMT_CACHE, key)) {
        return cacheGet(ODINFMT_CACHE, key);
    }

    const url = `https://github.com/DanielGavin/ols/releases/download/${version}/ols-${triple}.zip`;
    const archive = download(url);
    const staging = `/tmp/imp-odinfmt-${version}-${plat.arch}`;
    extract(archive, staging, { format: "zip" });

    cachePut(ODINFMT_CACHE, key, staging);
    return cacheGet(ODINFMT_CACHE, key);
}

/**
 * Return the currently configured default Odin toolchain version.
 *
 * @category configuration
 * @returns {string|null}
 */
export function defaultOdinToolchainVersion() {
    return defaultVersion;
}

/**
 * Return the currently configured default Odin toolchain target handle.
 *
 * @category configuration
 * @returns {object|null}
 */
export function defaultOdinToolchain() {
    return defaultToolchain;
}

product("odin-toolchain", "gen-lockfiles", (handle) =>
    generateToolLockfile({
        handle,
        name: "odin",
        platforms: odinSupportedPlatforms(),
        downloadUrl: odinDownloadUrl,
        artifactName: odinArtifactName,
    }));
