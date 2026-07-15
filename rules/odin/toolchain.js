import { Toolchain, product, namedCache, download, extract, platformInfo, cachePut, cacheGet, cacheHas, toolName } from "imp:core";

import { generateToolLockfile, GEN_LOCKFILES, registerToolchainLockfile } from "//rules/workflows/lockfiles";

// Declared tool identity for products this toolchain implements; also
// consumed by rule modules registering odin-driven products.
export const ODIN_TOOL = toolName("odin");

const ODIN_TOOLCHAIN_CACHE = "odin-toolchains";

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

export class OdinToolchain extends Toolchain {
    static kind = "odin-toolchain";
    static tool = ODIN_TOOL;
    constructor({ version, linker }, opts) {
        super({ kind: OdinToolchain.kind, attrs: { version, ...(linker ? { linker } : {}) } }, opts);
    }

    bin() {
        return odinBin(this.attrs.version);
    }
}

export function __resetOdinToolchainStateForTest() {
    OdinToolchain.clearDefault();
}

/**
 * Declare an Odin toolchain version and optionally set it as the default.
 *
 * @category configuration
 * @param {string} version Odin release version (matches .odin-version).
 * @param {object} [opts]
 * @param {boolean} [opts.default=false] Set as the default toolchain.
 * @param {object} [opts.linker] Linker toolchain handle (e.g. moldToolchain())
 *   registering an "odin-linker" product. If omitted, Odin links with
 *   whatever `ld` the gcc toolchain's clang wrapper selects by default.
 * @returns {object} Target handle for this Odin toolchain.
 */
export function odinToolchain(version, opts = {}) {
    namedCache({ name: ODIN_TOOLCHAIN_CACHE, shared: true });

    return new OdinToolchain(
        { version, linker: opts.linker },
        { default: opts.default },
    );
}

/**
 * Acquire (download and cache) an Odin toolchain.
 *
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
 * @param {string} [version]
 * @returns {string}
 */
export function resolveOdinToolchainVersion(version) {
    const resolved = OdinToolchain.resolveVersion(version);
    if (!resolved) {
        throw new Error("no Odin toolchain version specified and no default set");
    }
    return resolved;
}

/**
 * Return the path to the Odin binary for a toolchain version.
 *
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
 * Return the currently configured default Odin toolchain version.
 *
 * @returns {string|null}
 */
export function defaultOdinToolchainVersion() {
    return OdinToolchain.defaultVersion();
}

/**
 * Return the currently configured default Odin toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultOdinToolchain() {
    return OdinToolchain.default();
}

const LOCKFILE_SPEC = registerToolchainLockfile({
    name: "odin",
    platforms: odinSupportedPlatforms(),
    downloadUrl: odinDownloadUrl,
    artifactName: odinArtifactName,
    lockfile: "//rules/odin/odin.lock",
}, ["dev-2026-03"]);
product(OdinToolchain, GEN_LOCKFILES, ODIN_TOOL, (handle) =>
    generateToolLockfile({ handle, ...LOCKFILE_SPEC }));
