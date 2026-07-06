import { Target, product, namedCache, download, extract, platformInfo, cachePut, cacheGet, cacheHas } from "imp:core";

import { resolveOdinToolchainVersion } from "//rules/odin/toolchain";

const ODINFMT_CACHE = "odinfmt-toolchains";

// odinfmt ships inside the OLS release zips, whose tags track Odin's monthly dev
// versions, so it is pinned to the same version as the Odin toolchain.
const olsTripleMap = {
    "linux/x86_64": "x86_64-unknown-linux-gnu",
    "linux/aarch64": "arm64-unknown-linux-gnu",
    "macos/x86_64": "x86_64-darwin",
    "macos/aarch64": "arm64-darwin",
    "windows/x86_64": "x86_64-pc-windows-msvc",
};

function declareOdinfmtCache() {
    namedCache({ name: ODINFMT_CACHE });
}

function odinfmtCacheKey(version, plat) {
    return `${version}/${plat.os}-${plat.arch}`;
}

function odinfmtCommandName(plat) {
    const triple = olsTriple(plat);
    return `odinfmt-${triple}${plat.os === "windows" ? ".exe" : ""}`;
}

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
    return {
        tool: {
            kind: "tool",
            name: "odinfmt",
            cache: ODINFMT_CACHE,
            key: odinfmtCacheKey(resolved, plat),
            binDirs: ["."],
        },
        // The OLS zip stores the binary under its triple-suffixed name at the
        // archive root; invoke it by that name (JS has no rename primitive).
        command: odinfmtCommandName(plat),
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
    return `${dir}/${odinfmtCommandName(platformInfo())}`;
}

/**
 * Acquire (download and cache) odinfmt for a version and return its cache path.
 *
 * @category configuration
 * @param {string} version
 * @returns {string}
 */
export function acquireOdinfmt(version) {
    declareOdinfmtCache();
    const plat = platformInfo();
    const triple = olsTriple(plat);
    const key = odinfmtCacheKey(version, plat);

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

export class OdinfmtToolchain extends Target {
    static kind = "odinfmt-toolchain";
    constructor({ version }) {
        super({ kind: OdinfmtToolchain.kind, attrs: { version: version ?? null } });
    }
}

/**
 * Declare an odinfmt toolchain, pinned to an Odin toolchain version. Omit
 * `version` to track the workspace's default Odin toolchain version.
 *
 * @category configuration
 * @param {string} [version]
 * @returns {object} Target handle for this odinfmt toolchain.
 */
export function odinfmtToolchain(version) {
    return new OdinfmtToolchain({ version });
}

product("odinfmt-toolchain", "toolchain", (handle) => odinfmtBin(handle.attrs.version));
