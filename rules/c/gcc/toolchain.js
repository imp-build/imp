import { target, namedCache, run, output, output_path, platformInfo, cachePut, cacheGet, cacheHas } from "imp:core";
import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";

const GCC_TOOLCHAIN_CACHE = "gcc-toolchains";

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

// Bootlin only publishes prebuilt Linux toolchains; this doesn't cover
// Windows (a different linking story entirely — MSVC link.exe — and out of
// scope here).
function requireSupportedPlatform(plat) {
    if (plat.os !== "linux") {
        throw new Error(`unsupported gcc toolchain OS: ${plat.os}`);
    }
    if (plat.arch !== "x86_64") {
        throw new Error(`unsupported gcc toolchain architecture: ${plat.arch}`);
    }
}

// Bootlin's own arch naming (e.g. "x86-64", not "x86_64"), the short prefix
// used by the toolchain's own convenience aliases (e.g. "x86_64-linux-gcc"),
// and the full buildroot prefix used by its real binutils binaries (which
// aren't given a short alias, e.g. "x86_64-buildroot-linux-gnu-ar").
const BOOTLIN_ARCH = { x86_64: "x86-64" };
const GCC_EXE_PREFIX = { x86_64: "x86_64-linux" };
const BINUTILS_PREFIX = { x86_64: "x86_64-buildroot-linux-gnu" };

/**
 * Return the Bootlin toolchain name for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function gccArtifactName(version, plat) {
    requireSupportedPlatform(plat);
    return `${BOOTLIN_ARCH[plat.arch]}--glibc--stable-${version}.tar.xz`;
}

/**
 * Return the Bootlin toolchain download URL for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function gccDownloadUrl(version, plat) {
    requireSupportedPlatform(plat);
    return `https://toolchains.bootlin.com/downloads/releases/toolchains/${BOOTLIN_ARCH[plat.arch]}/tarballs/${gccArtifactName(version, plat)}`;
}

/**
 * Return the named-cache key for a gcc toolchain version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function gccCacheKey(version, plat) {
    return `${version}/${plat.os}-${plat.arch}`;
}

// Bare coreutils used by the download/extract scripts below. The sandbox is
// fully hermetic — even `mkdir`/`dirname`/`tar` must be declared tools, not
// resolved from an ambient or fixed-base PATH. GNU tar shells out to a
// separate `xz` process to decompress `.tar.xz`.
const CORE_TOOL_NAMES = ["curl", "mkdir", "dirname", "tar", "xz", "chmod"];

/**
 * Build a gcc toolchain API. Tests can pass a fake host implementation.
 *
 * @param {object} [host]
 * @returns {object}
 */
