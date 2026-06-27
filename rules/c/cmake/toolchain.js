import { namedCache, platformInfo, cachePut, cacheGet, cacheHas } from "imp:core";

const CMAKE_TOOLCHAIN_CACHE = "cmake-toolchains";

const defaultHost = {
    namedCache,
    platformInfo,
    cachePut,
    cacheGet,
    cacheHas,
};

/**
 * Return the named-cache key for a CMake toolchain version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function cmakeCacheKey(version, plat) {
    return `${version}/${plat.os}-${plat.arch}`;
}

/**
 * Build a CMake toolchain API. Tests can pass a fake host implementation, and
 * the install/acquire path can grow here without touching the CMake build rule.
 *
 * @param {object} [host]
 * @returns {object}
 */
export function createCmakeToolchainApi(host = defaultHost) {
    let defaultVersion = null;

    function declareToolchain(version, opts = {}) {
        host.namedCache({ name: CMAKE_TOOLCHAIN_CACHE });

        if (opts.default) {
            defaultVersion = version;
        }

        const plat = host.platformInfo();
        return `${CMAKE_TOOLCHAIN_CACHE}/${cmakeCacheKey(version, plat)}`;
    }

    function installToolchain(version, source) {
        host.namedCache({ name: CMAKE_TOOLCHAIN_CACHE });
        const plat = host.platformInfo();
        const key = cmakeCacheKey(version, plat);
        host.cachePut(CMAKE_TOOLCHAIN_CACHE, key, source);
        return host.cacheGet(CMAKE_TOOLCHAIN_CACHE, key);
    }

    function acquireToolchain(version) {
        const plat = host.platformInfo();
        const key = cmakeCacheKey(version, plat);

        if (host.cacheHas(CMAKE_TOOLCHAIN_CACHE, key)) {
            return host.cacheGet(CMAKE_TOOLCHAIN_CACHE, key);
        }

        throw new Error(`CMake toolchain ${version} is not installed in ${CMAKE_TOOLCHAIN_CACHE}/${key}`);
    }

    function resolveVersion(version) {
        if (version) {
            return version;
        }
        return defaultVersion;
    }

    function bin(version) {
        const resolved = resolveVersion(version);
        if (!resolved) {
            return "cmake";
        }
        return `${acquireToolchain(resolved)}/bin/cmake`;
    }

    function currentDefaultVersion() {
        return defaultVersion;
    }

    return {
        cmakeToolchain: declareToolchain,
        installCmakeToolchain: installToolchain,
        acquireCmakeToolchain: acquireToolchain,
        resolveCmakeToolchainVersion: resolveVersion,
        cmakeBin: bin,
        defaultCmakeToolchainVersion: currentDefaultVersion,
    };
}

const defaultApi = createCmakeToolchainApi();

/**
 * Declare a CMake toolchain version and optionally set it as the default.
 *
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @returns {string} The named cache key for this toolchain version+platform.
 */
export function cmakeToolchain(version, opts = {}) {
    return defaultApi.cmakeToolchain(version, opts);
}

/**
 * Install a local CMake toolchain directory into the named cache.
 *
 * @param {string} version
 * @param {string} source Path to the toolchain root.
 * @returns {string|null} Local path to the cached toolchain root.
 */
export function installCmakeToolchain(version, source) {
    return defaultApi.installCmakeToolchain(version, source);
}

/**
 * Acquire an installed CMake toolchain from the named cache.
 *
 * @param {string} version
 * @returns {string} Local path to the toolchain root.
 */
export function acquireCmakeToolchain(version) {
    return defaultApi.acquireCmakeToolchain(version);
}

/**
 * Resolve an explicit or default CMake toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveCmakeToolchainVersion(version) {
    return defaultApi.resolveCmakeToolchainVersion(version);
}

/**
 * Return the CMake executable for a toolchain version, or system "cmake" when
 * no CMake toolchain default has been declared.
 *
 * @param {string} [version]
 * @returns {string}
 */
export function cmakeBin(version) {
    return defaultApi.cmakeBin(version);
}

/**
 * Return the currently configured default CMake toolchain version.
 *
 * @returns {string|null}
 */
export function defaultCmakeToolchainVersion() {
    return defaultApi.defaultCmakeToolchainVersion();
}
