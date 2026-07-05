import { target, product, namedCache, run, output, output_path, platformInfo, cachePut, cacheGet, cacheHas } from "imp:core";
import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";
import { generateToolLockfile } from "//rules/workflows/lockfiles";

// Rust is installed via rustup, which lays out two env-located state trees:
// RUSTUP_HOME (rustup itself + installed toolchains) and CARGO_HOME (cargo
// registry + proxies). We give each its own named cache and point rustup at
// them so it never touches ~/.rustup / ~/.cargo. See declareToolchain/acquire.
const RUSTUP_HOME_CACHE = "rustup-home";
const CARGO_HOME_CACHE = "cargo-home";

// rustup-init is versioned separately from the Rust toolchain it installs.
// Pin it so the installer URL — and therefore the gen-lockfiles hash — is
// deterministic rather than a rolling "latest". Bump deliberately.
const RUSTUP_VERSION = "1.27.1";

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

// The rustup-init target triples for the platforms we publish lockfile entries
// for; see https://static.rust-lang.org/rustup/. Keyed "os-arch".
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
        throw new Error(`unsupported rust toolchain platform: ${plat.os}/${plat.arch}`);
    }
    return triple;
}

// Only exact MAJOR.MINOR.PATCH pins are accepted — channels like "stable" or
// "nightly" are rejected so a toolchain always resolves to the same bytes.
function requirePinnedVersion(version) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
        throw new Error(
            `rust toolchain version must be an exact version like "1.79.0", got "${version}"`,
        );
    }
    return version;
}

/**
 * Return the rustup-init filename for a platform.
 *
 * @param {string} _version Rust toolchain version (unused; the installer is
 *   versioned by RUSTUP_VERSION, not the Rust release).
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function rustArtifactName(_version, plat) {
    targetTriple(plat);
    return plat.os === "windows" ? "rustup-init.exe" : "rustup-init";
}

/**
 * Return the rustup-init download URL for a platform, pinned to RUSTUP_VERSION.
 *
 * @param {string} version Rust toolchain version (recorded in the lock; not in the URL).
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function rustDownloadUrl(version, plat) {
    return `https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${targetTriple(plat)}/${rustArtifactName(version, plat)}`;
}

/**
 * Return the named-cache key for a Rust toolchain version and platform. Shared
 * by both the rustup-home and cargo-home caches.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function rustCacheKey(version, plat) {
    return `${version}/${plat.os}-${plat.arch}`;
}

/**
 * Return the on-disk `toolchains/<id>` directory name rustup installs into.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function rustToolchainId(version, plat) {
    return `${version}-${targetTriple(plat)}`;
}

/**
 * Return the platforms we publish rustup-init lockfile entries for, derived
 * from the TARGET_TRIPLES map (keyed "os-arch").
 *
 * @returns {Array<{ os: string, arch: string }>}
 */
export function rustSupportedPlatforms() {
    return Object.keys(TARGET_TRIPLES).map((key) => {
        const sep = key.indexOf("-");
        return { os: key.slice(0, sep), arch: key.slice(sep + 1) };
    });
}

// Bare coreutils the download/install scripts need. The sandbox is fully
// hermetic — even mkdir/dirname/chmod must be declared tools, not resolved from
// an ambient PATH. rustup-init does its own HTTPS (using the sandbox's
// passed-through SSL_CERT_* env), so no tar/gzip is needed. Bare `sh` only
// auto-resolves on unix, so windows declares it explicitly.
function coreToolNames(plat) {
    return plat.os === "windows"
        ? ["curl", "mkdir", "dirname", "sh"]
        : ["curl", "mkdir", "dirname", "chmod"];
}

/**
 * Build a Rust toolchain API. Tests can pass a fake host implementation to
 * exercise the install flow without downloading or running rustup-init.
 *
 * @param {object} [host]
 * @returns {object}
 */
