// sccache (https://github.com/mozilla/sccache) wraps rustc via RUSTC_WRAPPER
// and caches compiled objects keyed by the actual compiler inputs (source
// content, flags, compiler version) rather than by file mtimes — this is
// what makes it work at all despite imp's sandboxes being fresh/copied on
// every build, which otherwise defeats cargo's own mtime-based incremental
// fingerprinting (cargo's target-dir is never reused across invocations
// today; see the design discussion this toolchain was added for).
//
// Two named caches are used for two different reasons:
//   - SCCACHE_TOOLCHAIN_CACHE holds the downloaded sccache binary itself,
//     keyed by version+platform, exactly like rules/c/mold/toolchain.js.
//   - SCCACHE_DATA_CACHE holds sccache's own object cache (what SCCACHE_DIR
//     points at), keyed by platform only (not sccache version) since it's a
//     content-addressed object store sccache manages incrementally, not a
//     versioned tool install. It must be mounted as a "tool" (symlinked
//     in-place, not copied) so writes made during a build persist on disk
//     for the next invocation — see materialize_tools_into_sandbox in
//     src/exec.rs.
import { Target, product, namedCache, run, output, output_path, platformInfo, cachePut, cacheGet, cacheHas, workerStart } from "imp:core";

import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";
import { generateToolLockfile } from "//rules/workflows/lockfiles";

const SCCACHE_TOOLCHAIN_CACHE = "sccache-toolchains";
const SCCACHE_DATA_CACHE = "sccache-data";

// sccache ships musl builds for Linux (no glibc-version coupling needed) and
// native builds for macOS/Windows.
const TARGET_TRIPLES = {
    "linux-x86_64": "x86_64-unknown-linux-musl",
    "linux-aarch64": "aarch64-unknown-linux-musl",
    "macos-x86_64": "x86_64-apple-darwin",
    "macos-aarch64": "aarch64-apple-darwin",
    "windows-x86_64": "x86_64-pc-windows-msvc",
    "windows-aarch64": "aarch64-pc-windows-msvc",
};

function targetTriple(plat) {
    const triple = TARGET_TRIPLES[`${plat.os}-${plat.arch}`];
    if (!triple) {
        throw new Error(`unsupported sccache toolchain platform: ${plat.os}/${plat.arch}`);
    }
    return triple;
}

/**
 * Return the sccache release artifact filename for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function sccacheArtifactName(version, plat) {
    return `sccache-v${version}-${targetTriple(plat)}.tar.gz`;
}

/**
 * Return the sccache release download URL for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function sccacheDownloadUrl(version, plat) {
    return `https://github.com/mozilla/sccache/releases/download/v${version}/${sccacheArtifactName(version, plat)}`;
}

/**
 * Return the named-cache key for an sccache toolchain version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function sccacheCacheKey(version, plat) {
    return `${version}/${plat.os}-${plat.arch}`;
}

/**
 * Return the named-cache key for the sccache data (object cache) directory.
 * Deliberately independent of the sccache binary version — the on-disk cache
 * format is stable across sccache releases in practice, and there's no
 * reason to throw away accumulated cache hits on a routine sccache bump.
 *
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function sccacheDataCacheKey(plat) {
    return `${plat.os}-${plat.arch}`;
}

/**
 * Return the platforms sccache publishes release archives for.
 *
 * @returns {Array<{ os: string, arch: string }>}
 */
export function sccacheSupportedPlatforms() {
    return Object.keys(TARGET_TRIPLES).map((key) => {
        const sep = key.indexOf("-");
        return { os: key.slice(0, sep), arch: key.slice(sep + 1) };
    });
}

// Bare coreutils used by the install/init scripts below. The sandbox is
// fully hermetic — even `mkdir`/`tar` must be declared tools, not resolved
// from an ambient or fixed-base PATH.
const CORE_TOOL_NAMES = ["curl", "mkdir", "tar", "gzip"];

export class SccacheToolchain extends Target {
    static kind = "sccache-toolchain";
    constructor({ version }) {
        super({ kind: SccacheToolchain.kind, attrs: { version } });
    }
}

let defaultVersion = null;
let defaultToolchain = null;
// Declared lazily, once — target() addresses are only assigned at
// workspace-load time, so tool handles must be created when a toolchain is
// declared at BUILD.js top level, not inside acquireSccacheToolchain().
let coreToolHandles = null;

export function __resetSccacheToolchainStateForTest() {
    defaultVersion = null;
    defaultToolchain = null;
    coreToolHandles = null;
}

function requireVersion(version) {
    const resolved = resolveSccacheToolchainVersion(version);
    if (!resolved) {
        throw new Error("no sccache toolchain version specified and no default set");
    }
    return resolved;
}

/**
 * Declare an sccache toolchain version and optionally set it as the default.
 *
 * @category configuration
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @returns {object} Target handle for this sccache toolchain.
 */
