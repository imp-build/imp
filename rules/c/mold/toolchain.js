import { target, product, namedCache, run, output, output_path, platformInfo, cachePut, cacheGet, cacheHas } from "imp:core";
import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";
import { generateToolLockfile } from "//rules/workflows/lockfiles";

const MOLD_TOOLCHAIN_CACHE = "mold-toolchains";

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

// mold has no serious Windows story; this only targets Linux.
function requireSupportedPlatform(plat) {
    if (plat.os !== "linux") {
        throw new Error(`unsupported mold toolchain OS: ${plat.os}`);
    }
    if (plat.arch !== "x86_64" && plat.arch !== "aarch64") {
        throw new Error(`unsupported mold toolchain architecture: ${plat.arch}`);
    }
}

/**
 * Return the mold release artifact filename for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function moldArtifactName(version, plat) {
    requireSupportedPlatform(plat);
    return `mold-${version}-${plat.arch}-linux.tar.gz`;
}

/**
 * Return the mold release download URL for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function moldDownloadUrl(version, plat) {
    return `https://github.com/rui314/mold/releases/download/v${version}/${moldArtifactName(version, plat)}`;
}

// mold ships prebuilt Linux binaries only (see requireSupportedPlatform).
const MOLD_SUPPORTED_PLATFORMS = [
    { os: "linux", arch: "x86_64" },
    { os: "linux", arch: "aarch64" },
];

/**
 * Return the platforms mold publishes release archives for.
 *
 * @returns {Array<{ os: string, arch: string }>}
 */
export function moldSupportedPlatforms() {
    return MOLD_SUPPORTED_PLATFORMS.map((plat) => ({ ...plat }));
}

/**
 * Return the named-cache key for a mold toolchain version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function moldCacheKey(version, plat) {
    return `${version}/${plat.os}-${plat.arch}`;
}

// Bare coreutils used by the download/extract scripts below. The sandbox is
// fully hermetic — even `mkdir`/`dirname`/`tar` must be declared tools, not
// resolved from an ambient or fixed-base PATH. GNU tar shells out to a
// separate `gzip` process to decompress `.tar.gz`.
const CORE_TOOL_NAMES = ["curl", "mkdir", "dirname", "tar", "gzip"];

/**
 * Build a mold toolchain API. Tests can pass a fake host implementation.
 *
 * @param {object} [host]
 * @returns {object}
 */
