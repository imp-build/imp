import { target, namedCache, run, output, output_path, platformInfo, cachePut, cacheGet, cacheHas } from "imp:core";
import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";

const ZOLA_TOOLCHAIN_CACHE = "zola-toolchains";

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
 * Return the named-cache key for a zola toolchain version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function zolaCacheKey(version, plat) {
    return `${version}/${plat.os}-${plat.arch}`;
}

// Bare coreutils used by the download/extract scripts below. The sandbox is
// fully hermetic — even `mkdir`/`tar` must be declared tools, not resolved
// from an ambient or fixed-base PATH. GNU tar shells out to a separate
// `gzip` process to decompress `.tar.gz`.
const CORE_TOOL_NAMES = ["curl", "mkdir", "dirname", "tar", "gzip"];

/**
 * Build a zola toolchain API. Tests can pass a fake host implementation.
 *
 * @param {object} [host]
 * @returns {object}
 */
export function createZolaToolchainApi(host = defaultHost) {
    let defaultVersion = null;
    let defaultToolchain = null;
    // Declared lazily, once, the first time a toolchain is declared — target()
    // addresses are only assigned at workspace-load time, so this must happen
    // at BUILD.js top level rather than inside acquireToolchain() at execution time.
    let coreToolHandles = null;

    function declareToolchain(version, opts = {}) {
        host.namedCache({ name: ZOLA_TOOLCHAIN_CACHE });
        if (!coreToolHandles) {
            coreToolHandles = CORE_TOOL_NAMES.map((name) => host.nativeTool(name));
        }

        const toolchain = target({
            kind: "zola-toolchain",
            attrs: { version },
        });

        if (opts.default) {
            defaultVersion = version;
            defaultToolchain = toolchain;
        }

        return toolchain;
    }

    function installToolchain(version, source) {
        host.namedCache({ name: ZOLA_TOOLCHAIN_CACHE });
        const plat = host.platformInfo();
        const key = zolaCacheKey(version, plat);
        host.cachePut(ZOLA_TOOLCHAIN_CACHE, key, source);
        return host.cacheGet(ZOLA_TOOLCHAIN_CACHE, key);
    }

    async function acquireToolchain(version) {
        const plat = host.platformInfo();
        const key = zolaCacheKey(version, plat);

        if (host.cacheHas(ZOLA_TOOLCHAIN_CACHE, key)) {
            return host.cacheGet(ZOLA_TOOLCHAIN_CACHE, key);
        }
        if (!coreToolHandles) {
            throw new Error("no zola toolchain declared via zolaToolchain(); nothing to acquire");
        }

        const coreTools = await Promise.all(coreToolHandles.map((handle) => host.nativeToolSpec(handle)));

        const artifact = zolaArtifactName(version, plat);
        const url = zolaDownloadUrl(version, plat);
        const downloadPath = `.imp/zola-downloads/${key}/${artifact}`;
        const extractPath = `.imp/zola-toolchains/${key}`;

        await host.run({
            argv: ["sh", "-c", 'mkdir -p "$(dirname "$1")" && curl -fSL -o "$1" "$2"', "download-zola", downloadPath, url],
            tools: coreTools,
            outputs: [host.output(host.output_path(downloadPath))],
            display: `download zola ${version} (${plat.os}/${plat.arch})`,
        });

        // Zola's release tarball ships the `zola` binary at the archive root
        // (no wrapping directory), so no --strip-components is needed.
        await host.run({
            argv: ["sh", "-c", 'mkdir -p "$2" && tar -xf "$1" -C "$2"', "extract-zola", downloadPath, extractPath],
            tools: coreTools,
            inputs: [{ kind: "file", path: downloadPath }],
            outputs: [
                host.output(host.output_path(extractPath), {
                    kind: "directory",
                    namedCache: { name: ZOLA_TOOLCHAIN_CACHE, key },
                }),
            ],
            display: `extract zola ${version} (${plat.os}/${plat.arch})`,
        });

        return host.cacheGet(ZOLA_TOOLCHAIN_CACHE, key);
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
            throw new Error("no zola toolchain version specified and no default set");
        }
        return resolved;
    }

    async function bin(version) {
        const resolved = requireVersion(version);
        const dir = await acquireToolchain(resolved);
        const plat = host.platformInfo();
        return plat.os === "windows" ? `${dir}/zola.exe` : `${dir}/zola`;
    }

    async function tool(version) {
        const resolved = requireVersion(version);
        await acquireToolchain(resolved);
        const plat = host.platformInfo();
        return {
            kind: "tool",
            name: "zola",
            cache: ZOLA_TOOLCHAIN_CACHE,
            key: zolaCacheKey(resolved, plat),
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
        zolaToolchain: declareToolchain,
        installZolaToolchain: installToolchain,
        acquireZolaToolchain: acquireToolchain,
        resolveZolaToolchainVersion: resolveVersion,
        zolaBin: bin,
        zolaTool: tool,
        defaultZolaToolchainVersion: currentDefaultVersion,
        defaultZolaToolchain: currentDefaultToolchain,
    };
}

const defaultApi = createZolaToolchainApi();

/**
 * Declare a zola toolchain version and optionally set it as the default.
 *
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @returns {object} Target handle for this zola toolchain.
 */
export function zolaToolchain(version, opts = {}) {
    return defaultApi.zolaToolchain(version, opts);
}

/**
 * Install a local zola toolchain directory into the named cache.
 *
 * @param {string} version
 * @param {string} source Path to the toolchain root.
 * @returns {string|null} Local path to the cached toolchain root.
 */
export function installZolaToolchain(version, source) {
    return defaultApi.installZolaToolchain(version, source);
}

/**
 * Acquire a zola toolchain, downloading and caching it if not already
 * installed in the named cache.
 *
 * @param {string} version
 * @returns {Promise<string>} Local path to the toolchain root.
 */
export function acquireZolaToolchain(version) {
    return defaultApi.acquireZolaToolchain(version);
}

/**
 * Resolve an explicit or default zola toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveZolaToolchainVersion(version) {
    return defaultApi.resolveZolaToolchainVersion(version);
}

/**
 * Return the zola executable path for a toolchain version.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export function zolaBin(version) {
    return defaultApi.zolaBin(version);
}

/**
 * Return a named-cache-backed zola tool descriptor for sandbox execution.
 *
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export function zolaTool(version) {
    return defaultApi.zolaTool(version);
}

/**
 * Return the currently configured default zola toolchain version.
 *
 * @returns {string|null}
 */
export function defaultZolaToolchainVersion() {
    return defaultApi.defaultZolaToolchainVersion();
}

/**
 * Return the currently configured default zola toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultZolaToolchain() {
    return defaultApi.defaultZolaToolchain();
}
