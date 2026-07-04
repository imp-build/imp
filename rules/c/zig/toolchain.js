import { target, namedCache, run, output, output_path, platformInfo, cachePut, cacheGet, cacheHas } from "imp:core";
import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";

const ZIG_TOOLCHAIN_CACHE = "zig-toolchains";

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

function requireSupportedPlatform(plat) {
    if (plat.os !== "linux" && plat.os !== "windows") {
        throw new Error(`unsupported Zig toolchain OS: ${plat.os}`);
    }
    if (plat.arch !== "x86_64" && plat.arch !== "aarch64") {
        throw new Error(`unsupported Zig toolchain architecture: ${plat.arch}`);
    }
}

/**
 * Return the Zig release artifact filename for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function zigArtifactName(version, plat) {
    requireSupportedPlatform(plat);
    const ext = plat.os === "windows" ? "zip" : "tar.xz";
    return `zig-${plat.arch}-${plat.os}-${version}.${ext}`;
}

/**
 * Return the Zig release download URL for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function zigDownloadUrl(version, plat) {
    return `https://ziglang.org/download/${version}/${zigArtifactName(version, plat)}`;
}

/**
 * Return the named-cache key for a Zig toolchain version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function zigCacheKey(version, plat) {
    return `${version}/${plat.os}-${plat.arch}`;
}

// Bare coreutils used by the download/extract scripts below. The sandbox is
// fully hermetic — even `mkdir`/`dirname`/`tar` must be declared tools, not
// resolved from an ambient or fixed-base PATH. GNU tar shells out to a
// separate `xz` process to decompress `.tar.xz` on Linux; Windows extracts
// the `.zip` release via `tar.exe` (bsdtar) directly. Bare `sh` only
// auto-resolves on unix (see BUILTIN_SHELL_CANDIDATES in src/exec.rs), so
// Windows needs `sh` (Git Bash) declared as a tool too.
function coreToolNames(plat) {
    return [
        "curl",
        "mkdir",
        "dirname",
        "tar",
        ...(plat.os === "linux" ? ["xz", "chmod"] : []),
        ...(plat.os === "windows" ? ["sh"] : []),
    ];
}

function wrapperContent(plat, zigExe, subcommand) {
    return plat.os === "windows"
        ? `@"%~dp0${zigExe}" ${subcommand} %*\r\n`
        : `#!/bin/sh\nexec "$(dirname "$0")/${zigExe}" ${subcommand} "$@"\n`;
}

/**
 * Return the CMAKE_AR / CMAKE_RANLIB wrapper script filenames for a
 * platform (unix: executable shell scripts; windows: .bat files, since
 * CMAKE_AR/CMAKE_RANLIB must each be a single executable — unlike
 * CMAKE_<LANG>_COMPILER, there is no "extra arg" mechanism for them).
 *
 * @param {{ os: string }} plat
 * @returns {{ ar: string, ranlib: string }}
 */
function wrapperNames(plat) {
    return plat.os === "windows"
        ? { ar: "zigar.bat", ranlib: "zigranlib.bat" }
        : { ar: "zigar", ranlib: "zigranlib" };
}

/**
 * Build a Zig toolchain API. Tests can pass a fake host implementation, and
 * the install/acquire path can grow here without touching CMake integration.
 *
 * @param {object} [host]
 * @returns {object}
 */