export function createMoldToolchainApi(host = defaultHost) {
    let defaultVersion = null;
    let defaultToolchain = null;
    // Declared lazily, once, the first time a toolchain is declared — target()
    // addresses are only assigned at workspace-load time, so this must happen
    // at BUILD.js top level rather than inside acquireToolchain() at execution time.
    let coreToolHandles = null;

    function declareToolchain(version, opts = {}) {
        host.namedCache({ name: MOLD_TOOLCHAIN_CACHE });
        if (!coreToolHandles) {
            coreToolHandles = CORE_TOOL_NAMES.map((name) => host.nativeTool(name));
        }

        const toolchain = target({
            kind: "mold-toolchain",
            attrs: { version },
        });

        if (opts.default) {
            defaultVersion = version;
            defaultToolchain = toolchain;
        }

        return toolchain;
    }

    function installToolchain(version, source) {
        host.namedCache({ name: MOLD_TOOLCHAIN_CACHE });
        const plat = host.platformInfo();
        const key = moldCacheKey(version, plat);
        host.cachePut(MOLD_TOOLCHAIN_CACHE, key, source);
        return host.cacheGet(MOLD_TOOLCHAIN_CACHE, key);
    }

    async function acquireToolchain(version) {
        const plat = host.platformInfo();
        const key = moldCacheKey(version, plat);

        if (host.cacheHas(MOLD_TOOLCHAIN_CACHE, key)) {
            return host.cacheGet(MOLD_TOOLCHAIN_CACHE, key);
        }
        if (!coreToolHandles) {
            throw new Error("no mold toolchain declared via moldToolchain(); nothing to acquire");
        }

        const coreTools = await Promise.all(coreToolHandles.map((handle) => host.nativeToolSpec(handle)));

        const artifact = moldArtifactName(version, plat);
        const url = moldDownloadUrl(version, plat);
        const downloadPath = `.imp/mold-downloads/${key}/${artifact}`;
        const extractPath = `.imp/mold-toolchains/${key}`;

        await host.run({
            argv: ["sh", "-c", 'mkdir -p "$(dirname "$1")" && curl -fSL -o "$1" "$2"', "download-mold", downloadPath, url],
            tools: coreTools,
            outputs: [host.output(host.output_path(downloadPath))],
            display: `download mold ${version} (${plat.os}/${plat.arch})`,
        });

        // mold's release tarball already ships bin/mold and bin/ld.mold
        // (the name clang's -fuse-ld=mold looks for) — no wrapper needed.
        await host.run({
            argv: ["sh", "-c", 'mkdir -p "$2" && tar -xf "$1" -C "$2" --strip-components=1', "extract-mold", downloadPath, extractPath],
            tools: coreTools,
            inputs: [{ kind: "file", path: downloadPath }],
            outputs: [
                host.output(host.output_path(extractPath), {
                    kind: "directory",
                    namedCache: { name: MOLD_TOOLCHAIN_CACHE, key },
                }),
            ],
            display: `extract mold ${version} (${plat.os}/${plat.arch})`,
        });

        return host.cacheGet(MOLD_TOOLCHAIN_CACHE, key);
    }

    function resolveVersion(version) {
        if (version) {
            return version;
        }
        return defaultVersion;
    }

    function requireVersion(version) {
        const resolved = resolveVersion(version);
        if (!resolved) {
            throw new Error("no mold toolchain version specified and no default set");
        }
        return resolved;
    }

    async function bin(version) {
        const resolved = requireVersion(version);
        const dir = await acquireToolchain(resolved);
        return `${dir}/bin/mold`;
    }

    async function tool(version) {
        const resolved = requireVersion(version);
        await acquireToolchain(resolved);
        const plat = host.platformInfo();
        return {
            kind: "tool",
            name: "mold",
            cache: MOLD_TOOLCHAIN_CACHE,
            key: moldCacheKey(resolved, plat),
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
        moldToolchain: declareToolchain,
        installMoldToolchain: installToolchain,
        acquireMoldToolchain: acquireToolchain,
        resolveMoldToolchainVersion: resolveVersion,
        moldBin: bin,
        moldTool: tool,
        defaultMoldToolchainVersion: currentDefaultVersion,
        defaultMoldToolchain: currentDefaultToolchain,
    };
}

const defaultApi = createMoldToolchainApi();

/**
 * Declare a mold toolchain version and optionally set it as the default.
 *
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @returns {object} Target handle for this mold toolchain.
 */
export function moldToolchain(version, opts = {}) {
    return defaultApi.moldToolchain(version, opts);
}

/**
 * Install a local mold toolchain directory into the named cache.
 *
 * @param {string} version
 * @param {string} source Path to the toolchain root.
 * @returns {string|null} Local path to the cached toolchain root.
 */
export function installMoldToolchain(version, source) {
    return defaultApi.installMoldToolchain(version, source);
}

/**
 * Acquire a mold toolchain, downloading and caching it if not already
 * installed in the named cache.
 *
 * @param {string} version
 * @returns {Promise<string>} Local path to the toolchain root.
 */
export function acquireMoldToolchain(version) {
    return defaultApi.acquireMoldToolchain(version);
}

/**
 * Resolve an explicit or default mold toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveMoldToolchainVersion(version) {
    return defaultApi.resolveMoldToolchainVersion(version);
}

/**
 * Return the mold executable path for a toolchain version.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export function moldBin(version) {
    return defaultApi.moldBin(version);
}

/**
 * Return a named-cache-backed mold tool descriptor for sandbox execution.
 *
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export function moldTool(version) {
    return defaultApi.moldTool(version);
}

/**
 * Return the currently configured default mold toolchain version.
 *
 * @returns {string|null}
 */
export function defaultMoldToolchainVersion() {
    return defaultApi.defaultMoldToolchainVersion();
}

/**
 * Return the currently configured default mold toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultMoldToolchain() {
    return defaultApi.defaultMoldToolchain();
}

product("mold-toolchain", "gen-lockfiles", (handle) =>
    generateToolLockfile({
        handle,
        name: "mold",
        platforms: moldSupportedPlatforms(),
        downloadUrl: moldDownloadUrl,
        artifactName: moldArtifactName,
    }));