export function createRustToolchainApi(host = defaultHost) {
    let defaultVersion = null;
    let defaultToolchain = null;
    // Declared lazily, once — target() addresses are only assigned at
    // workspace-load time, so tool handles must be created when a toolchain is
    // declared at BUILD.js top level, not inside acquireToolchain().
    let coreToolHandles = null;

    function declareBothCaches() {
        host.namedCache({ name: RUSTUP_HOME_CACHE });
        host.namedCache({ name: CARGO_HOME_CACHE });
    }

    function declareToolchain(version, opts = {}) {
        requirePinnedVersion(version);
        declareBothCaches();
        if (!coreToolHandles) {
            coreToolHandles = coreToolNames(host.platformInfo()).map((name) => host.nativeTool(name));
        }

        const toolchain = target({
            kind: "rust-toolchain",
            attrs: { version },
        });

        if (opts.default) {
            defaultVersion = version;
            defaultToolchain = toolchain;
        }

        return toolchain;
    }

    // Seed both caches from an already-installed layout (used by tests, and by
    // anyone wiring a prebuilt toolchain in). `source` carries a directory for
    // each cache.
    function installToolchain(version, source) {
        requirePinnedVersion(version);
        declareBothCaches();
        const plat = host.platformInfo();
        const key = rustCacheKey(version, plat);
        host.cachePut(RUSTUP_HOME_CACHE, key, source.rustupHome);
        host.cachePut(CARGO_HOME_CACHE, key, source.cargoHome);
        return {
            rustupHome: host.cacheGet(RUSTUP_HOME_CACHE, key),
            cargoHome: host.cacheGet(CARGO_HOME_CACHE, key),
        };
    }

    async function acquireToolchain(version) {
        const plat = host.platformInfo();
        const key = rustCacheKey(version, plat);

        if (host.cacheHas(RUSTUP_HOME_CACHE, key) && host.cacheHas(CARGO_HOME_CACHE, key)) {
            return host.cacheGet(RUSTUP_HOME_CACHE, key);
        }
        if (!coreToolHandles) {
            throw new Error("no rust toolchain declared via rustToolchain(); nothing to acquire");
        }

        const coreTools = await Promise.all(coreToolHandles.map((handle) => host.nativeToolSpec(handle)));

        const artifact = rustArtifactName(version, plat);
        const url = rustDownloadUrl(version, plat);
        const rustupInitPath = `.imp/rust-downloads/${key}/${artifact}`;
        const rustupHomeDir = `.imp/rustup-home/${key}`;
        const cargoHomeDir = `.imp/cargo-home/${key}`;

        await host.run({
            argv: ["sh", "-c", 'mkdir -p "$(dirname "$1")" && curl -fSL -o "$1" "$2"', "download-rustup-init", rustupInitPath, url],
            tools: coreTools,
            outputs: [host.output(host.output_path(rustupInitPath))],
            display: `download rustup-init ${RUSTUP_VERSION} (${plat.os}/${plat.arch})`,
        });

        // rustup writes into RUSTUP_HOME/CARGO_HOME, which we point at the two
        // output dirs via $PWD (run() env can't expand $PWD, so this lives in
        // the script). A single run commits both directories to their caches.
        const chmodStep = plat.os === "windows" ? "" : 'chmod +x "$1"; ';
        const installScript = `set -e; ${chmodStep}export RUSTUP_HOME="$PWD/$2" CARGO_HOME="$PWD/$3"; "$1" -y --no-modify-path --profile minimal --default-toolchain "$4"`;

        await host.run({
            argv: ["sh", "-c", installScript, "install-rust", rustupInitPath, rustupHomeDir, cargoHomeDir, version],
            tools: coreTools,
            inputs: [{ kind: "file", path: rustupInitPath }],
            outputs: [
                host.output(host.output_path(rustupHomeDir), {
                    kind: "directory",
                    namedCache: { name: RUSTUP_HOME_CACHE, key },
                }),
                host.output(host.output_path(cargoHomeDir), {
                    kind: "directory",
                    namedCache: { name: CARGO_HOME_CACHE, key },
                }),
            ],
            display: `install rust ${version} (${plat.os}/${plat.arch})`,
        });

        return host.cacheGet(RUSTUP_HOME_CACHE, key);
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
            throw new Error("no rust toolchain version specified and no default set");
        }
        return resolved;
    }

    async function bin(version, name = "cargo") {
        const resolved = requireVersion(version);
        const dir = await acquireToolchain(resolved);
        const plat = host.platformInfo();
        const exe = plat.os === "windows" ? ".exe" : "";
        return `${dir}/toolchains/${rustToolchainId(resolved, plat)}/bin/${name}${exe}`;
    }

    // The consume-time descriptor: mounts both caches and reports the fixed
    // sandbox mount paths the caller must wire into RUSTUP_HOME/CARGO_HOME.
    // Because run() env can't expand $PWD and no primitive exposes a mounted
    // cache path via env, the consumer sets these in its own `sh -c` script:
    //   export RUSTUP_HOME="$PWD/${rustupHome}" CARGO_HOME="$PWD/${cargoHome}"
    // rustc/cargo live under toolchains/<id>/bin (real binaries, not proxies),
    // so RUSTUP_HOME isn't strictly needed to run them — but cargo honours
    // CARGO_HOME for its registry, and both are exposed for completeness.
    async function tool(version) {
        const resolved = requireVersion(version);
        await acquireToolchain(resolved);
        const plat = host.platformInfo();
        const key = rustCacheKey(resolved, plat);
        const id = rustToolchainId(resolved, plat);
        return {
            tools: [
                { kind: "tool", name: RUSTUP_HOME_CACHE, cache: RUSTUP_HOME_CACHE, key, binDirs: [`toolchains/${id}/bin`] },
                { kind: "tool", name: CARGO_HOME_CACHE, cache: CARGO_HOME_CACHE, key, binDirs: [] },
            ],
            rustupHome: `.imp/tools/${RUSTUP_HOME_CACHE}`,
            cargoHome: `.imp/tools/${CARGO_HOME_CACHE}`,
            toolchainId: id,
        };
    }

    function currentDefaultVersion() {
        return defaultVersion;
    }

    function currentDefaultToolchain() {
        return defaultToolchain;
    }

    return {
        rustToolchain: declareToolchain,
        installRustToolchain: installToolchain,
        acquireRustToolchain: acquireToolchain,
        resolveRustToolchainVersion: resolveVersion,
        rustBin: bin,
        rustTool: tool,
        defaultRustToolchainVersion: currentDefaultVersion,
        defaultRustToolchain: currentDefaultToolchain,
    };
}

