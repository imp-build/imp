import { Target, product, namedCache, run, output, output_path, platformInfo, cachePut, cacheGet, cacheHas } from "imp:core";

import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";
import { generateToolLockfile } from "//rules/workflows/lockfiles";

const MOLD_TOOLCHAIN_CACHE = "mold-toolchains";

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

// Bare coreutils used by the install script below. The sandbox is fully
// hermetic — even `mkdir`/`tar` must be declared tools, not resolved from an
// ambient or fixed-base PATH. GNU tar shells out to a separate `gzip`
// process to decompress `.tar.gz`.
const CORE_TOOL_NAMES = ["curl", "mkdir", "tar", "gzip"];

export class MoldToolchain extends Target {
    static kind = "mold-toolchain";
    constructor({ version }) {
        super({ kind: MoldToolchain.kind, attrs: { version } });
    }
}

let defaultVersion = null;
let defaultToolchain = null;
// Declared lazily, once, the first time a toolchain is declared — target()
// addresses are only assigned at workspace-load time, so this must happen
// at BUILD.js top level rather than inside acquireToolchain() at execution time.
let coreToolHandles = null;

export function __resetMoldToolchainStateForTest() {
    defaultVersion = null;
    defaultToolchain = null;
    coreToolHandles = null;
}

function requireVersion(version) {
    const resolved = resolveMoldToolchainVersion(version);
    if (!resolved) {
        throw new Error("no mold toolchain version specified and no default set");
    }
    return resolved;
}

/**
 * Declare a mold toolchain version and optionally set it as the default.
 *
 * @category configuration
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @returns {object} Target handle for this mold toolchain.
 */
export function moldToolchain(version, opts = {}) {
    namedCache({ name: MOLD_TOOLCHAIN_CACHE, shared: true });
    if (!coreToolHandles) {
        coreToolHandles = CORE_TOOL_NAMES.map((name) => nativeTool(name));
    }

    const toolchain = new MoldToolchain({ version });

    if (opts.default) {
        defaultVersion = version;
        defaultToolchain = toolchain;
    }

    return toolchain;
}

/**
 * Install a local mold toolchain directory into the named cache.
 *
 * @category configuration
 * @param {string} version
 * @param {string} source Path to the toolchain root.
 * @returns {string|null} Local path to the cached toolchain root.
 */
export function installMoldToolchain(version, source) {
    namedCache({ name: MOLD_TOOLCHAIN_CACHE, shared: true });
    const plat = platformInfo();
    const key = moldCacheKey(version, plat);
    cachePut(MOLD_TOOLCHAIN_CACHE, key, source);
    return cacheGet(MOLD_TOOLCHAIN_CACHE, key);
}

/**
 * Acquire a mold toolchain, downloading and caching it if not already
 * installed in the named cache.
 *
 * @category configuration
 * @param {string} version
 * @returns {Promise<string>} Local path to the toolchain root.
 */
export async function acquireMoldToolchain(version) {
    const plat = platformInfo();
    const key = moldCacheKey(version, plat);

    if (cacheHas(MOLD_TOOLCHAIN_CACHE, key)) {
        return cacheGet(MOLD_TOOLCHAIN_CACHE, key);
    }
    if (!coreToolHandles) {
        throw new Error("no mold toolchain declared via moldToolchain(); nothing to acquire");
    }

    const coreTools = await Promise.all(coreToolHandles.map((handle) => nativeToolSpec(handle)));

    const url = moldDownloadUrl(version, plat);
    const extractPath = `.imp/mold-toolchains/${key}`;

    // mold's release tarball already ships bin/mold and bin/ld.mold
    // (the name clang's -fuse-ld=mold looks for) — no wrapper needed. tar
    // can't sniff compression from a pipe, so -z (gzip) must be explicit.
    await run({
        argv: ["sh", "-c", 'mkdir -p "$2" && curl -fSL "$1" | tar -xzf - -C "$2" --strip-components=1', "install-mold", url, extractPath],
        tools: coreTools,
        outputs: [
            output(output_path(extractPath), {
                kind: "directory",
                namedCache: { name: MOLD_TOOLCHAIN_CACHE, key },
            }),
        ],
        materialize: false,
        display: `install mold ${version} (${plat.os}/${plat.arch})`,
    });

    return cacheGet(MOLD_TOOLCHAIN_CACHE, key);
}

/**
 * Resolve an explicit or default mold toolchain version.
 *
 * @category configuration
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveMoldToolchainVersion(version) {
    if (version) {
        return version;
    }
    return defaultVersion;
}

/**
 * Return the mold executable path for a toolchain version.
 *
 * @category configuration
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function moldBin(version) {
    const resolved = requireVersion(version);
    const dir = await acquireMoldToolchain(resolved);
    return `${dir}/bin/mold`;
}

/**
 * Return a named-cache-backed mold tool descriptor for sandbox execution.
 *
 * @category configuration
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function moldTool(version) {
    const resolved = requireVersion(version);
    await acquireMoldToolchain(resolved);
    const plat = platformInfo();
    return {
        kind: "tool",
        name: "mold",
        cache: MOLD_TOOLCHAIN_CACHE,
        key: moldCacheKey(resolved, plat),
        binDirs: ["bin"],
    };
}

/**
 * Return the currently configured default mold toolchain version.
 *
 * @category configuration
 * @returns {string|null}
 */
export function defaultMoldToolchainVersion() {
    return defaultVersion;
}

/**
 * Return the currently configured default mold toolchain target handle.
 *
 * @category configuration
 * @returns {object|null}
 */
export function defaultMoldToolchain() {
    return defaultToolchain;
}

product("mold-toolchain", "gen-lockfiles", (handle) =>
    generateToolLockfile({
        handle,
        name: "mold",
        platforms: moldSupportedPlatforms(),
        downloadUrl: moldDownloadUrl,
        artifactName: moldArtifactName,
    }));

/**
 * Adapter exposing a mold toolchain as Odin's `-linker:mold` linker role.
 * Registered as the "odin-linker" product for the "mold-toolchain" kind so
 * odinScriptTools() (rules/odin/index.js) can resolve it dynamically via
 * productFor(handle, "odin-linker") instead of a hardcoded default lookup.
 */
export class OdinMoldLinker {
    constructor(handle) {
        this.handle = handle;
    }

    /** @returns {Promise<object[]>} run({ tools }) entries this linker needs. */
    async tools() {
        return [await moldTool(this.handle.attrs.version)];
    }

    /** @returns {Promise<string[]>} Odin CLI flags selecting this linker. */
    async flags() {
        return ["-linker:mold"];
    }
}

product("mold-toolchain", "odin-linker", (handle) => new OdinMoldLinker(handle));

/**
 * Adapter exposing a mold toolchain as Rust/rustc's backend linker via
 * `-fuse-ld=mold`, layered on whatever C link driver rustc uses (see
 * RustGccLinkDriver in //rules/c/gcc/toolchain). Registered as the
 * "rust-linker" product for the "mold-toolchain" kind.
 */
export class RustMoldLinker {
    constructor(handle) {
        this.handle = handle;
    }

    async tools() {
        return [await moldTool(this.handle.attrs.version)];
    }

    /** @returns {Promise<string[]>} paired rustc -C flags enabling mold. */
    async rustflags() {
        return ["-C", "link-arg=-fuse-ld=mold"];
    }
}

product("mold-toolchain", "rust-linker", (handle) => new RustMoldLinker(handle));
