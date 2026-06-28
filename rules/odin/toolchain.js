import { target, namedCache, download, extract, platformInfo, cachePut, cacheGet, cacheHas } from "imp:core";

const ODIN_TOOLCHAIN_CACHE = "odin-toolchains";

const defaultHost = {
    namedCache,
    download,
    extract,
    platformInfo,
    cachePut,
    cacheGet,
    cacheHas,
};

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

/**
 * Build an Odin toolchain API. Tests can pass a fake host implementation to
 * exercise installation behavior without downloading or extracting archives.
 *
 * @param {object} [host]
 * @returns {object}
 */
export function createOdinToolchainApi(host = defaultHost) {
    let defaultVersion = null;
    let defaultToolchain = null;

    function declareToolchain(version, opts = {}) {
        host.namedCache({ name: ODIN_TOOLCHAIN_CACHE });

        const toolchain = target({
            kind: "odin-toolchain",
            attrs: { version },
        });

        if (opts.default) {
            defaultVersion = version;
            defaultToolchain = toolchain;
        }

        return toolchain;
    }

    function acquireToolchain(version) {
        const plat = host.platformInfo();
        const key = odinCacheKey(version, plat);

        if (host.cacheHas(ODIN_TOOLCHAIN_CACHE, key)) {
            return host.cacheGet(ODIN_TOOLCHAIN_CACHE, key);
        }

        const artifact = odinArtifactName(version, plat);
        const archive = host.download(odinDownloadUrl(version, plat));
        const staging = stagingPath(version, plat);
        host.extract(archive, staging, {
            format: artifact.endsWith(".zip") ? "zip" : "tar.gz",
            strip_components: 1,
        });

        host.cachePut(ODIN_TOOLCHAIN_CACHE, key, staging);
        return host.cacheGet(ODIN_TOOLCHAIN_CACHE, key);
    }

    function resolveVersion(version) {
        if (version) {
            return version;
        }
        if (defaultVersion) {
            return defaultVersion;
        }
        throw new Error("no Odin toolchain version specified and no default set");
    }

    function bin(version) {
        const resolved = resolveVersion(version);
        const dir = acquireToolchain(resolved);
        const exe = host.platformInfo().os === "windows" ? "odin.exe" : "odin";
        return `${dir}/${exe}`;
    }

    function tool(version) {
        const resolved = resolveVersion(version);
        acquireToolchain(resolved);
        const plat = host.platformInfo();
        return {
            kind: "tool",
            name: "odin",
            cache: ODIN_TOOLCHAIN_CACHE,
            key: odinCacheKey(resolved, plat),
            binDirs: ["."],
        };
    }

    function currentDefaultVersion() {
        return defaultVersion;
    }

    function currentDefaultToolchain() {
        return defaultToolchain;
    }

    return {
        odinToolchain: declareToolchain,
        acquireOdinToolchain: acquireToolchain,
        resolveOdinToolchainVersion: resolveVersion,
        odinBin: bin,
        odinTool: tool,
        defaultOdinToolchainVersion: currentDefaultVersion,
        defaultOdinToolchain: currentDefaultToolchain,
    };
}

const defaultApi = createOdinToolchainApi();

/**
 * Declare an Odin toolchain version and optionally set it as the default.
 *
 * @param {string} version Odin release version (matches .odin-version).
 * @param {object} [opts]
 * @param {boolean} [opts.default=false] Set as the default toolchain.
 * @returns {object} Target handle for this Odin toolchain.
 */
export function odinToolchain(version, opts = {}) {
    return defaultApi.odinToolchain(version, opts);
}

/**
 * Acquire (download and cache) an Odin toolchain.
 *
 * @param {string} version Odin release version, e.g. "dev-2026-03".
 * @returns {string} Local path to the toolchain root containing the Odin binary.
 */
export function acquireOdinToolchain(version) {
    return defaultApi.acquireOdinToolchain(version);
}

/**
 * Resolve an explicit or default Odin toolchain version.
 *
 * @param {string} [version]
 * @returns {string}
 */
export function resolveOdinToolchainVersion(version) {
    return defaultApi.resolveOdinToolchainVersion(version);
}

/**
 * Return the path to the Odin binary for a toolchain version.
 *
 * @param {string} [version]
 * @returns {string}
 */
export function odinBin(version) {
    return defaultApi.odinBin(version);
}

/**
 * Return a named-cache-backed Odin tool descriptor for sandbox execution.
 *
 * @param {string} [version]
 * @returns {object}
 */
export function odinTool(version) {
    return defaultApi.odinTool(version);
}

/**
 * Return the currently configured default Odin toolchain version.
 *
 * @returns {string|null}
 */
export function defaultOdinToolchainVersion() {
    return defaultApi.defaultOdinToolchainVersion();
}

/**
 * Return the currently configured default Odin toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultOdinToolchain() {
    return defaultApi.defaultOdinToolchain();
}