export function createZigToolchainApi(host = defaultHost) {
    let defaultVersion = null;
    let defaultToolchain = null;
    // Declared lazily, once, the first time a toolchain is declared — target()
    // addresses are only assigned at workspace-load time, so this must happen
    // at BUILD.js top level rather than inside acquireToolchain() at execution time.
    let coreToolHandles = null;

    function declareToolchain(version, opts = {}) {
        host.namedCache({ name: ZIG_TOOLCHAIN_CACHE });
        if (!coreToolHandles) {
            coreToolHandles = coreToolNames(host.platformInfo()).map((name) => host.nativeTool(name));
        }

        const toolchain = target({
            kind: "zig-toolchain",
            attrs: { version },
        });

        if (opts.default) {
            defaultVersion = version;
            defaultToolchain = toolchain;
        }

        return toolchain;
    }

    function installToolchain(version, source) {
        host.namedCache({ name: ZIG_TOOLCHAIN_CACHE });
        const plat = host.platformInfo();
        const key = zigCacheKey(version, plat);
        host.cachePut(ZIG_TOOLCHAIN_CACHE, key, source);
        return host.cacheGet(ZIG_TOOLCHAIN_CACHE, key);
    }

    async function acquireToolchain(version) {
        const plat = host.platformInfo();
        const key = zigCacheKey(version, plat);

        if (host.cacheHas(ZIG_TOOLCHAIN_CACHE, key)) {
            return host.cacheGet(ZIG_TOOLCHAIN_CACHE, key);
        }
        if (!coreToolHandles) {
            throw new Error("no Zig toolchain declared via zigToolchain(); nothing to acquire");
        }

        const coreTools = await Promise.all(coreToolHandles.map((handle) => host.nativeToolSpec(handle)));

        const artifact = zigArtifactName(version, plat);
        const url = zigDownloadUrl(version, plat);
        const downloadPath = `.imp/zig-downloads/${key}/${artifact}`;
        const extractPath = `.imp/zig-toolchains/${key}`;
        const zigExe = plat.os === "windows" ? "zig.exe" : "zig";
        const { ar, ranlib } = wrapperNames(plat);
        const arContent = wrapperContent(plat, zigExe, "ar");
        const ranlibContent = wrapperContent(plat, zigExe, "ranlib");
        // Wrapper content rides in argv (positional $3.../$4...) so it keys
        // the task cache without any shell interpolation touching it, same
        // pattern as odinGenRun's generated-file writes.
        const chmod = plat.os === "windows" ? "" : ' && chmod +x "$2/$4" && chmod +x "$2/$6"';
        const extractScript = `mkdir -p "$2" && tar -xf "$1" -C "$2" --strip-components=1 && printf %s "$3" > "$2/$4" && printf %s "$5" > "$2/$6"${chmod}`;

        await host.run({
            argv: ["sh", "-c", 'mkdir -p "$(dirname "$1")" && curl -fSL -o "$1" "$2"', "download-zig", downloadPath, url],
            tools: coreTools,
            outputs: [host.output(host.output_path(downloadPath))],
            display: `download zig ${version} (${plat.os}/${plat.arch})`,
        });

        await host.run({
            argv: ["sh", "-c", extractScript, "extract-zig", downloadPath, extractPath, arContent, ar, ranlibContent, ranlib],
            tools: coreTools,
            inputs: [{ kind: "file", path: downloadPath }],
            outputs: [
                host.output(host.output_path(extractPath), {
                    kind: "directory",
                    namedCache: { name: ZIG_TOOLCHAIN_CACHE, key },
                }),
            ],
            display: `extract zig ${version} (${plat.os}/${plat.arch})`,
        });

        return host.cacheGet(ZIG_TOOLCHAIN_CACHE, key);
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
            throw new Error("no Zig toolchain version specified and no default set");
        }
        return resolved;
    }

    async function bin(version) {
        const resolved = requireVersion(version);
        const dir = await acquireToolchain(resolved);
        const exe = host.platformInfo().os === "windows" ? "zig.exe" : "zig";
        return `${dir}/${exe}`;
    }

    async function tool(version) {
        const resolved = requireVersion(version);
        await acquireToolchain(resolved);
        const plat = host.platformInfo();
        return {
            kind: "tool",
            name: "zig",
            cache: ZIG_TOOLCHAIN_CACHE,
            key: zigCacheKey(resolved, plat),
            binDirs: ["."],
        };
    }

    /**
     * Return the -D flags to wire a Zig toolchain into a CMake configure
     * call as CMAKE_C_COMPILER/CMAKE_CXX_COMPILER/CMAKE_AR/CMAKE_RANLIB.
     * Not wired into cmakeLib() yet — callers combine this with `tool()`'s
     * tool spec in their own `run()`/cmakeArgs.
     *
     * The compiler is given as a bare name — CMake's compiler detection
     * (CMakeDetermineCCompiler.cmake) re-resolves it via find_program+PATH
     * even when it's already a cache entry, and a *relative* path is
     * rejected outright ("is not a full path"), so this only works because
     * `tool()`'s spec puts "zig" on the sandbox PATH.
     *
     * CMAKE_AR/CMAKE_RANLIB behave differently: CMakeFindBinUtils.cmake's
     * find_program is a no-op once the cache var is already set (from our
     * -D), so it is *not* re-resolved via PATH — instead CMake's cache-entry
     * handling silently absolutizes a relative FILEPATH value against the
     * *cwd*. So these are given as paths relative to `.imp/tools/zig/` —
     * the fixed location run()'s sandbox always materializes a tool named
     * "zig" at (see materialize_tools_into_sandbox in src/exec.rs) — which
     * happens to equal the sandbox cwd. This only works when the caller
     * runs cmake inside the same sandboxed `run()` that also declares
     * `tool()`'s spec (default `sandbox: true`, not `sandbox: false`).
     *
     * @param {string} [version]
     * @returns {Promise<string[]>}
     */
    async function cmakeArgs(version) {
        const resolved = requireVersion(version);
        await acquireToolchain(resolved);
        const plat = host.platformInfo();
        const exe = plat.os === "windows" ? "zig.exe" : "zig";
        const { ar, ranlib } = wrapperNames(plat);
        const toolDir = ".imp/tools/zig";
        return [
            `-DCMAKE_C_COMPILER=${exe}`,
            "-DCMAKE_C_COMPILER_ARG1=cc",
            `-DCMAKE_CXX_COMPILER=${exe}`,
            "-DCMAKE_CXX_COMPILER_ARG1=c++",
            `-DCMAKE_AR=${toolDir}/${ar}`,
            `-DCMAKE_RANLIB=${toolDir}/${ranlib}`,
        ];
    }

    function currentDefaultVersion() {
        return defaultVersion;
    }

    function currentDefaultToolchain() {
        return defaultToolchain;
    }

    return {
        zigToolchain: declareToolchain,
        installZigToolchain: installToolchain,
        acquireZigToolchain: acquireToolchain,
        resolveZigToolchainVersion: resolveVersion,
        zigBin: bin,
        zigTool: tool,
        zigCMakeArgs: cmakeArgs,
        defaultZigToolchainVersion: currentDefaultVersion,
        defaultZigToolchain: currentDefaultToolchain,
    };
}

