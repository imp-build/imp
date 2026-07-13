import { Target, product, namedCache, run, output, output_path, platformInfo, cachePut, cacheGet, cacheHas } from "imp:core";

import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";
import { generateToolLockfile, registerBuiltinLockfile } from "//rules/workflows/lockfiles";

const GCC_TOOLCHAIN_CACHE = "gcc-toolchains";

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
 * Return the platforms Bootlin publishes a prebuilt gcc toolchain for. Bootlin
 * only ships Linux; the arch set comes from the module's BOOTLIN_ARCH map.
 *
 * @returns {Array<{ os: string, arch: string }>}
 */
export function gccSupportedPlatforms() {
    return Object.keys(BOOTLIN_ARCH).map((arch) => ({ os: "linux", arch }));
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

// Bare coreutils used by the install script below. The sandbox is fully
// hermetic — even `mkdir`/`tar` must be declared tools, not resolved from an
// ambient or fixed-base PATH. GNU tar shells out to a separate `xz` process
// to decompress `.tar.xz`.
const CORE_TOOL_NAMES = ["curl", "mkdir", "tar", "xz", "chmod"];

export class GccToolchain extends Target {
    static kind = "gcc-toolchain";
    constructor({ version }) {
        super({ kind: GccToolchain.kind, attrs: { version } });
    }
}

let defaultVersion = null;
let defaultToolchain = null;
// Declared lazily, once, the first time a toolchain is declared — target()
// addresses are only assigned at workspace-load time, so this must happen
// at BUILD.js top level rather than inside acquireToolchain() at execution time.
let coreToolHandles = null;

export function __resetGccToolchainStateForTest() {
    defaultVersion = null;
    defaultToolchain = null;
    coreToolHandles = null;
}

function requireVersion(version) {
    const resolved = resolveGccToolchainVersion(version);
    if (!resolved) {
        throw new Error("no gcc toolchain version specified and no default set");
    }
    return resolved;
}

/**
 * Declare a gcc toolchain version and optionally set it as the default.
 *
 * @param {string} version Bootlin toolchain release version, e.g. "2025.08-1".
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @returns {object} Target handle for this gcc toolchain.
 * @category configuration
 */
export function gccToolchain(version, opts = {}) {
    namedCache({ name: GCC_TOOLCHAIN_CACHE, shared: true });
    if (!coreToolHandles) {
        coreToolHandles = CORE_TOOL_NAMES.map((name) => nativeTool(name));
    }

    const toolchain = new GccToolchain({ version });

    if (opts.default) {
        defaultVersion = version;
        defaultToolchain = toolchain;
    }

    return toolchain;
}

/**
 * Install a local gcc toolchain directory into the named cache.
 *
 * @param {string} version
 * @param {string} source Path to the toolchain root.
 * @returns {string|null} Local path to the cached toolchain root.
 */
export function installGccToolchain(version, source) {
    namedCache({ name: GCC_TOOLCHAIN_CACHE, shared: true });
    const plat = platformInfo();
    const key = gccCacheKey(version, plat);
    cachePut(GCC_TOOLCHAIN_CACHE, key, source);
    return cacheGet(GCC_TOOLCHAIN_CACHE, key);
}

/**
 * Acquire a gcc toolchain, downloading and caching it if not already
 * installed in the named cache.
 *
 * @param {string} version
 * @returns {Promise<string>} Local path to the toolchain root.
 */
export async function acquireGccToolchain(version) {
    const plat = platformInfo();
    const key = gccCacheKey(version, plat);

    if (cacheHas(GCC_TOOLCHAIN_CACHE, key)) {
        return cacheGet(GCC_TOOLCHAIN_CACHE, key);
    }
    if (!coreToolHandles) {
        throw new Error("no gcc toolchain declared via gccToolchain(); nothing to acquire");
    }

    const coreTools = await Promise.all(coreToolHandles.map((handle) => nativeToolSpec(handle)));

    const url = gccDownloadUrl(version, plat);
    const extractPath = `.imp/gcc-toolchains/${key}`;
    const gccExe = `${GCC_EXE_PREFIX[plat.arch]}-gcc`;
    const gxxExe = `${GCC_EXE_PREFIX[plat.arch]}-g++`;
    const arExe = `${BINUTILS_PREFIX[plat.arch]}-ar`;
    // Bootlin's own gcc binary is a `toolchain-wrapper` that's argv[0]-
    // sensitive; wrapper scripts that exec the real binary keep its own name.
    const wrappers = [
        [`#!/bin/sh\nexec "$(dirname "$0")/${gccExe}" "$@"\n`, "clang"],
        [`#!/bin/sh\nexec "$(dirname "$0")/${gccExe}" "$@"\n`, "cc"],
        [`#!/bin/sh\nexec "$(dirname "$0")/${gxxExe}" "$@"\n`, "c++"],
        [`#!/bin/sh\nexec "$(dirname "$0")/${arExe}" "$@"\n`, "ar"],
    ];
    const wrapperArgs = wrappers.flat();
    // $1 = url, $2 = extractPath, $3.. = wrapper (content, filename) pairs.
    const writeCmds = wrappers.map((_, i) => `printf %s "\${${3 + i * 2}}" > "$2/bin/\${${4 + i * 2}}"`);
    const chmodCmds = wrappers.map((_, i) => `chmod +x "$2/bin/\${${4 + i * 2}}"`);
    // tar can't sniff compression from a pipe (no filename to inspect), so
    // -J (xz) must be explicit here even though a file-based `-xf x.tar.xz`
    // wouldn't need it.
    const installScript = `mkdir -p "$2" && curl -fSL "$1" | tar -xJf - -C "$2" --strip-components=1 && ${writeCmds.join(" && ")} && ${chmodCmds.join(" && ")}`;

    await run({
        argv: ["sh", "-c", installScript, "install-gcc", url, extractPath, ...wrapperArgs],
        tools: coreTools,
        outputs: [
            output(output_path(extractPath), {
                kind: "directory",
                namedCache: { name: GCC_TOOLCHAIN_CACHE, key },
            }),
        ],
        materialize: false,
        display: `install gcc ${version} (${plat.os}/${plat.arch})`,
    });

    return cacheGet(GCC_TOOLCHAIN_CACHE, key);
}

/**
 * Resolve an explicit or default gcc toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveGccToolchainVersion(version) {
    if (version) {
        return version;
    }
    return defaultVersion;
}

/**
 * Return the gcc executable path for a toolchain version.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function gccBin(version) {
    const resolved = requireVersion(version);
    const dir = await acquireGccToolchain(resolved);
    const plat = platformInfo();
    return `${dir}/bin/${GCC_EXE_PREFIX[plat.arch]}-gcc`;
}

/**
 * Return a named-cache-backed gcc tool descriptor for sandbox execution.
 * Its bin/ directory also contains a `clang` wrapper script (Odin invokes a
 * program literally named "clang" to link) that execs the real gcc binary.
 *
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function gccTool(version) {
    const resolved = requireVersion(version);
    await acquireGccToolchain(resolved);
    const plat = platformInfo();
    return {
        kind: "tool",
        name: "gcc-toolchain",
        cache: GCC_TOOLCHAIN_CACHE,
        key: gccCacheKey(resolved, plat),
        binDirs: ["bin"],
    };
}

/**
 * Return the currently configured default gcc toolchain version.
 *
 * @returns {string|null}
 */
export function defaultGccToolchainVersion() {
    return defaultVersion;
}

/**
 * Return the currently configured default gcc toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultGccToolchain() {
    return defaultToolchain;
}

const LOCKFILE_SPEC = {
    name: "gcc",
    platforms: gccSupportedPlatforms(),
    downloadUrl: gccDownloadUrl,
    artifactName: gccArtifactName,
    lockfile: "//rules/c/gcc/gcc.lock",
};
product("gcc-toolchain", "gen-lockfiles", (handle) =>
    generateToolLockfile({ handle, ...LOCKFILE_SPEC }));
registerBuiltinLockfile({ ...LOCKFILE_SPEC, versions: ["2025.08-1"] });

/**
 * Adapter exposing a gcc toolchain as Rust/rustc's C link driver — the
 * program rustc shells out to as its linker driver. Reuses the same
 * "clang"-named wrapper script Odin uses for the same reason (see gccTool()
 * docs above). Registered as the "rust-link-driver" product for the
 * "gcc-toolchain" kind so rustLinkerTools() (rules/rust/index.js) can
 * resolve it dynamically via productFor(handle, "rust-link-driver") — this
 * module never imports anything Rust-specific.
 */
export class RustGccLinkDriver {
    constructor(handle) {
        this.handle = handle;
    }

    async tools() {
        // Always mounted, even when sccache is active: rustc still resolves
        // "clang" via PATH itself for the *link* step (its own direct
        // subprocess spawn, not something sccache wraps/caches), regardless
        // of what CC is set to below.
        return [await nativeToolSpec(nativeTool("dirname")), await gccTool(this.handle.attrs.version)];
    }

    /** @returns {Promise<string[]>} paired rustc -C flags selecting this link driver. */
    async rustflags() {
        return ["-C", "linker=clang"];
    }

    /**
     * @param {boolean} [sccacheActive] When cc-rs-driven build scripts (e.g.
     *   a dependency bundling and compiling its own C sources) see
     *   RUSTC_WRAPPER=sccache, they invoke `sccache clang ...` directly —
     *   sccache then treats "clang" as its own detected/cached compiler
     *   identity, hitting the exact same sandbox-symlink-vs-canonicalized-
     *   path bug documented on rustToolEnv() in //rules/rust, but for the C
     *   compiler instead of rustc. Resolving CC to the real, absolute,
     *   stable toolchain path (bypassing the sandbox "tool" mount, hence no
     *   `tools()` entry either) keeps that literal path identical across
     *   every sandbox when sccache is active.
     * @returns {Promise<string[]>} extra env vars so cc-rs-driven build
     * scripts can find a real C compiler too, instead of only rustc's own
     * linker knowing about the "clang"-named wrapper via rustflags() above.
     */
    async env(sccacheActive) {
        if (sccacheActive) {
            const dir = await acquireGccToolchain(this.handle.attrs.version);
            return [`CC=${dir}/bin/clang`];
        }
        return ["CC=clang"];
    }
}

product("gcc-toolchain", "rust-link-driver", (handle) => new RustGccLinkDriver(handle));
