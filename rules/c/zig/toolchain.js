import { Target, product, namedCache, run, output, output_path, platformInfo, cachePut, cacheGet, cacheHas } from "imp:core";

import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";
import { generateToolLockfile } from "//rules/workflows/lockfiles";

const ZIG_TOOLCHAIN_CACHE = "zig-toolchains";

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

// The platforms this module acquires Zig for (see requireSupportedPlatform):
// Linux and Windows on x86_64/aarch64. Zig ships macOS too, but that isn't
// wired here, so it stays out of the lockfile matrix.
const ZIG_SUPPORTED_PLATFORMS = [
    { os: "linux", arch: "x86_64" },
    { os: "linux", arch: "aarch64" },
    { os: "windows", arch: "x86_64" },
    { os: "windows", arch: "aarch64" },
];

/**
 * Return the platforms this module resolves Zig release archives for.
 *
 * @returns {Array<{ os: string, arch: string }>}
 */
export function zigSupportedPlatforms() {
    return ZIG_SUPPORTED_PLATFORMS.map((plat) => ({ ...plat }));
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
 * Also includes generically-named `clang`/`ar` wrappers (unix) or
 * `clang.bat`/`ar.bat` (windows) alongside the zig-prefixed ones — for
 * callers (e.g. Odin) that invoke a hardcoded program name rather than
 * accepting a configurable compiler/archiver path.
 *
 * @param {{ os: string }} plat
 * @returns {{ ar: string, ranlib: string, clang: string, genericAr: string }}
 */
function wrapperNames(plat) {
    return plat.os === "windows"
        ? { ar: "zigar.bat", ranlib: "zigranlib.bat", clang: "clang.bat", genericAr: "ar.bat" }
        : { ar: "zigar", ranlib: "zigranlib", clang: "clang", genericAr: "ar" };
}

export class ZigToolchain extends Target {
    static kind = "zig-toolchain";
    constructor({ version }) {
        super({ kind: ZigToolchain.kind, attrs: { version } });
    }
}

let defaultVersion = null;
let defaultToolchain = null;
// Declared lazily, once, the first time a toolchain is declared — target()
// addresses are only assigned at workspace-load time, so this must happen
// at BUILD.js top level rather than inside acquireToolchain() at execution time.
let coreToolHandles = null;

export function __resetZigToolchainStateForTest() {
    defaultVersion = null;
    defaultToolchain = null;
    coreToolHandles = null;
}

function requireVersion(version) {
    const resolved = resolveZigToolchainVersion(version);
    if (!resolved) {
        throw new Error("no Zig toolchain version specified and no default set");
    }
    return resolved;
}

/**
 * Declare a Zig toolchain version and optionally set it as the default.
 *
 * @category configuration
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @returns {object} Target handle for this Zig toolchain.
 */
export function zigToolchain(version, opts = {}) {
    namedCache({ name: ZIG_TOOLCHAIN_CACHE });
    if (!coreToolHandles) {
        coreToolHandles = coreToolNames(platformInfo()).map((name) => nativeTool(name));
    }

    const toolchain = new ZigToolchain({ version });

    if (opts.default) {
        defaultVersion = version;
        defaultToolchain = toolchain;
    }

    return toolchain;
}

/**
 * Install a local Zig toolchain directory into the named cache.
 *
 * @category configuration
 * @param {string} version
 * @param {string} source Path to the toolchain root.
 * @returns {string|null} Local path to the cached toolchain root.
 */
export function installZigToolchain(version, source) {
    namedCache({ name: ZIG_TOOLCHAIN_CACHE });
    const plat = platformInfo();
    const key = zigCacheKey(version, plat);
    cachePut(ZIG_TOOLCHAIN_CACHE, key, source);
    return cacheGet(ZIG_TOOLCHAIN_CACHE, key);
}

/**
 * Acquire a Zig toolchain, downloading and caching it if not already
 * installed in the named cache.
 *
 * @category configuration
 * @param {string} version
 * @returns {Promise<string>} Local path to the toolchain root.
 */
export async function acquireZigToolchain(version) {
    const plat = platformInfo();
    const key = zigCacheKey(version, plat);

    if (cacheHas(ZIG_TOOLCHAIN_CACHE, key)) {
        return cacheGet(ZIG_TOOLCHAIN_CACHE, key);
    }
    if (!coreToolHandles) {
        throw new Error("no Zig toolchain declared via zigToolchain(); nothing to acquire");
    }

    const coreTools = await Promise.all(coreToolHandles.map((handle) => nativeToolSpec(handle)));

    const artifact = zigArtifactName(version, plat);
    const url = zigDownloadUrl(version, plat);
    const downloadPath = `.imp/zig-downloads/${key}/${artifact}`;
    const extractPath = `.imp/zig-toolchains/${key}`;
    const zigExe = plat.os === "windows" ? "zig.exe" : "zig";
    const { ar, ranlib, clang, genericAr } = wrapperNames(plat);
    // Wrapper content rides in argv (positional $N) so it keys the task
    // cache without any shell interpolation touching it, same pattern as
    // odinGenRun's generated-file writes. Each wrapper is a
    // (content, filename) positional pair after $1 (downloadPath)/$2
    // (extractPath).
    const wrappers = [
        [wrapperContent(plat, zigExe, "ar"), ar],
        [wrapperContent(plat, zigExe, "ranlib"), ranlib],
        [wrapperContent(plat, zigExe, "cc"), clang],
        [wrapperContent(plat, zigExe, "ar"), genericAr],
    ];
    const wrapperArgs = wrappers.flat();
    // Shell positional params past $9 need brace syntax ($10, not $10
    // which parses as ${1}0).
    const pos = (n) => (n >= 10 ? `\${${n}}` : `$${n}`);
    const writeCmds = wrappers.map((_, i) => `printf %s "${pos(3 + i * 2)}" > "$2/${pos(4 + i * 2)}"`);
    const chmodCmd = plat.os === "windows"
        ? ""
        : ` && ${wrappers.map((_, i) => `chmod +x "$2/${pos(4 + i * 2)}"`).join(" && ")}`;
    const extractScript = `mkdir -p "$2" && tar -xf "$1" -C "$2" --strip-components=1 && ${writeCmds.join(" && ")}${chmodCmd}`;

    await run({
        argv: ["sh", "-c", 'mkdir -p "$(dirname "$1")" && curl -fSL -o "$1" "$2"', "download-zig", downloadPath, url],
        tools: coreTools,
        outputs: [output(output_path(downloadPath))],
        materialize: true,
        display: `download zig ${version} (${plat.os}/${plat.arch})`,
    });

    await run({
        argv: ["sh", "-c", extractScript, "extract-zig", downloadPath, extractPath, ...wrapperArgs],
        tools: coreTools,
        inputs: [{ kind: "file", path: downloadPath }],
        outputs: [
            output(output_path(extractPath), {
                kind: "directory",
                namedCache: { name: ZIG_TOOLCHAIN_CACHE, key },
            }),
        ],
        materialize: true,
        display: `extract zig ${version} (${plat.os}/${plat.arch})`,
    });

    return cacheGet(ZIG_TOOLCHAIN_CACHE, key);
}

/**
 * Resolve an explicit or default Zig toolchain version.
 *
 * @category configuration
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveZigToolchainVersion(version) {
    if (version) {
        return version;
    }
    return defaultVersion;
}

/**
 * Return the zig executable path for a toolchain version.
 *
 * @category configuration
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function zigBin(version) {
    const resolved = requireVersion(version);
    const dir = await acquireZigToolchain(resolved);
    const exe = platformInfo().os === "windows" ? "zig.exe" : "zig";
    return `${dir}/${exe}`;
}

/**
 * Return a named-cache-backed Zig tool descriptor for sandbox execution.
 *
 * @category configuration
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function zigTool(version) {
    const resolved = requireVersion(version);
    await acquireZigToolchain(resolved);
    const plat = platformInfo();
    return {
        kind: "tool",
        name: "zig",
        cache: ZIG_TOOLCHAIN_CACHE,
        key: zigCacheKey(resolved, plat),
        binDirs: ["."],
    };
}

/**
 * Return the CMake -D flags to configure this Zig toolchain as the C/C++
 * compiler and archiver.
 *
 * @category configuration
 * @param {string} [version]
 * @returns {Promise<string[]>}
 */
export async function zigCMakeArgs(version) {
    const resolved = requireVersion(version);
    await acquireZigToolchain(resolved);
    const plat = platformInfo();
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

/**
 * Return the currently configured default Zig toolchain version.
 *
 * @category configuration
 * @returns {string|null}
 */
export function defaultZigToolchainVersion() {
    return defaultVersion;
}

/**
 * Return the currently configured default Zig toolchain target handle.
 *
 * @category configuration
 * @returns {object|null}
 */
export function defaultZigToolchain() {
    return defaultToolchain;
}

product("zig-toolchain", "gen-lockfiles", (handle) =>
    generateToolLockfile({
        handle,
        name: "zig",
        platforms: zigSupportedPlatforms(),
        downloadUrl: zigDownloadUrl,
        artifactName: zigArtifactName,
    }));