const defaultApi = createZigToolchainApi();

/**
 * Declare a Zig toolchain version and optionally set it as the default.
 *
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @returns {object} Target handle for this Zig toolchain.
 */
export function zigToolchain(version, opts = {}) {
    return defaultApi.zigToolchain(version, opts);
}

/**
 * Install a local Zig toolchain directory into the named cache.
 *
 * @param {string} version
 * @param {string} source Path to the toolchain root.
 * @returns {string|null} Local path to the cached toolchain root.
 */
export function installZigToolchain(version, source) {
    return defaultApi.installZigToolchain(version, source);
}

/**
 * Acquire a Zig toolchain, downloading and caching it if not already
 * installed in the named cache.
 *
 * @param {string} version
 * @returns {Promise<string>} Local path to the toolchain root.
 */
export function acquireZigToolchain(version) {
    return defaultApi.acquireZigToolchain(version);
}

/**
 * Resolve an explicit or default Zig toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveZigToolchainVersion(version) {
    return defaultApi.resolveZigToolchainVersion(version);
}

/**
 * Return the zig executable path for a toolchain version.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export function zigBin(version) {
    return defaultApi.zigBin(version);
}

/**
 * Return a named-cache-backed Zig tool descriptor for sandbox execution.
 *
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export function zigTool(version) {
    return defaultApi.zigTool(version);
}

/**
 * Return the CMake -D flags to configure this Zig toolchain as the C/C++
 * compiler and archiver.
 *
 * @param {string} [version]
 * @returns {Promise<string[]>}
 */
export function zigCMakeArgs(version) {
    return defaultApi.zigCMakeArgs(version);
}

/**
 * Return the currently configured default Zig toolchain version.
 *
 * @returns {string|null}
 */
export function defaultZigToolchainVersion() {
    return defaultApi.defaultZigToolchainVersion();
}

/**
 * Return the currently configured default Zig toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultZigToolchain() {
    return defaultApi.defaultZigToolchain();
}
