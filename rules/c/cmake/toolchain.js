import { Target, product, namedCache, run, output, output_path, platformInfo, cachePut, cacheGet, cacheHas } from "imp:core";

import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";
import { generateToolLockfile } from "//rules/workflows/lockfiles";

const CMAKE_TOOLCHAIN_CACHE = "cmake-toolchains";

const defaultHost = {
    namedCache,
    run,
    output,
    output_path,
    nativeTool,
    nativeToolSpec,
    platformInfo,
    cachePut,
    cacheGet,
    cacheHas,
};

// CMake's Windows release archives use "arm64" rather than the "aarch64"
// naming used elsewhere in this project (and by CMake's own Linux archives).
const archNameByOs = {
    linux: { x86_64: "x86_64", aarch64: "aarch64" },
    windows: { x86_64: "x86_64", aarch64: "arm64" },
};

function requireSupportedPlatform(plat) {
    const archNames = archNameByOs[plat.os];
    if (!archNames) {
        throw new Error(`unsupported CMake toolchain OS: ${plat.os}`);
    }
    if (!archNames[plat.arch]) {
        throw new Error(`unsupported CMake toolchain architecture: ${plat.arch}`);
    }
}

/**
 * Return the CMake release artifact filename for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function cmakeArtifactName(version, plat) {
    requireSupportedPlatform(plat);
    const arch = archNameByOs[plat.os][plat.arch];
    const ext = plat.os === "windows" ? "zip" : "tar.gz";
    return `cmake-${version}-${plat.os}-${arch}.${ext}`;
}

/**
 * Return the CMake release download URL for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function cmakeDownloadUrl(version, plat) {
    return `https://github.com/Kitware/CMake/releases/download/v${version}/${cmakeArtifactName(version, plat)}`;
}

/**
 * Return the platforms CMake publishes release archives for, derived from the
 * os/arch matrix this module already supports.
 *
 * @returns {Array<{ os: string, arch: string }>}
 */
export function cmakeSupportedPlatforms() {
    return Object.entries(archNameByOs).flatMap(([os, archNames]) =>
        Object.keys(archNames).map((arch) => ({ os, arch })));
}

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
// Bare coreutils used by the download/extract scripts below. The sandbox is
// fully hermetic — even `mkdir`/`dirname`/`tar` must be declared tools, not
// resolved from an ambient or fixed-base PATH. Bare `sh` only auto-resolves
// on unix (see BUILTIN_SHELL_CANDIDATES in src/exec.rs), so Windows needs
// `sh` (Git Bash) declared as a tool too.
function coreToolNames(plat) {
    return ["curl", "mkdir", "dirname", "tar", "gzip", ...(plat.os === "windows" ? ["sh"] : [])];
}

export class CmakeToolchain extends Target {
    static kind = "cmake-toolchain";
    constructor({ version }) {
        super({ kind: CmakeToolchain.kind, attrs: { version } });
    }
}