const defaultApi = createRustToolchainApi();

/**
 * Declare a Rust toolchain version and optionally set it as the default.
 *
 * @param {string} version Exact Rust version, e.g. "1.79.0" (channels rejected).
 * @param {object} [opts]
 * @param {boolean} [opts.default=false] Set as the default toolchain.
 * @returns {object} Target handle for this Rust toolchain.
 */
export function rustToolchain(version, opts = {}) {
    return defaultApi.rustToolchain(version, opts);
}

/**
 * Seed the rustup-home and cargo-home caches from an already-installed layout.
 *
 * @param {string} version
 * @param {{ rustupHome: string, cargoHome: string }} source
 * @returns {{ rustupHome: string|null, cargoHome: string|null }}
 */
export function installRustToolchain(version, source) {
    return defaultApi.installRustToolchain(version, source);
}

/**
 * Acquire a Rust toolchain: download rustup-init and run it, installing into
 * the rustup-home and cargo-home named caches.
 *
 * @param {string} version
 * @returns {Promise<string>} Local path to the RUSTUP_HOME cache root.
 */
export function acquireRustToolchain(version) {
    return defaultApi.acquireRustToolchain(version);
}

/**
 * Resolve an explicit or default Rust toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveRustToolchainVersion(version) {
    return defaultApi.resolveRustToolchainVersion(version);
}

/**
 * Return the path to a toolchain binary (default "cargo") for a version.
 *
 * @param {string} [version]
 * @param {string} [name="cargo"]
 * @returns {Promise<string>}
 */
export function rustBin(version, name) {
    return defaultApi.rustBin(version, name);
}

/**
 * Return the Rust toolchain consume descriptor: the two named-cache tool specs
 * plus the fixed sandbox mount paths for RUSTUP_HOME/CARGO_HOME wiring.
 *
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export function rustTool(version) {
    return defaultApi.rustTool(version);
}

/**
 * Return the currently configured default Rust toolchain version.
 *
 * @returns {string|null}
 */
export function defaultRustToolchainVersion() {
    return defaultApi.defaultRustToolchainVersion();
}

/**
 * Return the currently configured default Rust toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultRustToolchain() {
    return defaultApi.defaultRustToolchain();
}

product("rust-toolchain", "gen-lockfiles", (handle) =>
    generateToolLockfile({
        handle,
        name: "rust",
        platforms: rustSupportedPlatforms(),
        downloadUrl: rustDownloadUrl,
        artifactName: rustArtifactName,
    }));