export function sccacheToolchain(version, opts = {}) {
    namedCache({ name: SCCACHE_TOOLCHAIN_CACHE, shared: true });
    namedCache({ name: SCCACHE_DATA_CACHE });
    if (!coreToolHandles) {
        coreToolHandles = CORE_TOOL_NAMES.map((name) => nativeTool(name));
    }

    const toolchain = new SccacheToolchain({ version });

    if (opts.default) {
        defaultVersion = version;
        defaultToolchain = toolchain;
    }

    return toolchain;
}

/**
 * Install a local sccache toolchain directory into the named cache.
 *
 * @category configuration
 * @param {string} version
 * @param {string} source Path to the toolchain root.
 * @returns {string|null} Local path to the cached toolchain root.
 */
export function installSccacheToolchain(version, source) {
    namedCache({ name: SCCACHE_TOOLCHAIN_CACHE, shared: true });
    const plat = platformInfo();
    const key = sccacheCacheKey(version, plat);
    cachePut(SCCACHE_TOOLCHAIN_CACHE, key, source);
    return cacheGet(SCCACHE_TOOLCHAIN_CACHE, key);
}

/**
 * Acquire an sccache toolchain, downloading and caching it if not already
 * installed in the named cache.
 *
 * @category configuration
 * @param {string} version
 * @returns {Promise<string>} Local path to the toolchain root.
 */
export async function acquireSccacheToolchain(version) {
    const plat = platformInfo();
    const key = sccacheCacheKey(version, plat);

    if (cacheHas(SCCACHE_TOOLCHAIN_CACHE, key)) {
        return cacheGet(SCCACHE_TOOLCHAIN_CACHE, key);
    }
    if (!coreToolHandles) {
        throw new Error("no sccache toolchain declared via sccacheToolchain(); nothing to acquire");
    }

    const coreTools = await Promise.all(coreToolHandles.map((handle) => nativeToolSpec(handle)));

    const url = sccacheDownloadUrl(version, plat);
    const extractPath = `.imp/sccache-toolchains/${key}`;

    // tar can't sniff compression from a pipe, so -z (gzip) must be explicit.
    await run({
        argv: ["sh", "-c", 'mkdir -p "$2" && curl -fSL "$1" | tar -xzf - -C "$2" --strip-components=1', "install-sccache", url, extractPath],
        tools: coreTools,
        outputs: [
            output(output_path(extractPath), {
                kind: "directory",
                namedCache: { name: SCCACHE_TOOLCHAIN_CACHE, key },
            }),
        ],
        materialize: false,
        display: `install sccache ${version} (${plat.os}/${plat.arch})`,
    });

    return cacheGet(SCCACHE_TOOLCHAIN_CACHE, key);
}

/**
 * Ensure the sccache data (object cache) directory exists in the named
 * cache, seeding it with an empty directory the first time. Once seeded,
 * every build mounts this same on-disk directory as a "tool" (symlinked,
 * not copied — see materialize_tools_into_sandbox), so sccache's own cache
 * grows across separate imp invocations instead of starting from empty
 * every sandbox.
 *
 * @returns {Promise<string>} The named-cache key for the data directory.
 */
async function ensureSccacheDataDir() {
    const plat = platformInfo();
    const key = sccacheDataCacheKey(plat);
    if (cacheHas(SCCACHE_DATA_CACHE, key)) {
        return key;
    }
    if (!coreToolHandles) {
        throw new Error("no sccache toolchain declared via sccacheToolchain(); nothing to acquire");
    }
    const coreTools = await Promise.all(coreToolHandles.map((handle) => nativeToolSpec(handle)));
    const dataDir = `.imp/sccache-data/${key}`;

    await run({
        argv: ["sh", "-c", 'mkdir -p "$1"', "init-sccache-data", dataDir],
        tools: coreTools,
        outputs: [
            output(output_path(dataDir), {
                kind: "directory",
                namedCache: { name: SCCACHE_DATA_CACHE, key },
            }),
        ],
        materialize: false,
        display: `init sccache data dir (${plat.os}/${plat.arch})`,
    });

    return key;
}

/**
 * Resolve an explicit or default sccache toolchain version.
 *
 * @category configuration
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveSccacheToolchainVersion(version) {
    if (version) {
        return version;
    }
    return defaultVersion;
}

/**
 * Return a named-cache-backed sccache tool descriptor for sandbox execution.
 *
 * @category configuration
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function sccacheTool(version) {
    const resolved = requireVersion(version);
    await acquireSccacheToolchain(resolved);
    const plat = platformInfo();
    return {
        kind: "tool",
        name: "sccache",
        cache: SCCACHE_TOOLCHAIN_CACHE,
        key: sccacheCacheKey(resolved, plat),
        binDirs: ["."],
    };
}

/**
 * Return the real, absolute, on-disk path of sccache's persistent data
 * (object cache) directory — deliberately the raw cacheGet() path, not a
 * sandbox-mounted "tool" alias. Sandboxed run()s aren't namespace-isolated
 * (see materialize_tools_into_sandbox in src/exec.rs: tools are symlinked
 * in, inputs hardlinked in, but the spawned process still has full,
 * ordinary filesystem access), so a real absolute path is reachable from
 * inside the sandbox just fine — and it needs to be a genuinely stable
 * path, not a sandbox-relative one, precisely because it's handed to a
 * long-lived sccache background server (see RustSccacheWrapper.wrapScript)
 * whose own env must outlive any single sandbox.
 *
 * @returns {Promise<string>}
 */