export function createCmakeToolchainApi(host = defaultHost) {
    let defaultVersion = null;
    let defaultToolchain = null;
    // Declared lazily, once, the first time a toolchain is declared — target()
    // addresses are only assigned at workspace-load time, so this must happen
    // at BUILD.js top level rather than inside acquireToolchain() at execution time.
    let coreToolHandles = null;

    function declareToolchain(version, opts = {}) {
        host.namedCache({ name: CMAKE_TOOLCHAIN_CACHE });
        if (!coreToolHandles) {
            coreToolHandles = coreToolNames(host.platformInfo()).map((name) => host.nativeTool(name));
        }

        const toolchain = new CmakeToolchain({ version });

        if (opts.default) {
            defaultVersion = version;
            defaultToolchain = toolchain;
        }

        return toolchain;
    }

    function installToolchain(version, source) {
        host.namedCache({ name: CMAKE_TOOLCHAIN_CACHE });
        const plat = host.platformInfo();
        const key = cmakeCacheKey(version, plat);
        host.cachePut(CMAKE_TOOLCHAIN_CACHE, key, source);
        return host.cacheGet(CMAKE_TOOLCHAIN_CACHE, key);
    }

    async function acquireToolchain(version) {
        const plat = host.platformInfo();
        const key = cmakeCacheKey(version, plat);

        if (host.cacheHas(CMAKE_TOOLCHAIN_CACHE, key)) {
            return host.cacheGet(CMAKE_TOOLCHAIN_CACHE, key);
        }
        if (!coreToolHandles) {
            throw new Error("no CMake toolchain declared via cmakeToolchain(); nothing to acquire");
        }

        const coreTools = await Promise.all(coreToolHandles.map((handle) => host.nativeToolSpec(handle)));

        const artifact = cmakeArtifactName(version, plat);
        const url = cmakeDownloadUrl(version, plat);
        const downloadPath = `.imp/cmake-downloads/${key}/${artifact}`;
        const extractPath = `.imp/cmake-toolchains/${key}`;

        await host.run({
            argv: ["sh", "-c", 'mkdir -p "$(dirname "$1")" && curl -fSL -o "$1" "$2"', "download-cmake", downloadPath, url],
            tools: coreTools,
            outputs: [host.output(host.output_path(downloadPath))],
            display: `download cmake ${version} (${plat.os}/${plat.arch})`,
        });

        await host.run({
            argv: ["sh", "-c", 'mkdir -p "$2" && tar -xf "$1" -C "$2" --strip-components=1', "extract-cmake", downloadPath, extractPath],
            tools: coreTools,
            inputs: [{ kind: "file", path: downloadPath }],
            outputs: [
                host.output(host.output_path(extractPath), {
                    kind: "directory",
                    namedCache: { name: CMAKE_TOOLCHAIN_CACHE, key },
                }),
            ],
            display: `extract cmake ${version} (${plat.os}/${plat.arch})`,
        });

        return host.cacheGet(CMAKE_TOOLCHAIN_CACHE, key);
    }

    function resolveVersion(version) {
        if (version) {
            return version;
        }
        return defaultVersion;
    }

    async function bin(version) {
        const resolved = resolveVersion(version);
        if (!resolved) {
            return "cmake";
        }
        const dir = await acquireToolchain(resolved);
        const exe = host.platformInfo().os === "windows" ? "cmake.exe" : "cmake";
        return `${dir}/bin/${exe}`;
    }

    async function tool(version) {
        const resolved = resolveVersion(version);
        if (!resolved) {
            throw new Error("no CMake toolchain version specified and no default set");
        }
        await acquireToolchain(resolved);
        const plat = host.platformInfo();
        return {
            kind: "tool",
            name: "cmake",
            cache: CMAKE_TOOLCHAIN_CACHE,
            key: cmakeCacheKey(resolved, plat),
            binDirs: ["bin"],
        };
    }

    function currentDefaultVersion() {
        return defaultVersion;
    }

    function currentDefaultToolchain() {
        return defaultToolchain;
    }

    return {
        cmakeToolchain: declareToolchain,
        installCmakeToolchain: installToolchain,
        acquireCmakeToolchain: acquireToolchain,
        resolveCmakeToolchainVersion: resolveVersion,
        cmakeBin: bin,
        cmakeTool: tool,
        defaultCmakeToolchainVersion: currentDefaultVersion,
        defaultCmakeToolchain: currentDefaultToolchain,
    };
}

const defaultApi = createCmakeToolchainApi();

/**
 * Declare a CMake toolchain version and optionally set it as the default.
 *
 * @category configuration
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @returns {object} Target handle for this CMake toolchain.
 */
export function cmakeToolchain(version, opts = {}) {
    return defaultApi.cmakeToolchain(version, opts);
}

/**
 * Install a local CMake toolchain directory into the named cache.
 *
 * @category configuration
 * @param {string} version
 * @param {string} source Path to the toolchain root.
 * @returns {string|null} Local path to the cached toolchain root.
 */
export function installCmakeToolchain(version, source) {
    return defaultApi.installCmakeToolchain(version, source);
}

/**
 * Acquire a CMake toolchain, downloading and caching it if not already
 * installed in the named cache.
 *
 * @category configuration
 * @param {string} version
 * @returns {Promise<string>} Local path to the toolchain root.
 */
export function acquireCmakeToolchain(version) {
    return defaultApi.acquireCmakeToolchain(version);
}

/**
 * Resolve an explicit or default CMake toolchain version.
 *
 * @category configuration
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
 * @category configuration
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export function cmakeBin(version) {
    return defaultApi.cmakeBin(version);
}

/**
 * Return a named-cache-backed CMake tool descriptor for sandbox execution.
 *
 * @category configuration
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export function cmakeTool(version) {
    return defaultApi.cmakeTool(version);
}

/**
 * Return the currently configured default CMake toolchain version.
 *
 * @category configuration
 * @returns {string|null}
 */
export function defaultCmakeToolchainVersion() {
    return defaultApi.defaultCmakeToolchainVersion();
}

/**
 * Return the currently configured default CMake toolchain target handle.
 *
 * @category configuration
 * @returns {object|null}
 */
export function defaultCmakeToolchain() {
    return defaultApi.defaultCmakeToolchain();
}

product("cmake-toolchain", "gen-lockfiles", (handle) =>
    generateToolLockfile({
        handle,
        name: "cmake",
        platforms: cmakeSupportedPlatforms(),
        downloadUrl: cmakeDownloadUrl,
        artifactName: cmakeArtifactName,
    }));