export function createGccToolchainApi(host = defaultHost) {
    let defaultVersion = null;
    let defaultToolchain = null;
    // Declared lazily, once, the first time a toolchain is declared — target()
    // addresses are only assigned at workspace-load time, so this must happen
    // at BUILD.js top level rather than inside acquireToolchain() at execution time.
    let coreToolHandles = null;

    function declareToolchain(version, opts = {}) {
        host.namedCache({ name: GCC_TOOLCHAIN_CACHE });
        if (!coreToolHandles) {
            coreToolHandles = CORE_TOOL_NAMES.map((name) => host.nativeTool(name));
        }

        const toolchain = target({
            kind: "gcc-toolchain",
            attrs: { version },
        });

        if (opts.default) {
            defaultVersion = version;
            defaultToolchain = toolchain;
        }

        return toolchain;
    }

    function installToolchain(version, source) {
        host.namedCache({ name: GCC_TOOLCHAIN_CACHE });
        const plat = host.platformInfo();
        const key = gccCacheKey(version, plat);
        host.cachePut(GCC_TOOLCHAIN_CACHE, key, source);
        return host.cacheGet(GCC_TOOLCHAIN_CACHE, key);
    }

    async function acquireToolchain(version) {
        const plat = host.platformInfo();
        const key = gccCacheKey(version, plat);

        if (host.cacheHas(GCC_TOOLCHAIN_CACHE, key)) {
            return host.cacheGet(GCC_TOOLCHAIN_CACHE, key);
        }
        if (!coreToolHandles) {
            throw new Error("no gcc toolchain declared via gccToolchain(); nothing to acquire");
        }

        const coreTools = await Promise.all(coreToolHandles.map((handle) => host.nativeToolSpec(handle)));

        const artifact = gccArtifactName(version, plat);
        const url = gccDownloadUrl(version, plat);
        const downloadPath = `.imp/gcc-downloads/${key}/${artifact}`;
        const extractPath = `.imp/gcc-toolchains/${key}`;
        const gccExe = `${GCC_EXE_PREFIX[plat.arch]}-gcc`;
        const arExe = `${BINUTILS_PREFIX[plat.arch]}-ar`;
        // Bootlin's own gcc binary is a `toolchain-wrapper` that's
        // argv[0]-sensitive (it looks for a sibling "<own-name>.br_real"
        // binary) — a raw rename/symlink to "clang" breaks it. A wrapper
        // *script* that execs it by its real name works fine (verified).
        // `ar` (Odin's own `-build-mode:lib` invokes it by that bare name)
        // is a real binutils binary with no such argv[0] sensitivity, but
        // gets a wrapper too for a uniform, single write mechanism. Content
        // rides in argv (positional $N) so it keys the task cache without
        // any shell interpolation touching it, same pattern as
        // rules/c/zig/toolchain.js's wrapper writes.
        const wrappers = [
            [`#!/bin/sh\nexec "$(dirname "$0")/${gccExe}" "$@"\n`, "clang"],
            [`#!/bin/sh\nexec "$(dirname "$0")/${arExe}" "$@"\n`, "ar"],
        ];
        const wrapperArgs = wrappers.flat();
        const writeCmds = wrappers.map((_, i) => `printf %s "$${3 + i * 2}" > "$2/bin/$${4 + i * 2}"`);
        const chmodCmds = wrappers.map((_, i) => `chmod +x "$2/bin/$${4 + i * 2}"`);
        const extractScript = `mkdir -p "$2" && tar -xf "$1" -C "$2" --strip-components=1 && ${writeCmds.join(" && ")} && ${chmodCmds.join(" && ")}`;

        await host.run({
            argv: ["sh", "-c", 'mkdir -p "$(dirname "$1")" && curl -fSL -o "$1" "$2"', "download-gcc", downloadPath, url],
            tools: coreTools,
            outputs: [host.output(host.output_path(downloadPath))],
            display: `download gcc ${version} (${plat.os}/${plat.arch})`,
        });

        await host.run({
            argv: ["sh", "-c", extractScript, "extract-gcc", downloadPath, extractPath, ...wrapperArgs],
            tools: coreTools,
            inputs: [{ kind: "file", path: downloadPath }],
            outputs: [
                host.output(host.output_path(extractPath), {
                    kind: "directory",
                    namedCache: { name: GCC_TOOLCHAIN_CACHE, key },
                }),
            ],
            display: `extract gcc ${version} (${plat.os}/${plat.arch})`,
        });

        return host.cacheGet(GCC_TOOLCHAIN_CACHE, key);
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
            throw new Error("no gcc toolchain version specified and no default set");
        }
        return resolved;
    }

    async function bin(version) {
        const resolved = requireVersion(version);
        const dir = await acquireToolchain(resolved);
        const plat = host.platformInfo();
        return `${dir}/bin/${GCC_EXE_PREFIX[plat.arch]}-gcc`;
    }

    async function tool(version) {
        const resolved = requireVersion(version);
        await acquireToolchain(resolved);
        const plat = host.platformInfo();
        return {
            kind: "tool",
            name: "gcc-toolchain",
            cache: GCC_TOOLCHAIN_CACHE,
            key: gccCacheKey(resolved, plat),
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
        gccToolchain: declareToolchain,
        installGccToolchain: installToolchain,
        acquireGccToolchain: acquireToolchain,
        resolveGccToolchainVersion: resolveVersion,
        gccBin: bin,
        gccTool: tool,
        defaultGccToolchainVersion: currentDefaultVersion,
        defaultGccToolchain: currentDefaultToolchain,
    };
}

const defaultApi = createGccToolchainApi();

/**
 * Declare a gcc toolchain version and optionally set it as the default.
 *
 * @param {string} version Bootlin toolchain release version, e.g. "2025.08-1".
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @returns {object} Target handle for this gcc toolchain.
 */
export function gccToolchain(version, opts = {}) {
    return defaultApi.gccToolchain(version, opts);
}

/**
 * Install a local gcc toolchain directory into the named cache.
 *
 * @param {string} version
 * @param {string} source Path to the toolchain root.
 * @returns {string|null} Local path to the cached toolchain root.
 */
export function installGccToolchain(version, source) {
    return defaultApi.installGccToolchain(version, source);
}

/**
 * Acquire a gcc toolchain, downloading and caching it if not already
 * installed in the named cache.
 *
 * @param {string} version
 * @returns {Promise<string>} Local path to the toolchain root.
 */
export function acquireGccToolchain(version) {
    return defaultApi.acquireGccToolchain(version);
}

/**
 * Resolve an explicit or default gcc toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveGccToolchainVersion(version) {
    return defaultApi.resolveGccToolchainVersion(version);
}

/**
 * Return the gcc executable path for a toolchain version.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export function gccBin(version) {
    return defaultApi.gccBin(version);
}

/**
 * Return a named-cache-backed gcc tool descriptor for sandbox execution.
 * Its bin/ directory also contains a `clang` wrapper script (Odin invokes a
 * program literally named "clang" to link) that execs the real gcc binary.
 *
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export function gccTool(version) {
    return defaultApi.gccTool(version);
}

/**
 * Return the currently configured default gcc toolchain version.
 *
 * @returns {string|null}
 */
export function defaultGccToolchainVersion() {
    return defaultApi.defaultGccToolchainVersion();
}

/**
 * Return the currently configured default gcc toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultGccToolchain() {
    return defaultApi.defaultGccToolchain();
}