export async function sccacheDataDir() {
    const key = await ensureSccacheDataDir();
    return cacheGet(SCCACHE_DATA_CACHE, key);
}

/**
 * Return the currently configured default sccache toolchain version.
 *
 * @category configuration
 * @returns {string|null}
 */
export function defaultSccacheToolchainVersion() {
    return defaultVersion;
}

/**
 * Return the currently configured default sccache toolchain target handle.
 *
 * @category configuration
 * @returns {object|null}
 */
export function defaultSccacheToolchain() {
    return defaultToolchain;
}

product("sccache-toolchain", "gen-lockfiles", (handle) =>
    generateToolLockfile({
        handle,
        name: "sccache",
        platforms: sccacheSupportedPlatforms(),
        downloadUrl: sccacheDownloadUrl,
        artifactName: sccacheArtifactName,
    }));

/**
 * Adapter exposing an sccache toolchain as Rust's RUSTC_WRAPPER, sharing a
 * persistent on-disk object cache across sandboxed cargo builds. Registered
 * as the "rust-build-cache" product for the "sccache-toolchain" kind so
 * rules/rust/index.js can resolve it dynamically via
 * productFor(handle, "rust-build-cache") the same way it resolves
 * "rust-link-driver"/"rust-linker".
 */
export class RustSccacheWrapper {
    constructor(handle) {
        this.handle = handle;
    }

    /** @returns {Promise<object[]>} run({ tools }) entries this wrapper needs. */
    async tools() {
        return [await sccacheTool(this.handle.attrs.version)];
    }

    /**
     * Ensure sccache's background server is running, then return the env
     * entries wiring rustc through it.
     *
     * The server is started via workerStart() (see //rules/imp, backed by
     * src/worker.rs) rather than left to sccache's own auto-spawn-on-first-
     * use behavior: sccache's client auto-spawns a persistent daemon that
     * then keeps running detached from whatever sandbox/script started it,
     * inheriting whatever TMPDIR/HOME were active at that moment. Since
     * every imp run() sandbox gets a fresh TMPDIR/HOME that's deleted with
     * its sandbox (src/exec.rs's sandbox_home_tmp), a daemon auto-spawned
     * from inside one sandbox ends up pointed at directories that no longer
     * exist as soon as that sandbox is torn down — every later build
     * sharing that daemon then fails with sccache's own "Failed to create
     * temp dir" error. workerStart() instead spawns the server directly from
     * the host into a stable, workspace-scoped directory that outlives any
     * single sandbox (and this imp process), and is idempotent/singleton
     * across concurrent run()s (`--jobs > 1`) requesting it at once.
     *
     * sccache's own client/server rendezvous (a fixed default TCP port,
     * `127.0.0.1:4226`, overridable via `SCCACHE_SERVER_PORT`) is left at
     * its default rather than pinned to workerStart()'s per-worker port —
     * that port is a generic convenience for sidecars that take an explicit
     * `--port`-style flag, not needed here since sccache already has its
     * own stable, documented rendezvous mechanism.
     *
     * @returns {Promise<string[]>} env entries wiring rustc through sccache.
     */
    async env() {
        const version = this.handle.attrs.version;
        await acquireSccacheToolchain(version);
        const plat = platformInfo();
        const bin = `${cacheGet(SCCACHE_TOOLCHAIN_CACHE, sccacheCacheKey(version, plat))}/sccache`;
        const dataDir = await sccacheDataDir();

        await workerStart("sccache", {
            argv: [bin, "--start-server"],
            env: [`SCCACHE_DIR=${dataDir}`],
            healthCheckArgv: [bin, "--show-stats"],
        });

        return [
            `SCCACHE_DIR=${dataDir}`,
            "RUSTC_WRAPPER=sccache",
            // sccache refuses to cache any compile invoked with rustc's own
            // -C incremental=<dir> (its cache key model is per-compile-unit,
            // not per-incremental-fragment) — cargo passes that by default
            // for dev builds, which would otherwise make every single
            // compilation "non-cacheable" and sccache a pure no-op layered
            // on top of an incremental state that's discarded every sandbox
            // anyway (see the design discussion this toolchain was added
            // for). Disabling it is what actually lets sccache's own
            // content-keyed cache substitute for cargo's own incremental
            // cache.
            "CARGO_INCREMENTAL=0",
        ];
    }
}

product("sccache-toolchain", "rust-build-cache", (handle) => new RustSccacheWrapper(handle));
