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

// Bare coreutils the install script needs. The sandbox is fully hermetic —
// even chmod must be declared a tool, not resolved from an ambient PATH.
// rustup-init does its own HTTPS (using the sandbox's passed-through
// SSL_CERT_* env), so no tar/gzip is needed. Bare `sh` only auto-resolves on
// unix, so windows declares it explicitly.
function coreToolNames(plat) {
    return plat.os === "windows"
        ? ["curl", "sh"]
        : ["curl", "chmod"];
}

let defaultVersion = null;
let defaultToolchain = null;
// Declared lazily, once — target() addresses are only assigned at
// workspace-load time, so tool handles must be created when a toolchain is
// declared at BUILD.js top level, not inside acquireToolchain().
let coreToolHandles = null;

export function __resetRustToolchainStateForTest() {
    defaultVersion = null;
    defaultToolchain = null;
    coreToolHandles = null;
}

function declareBothCaches() {
    namedCache({ name: RUSTUP_HOME_CACHE, shared: true });
    namedCache({ name: CARGO_HOME_CACHE, shared: true });
}

function requireVersion(version) {
    const resolved = resolveRustToolchainVersion(version);
    if (!resolved) {
        throw new Error("no rust toolchain version specified and no default set");
    }
    return resolved;
}

/**
 * Declare a Rust toolchain version and optionally set it as the default.
 *
 * @param {string} version Exact Rust version, e.g. "1.79.0" (channels rejected).
 * @param {object} [opts]
 * @param {boolean} [opts.default=false] Set as the default toolchain.
 * @param {object} [opts.linkDriver] C link driver toolchain handle (e.g.
 *   gccToolchain()) registering a "rust-link-driver" product. Falls back to
 *   defaultGccToolchain() if omitted.
 * @param {object} [opts.linker] Linker toolchain handle (e.g. moldToolchain())
 *   registering a "rust-linker" product. No extra backend flag is added if
 *   omitted.
 * @param {object} [opts.sccache] sccache toolchain handle (e.g.
 *   sccacheToolchain(), see //rules/rust/sccache) registering a
 *   "rust-build-cache" product. Wraps rustc with sccache and points it at a
 *   persistent on-disk object cache; no build caching beyond cargo's own
 *   (mtime-defeated, sandbox-fresh) incremental state is added if omitted.
 * @returns {object} Target handle for this Rust toolchain.
 * @category configuration
 */
export function rustToolchain(version, opts = {}) {
    requirePinnedVersion(version);
    declareBothCaches();
    if (!coreToolHandles) {
        coreToolHandles = coreToolNames(platformInfo()).map((name) => nativeTool(name));
    }

    const toolchain = target({
        kind: "rust-toolchain",
        attrs: {
            version,
            ...(opts.linkDriver ? { linkDriver: opts.linkDriver } : {}),
            ...(opts.linker ? { linker: opts.linker } : {}),
            ...(opts.sccache ? { sccache: opts.sccache } : {}),
        },
    });

    if (opts.default) {
        defaultVersion = version;
        defaultToolchain = toolchain;
    }

    return toolchain;
}

/**
 * Seed the rustup-home and cargo-home caches from an already-installed layout.
 *
 * @param {string} version
 * @param {{ rustupHome: string, cargoHome: string }} source
 * @returns {{ rustupHome: string|null, cargoHome: string|null }}
 */
export function installRustToolchain(version, source) {
    requirePinnedVersion(version);
    declareBothCaches();
    const plat = platformInfo();
    const key = rustCacheKey(version, plat);
    cachePut(RUSTUP_HOME_CACHE, key, source.rustupHome);
    cachePut(CARGO_HOME_CACHE, key, source.cargoHome);
    return {
        rustupHome: cacheGet(RUSTUP_HOME_CACHE, key),
        cargoHome: cacheGet(CARGO_HOME_CACHE, key),
    };
}

/**
 * Acquire a Rust toolchain: download rustup-init and run it, installing into
 * the rustup-home and cargo-home named caches.
 *
 * @param {string} version
 * @returns {Promise<string>} Local path to the RUSTUP_HOME cache root.
 */
export async function acquireRustToolchain(version) {
    const plat = platformInfo();
    const key = rustCacheKey(version, plat);

    if (cacheHas(RUSTUP_HOME_CACHE, key) && cacheHas(CARGO_HOME_CACHE, key)) {
        return cacheGet(RUSTUP_HOME_CACHE, key);
    }
    if (!coreToolHandles) {
        throw new Error("no rust toolchain declared via rustToolchain(); nothing to acquire");
    }

    const coreTools = await Promise.all(coreToolHandles.map((handle) => nativeToolSpec(handle)));

    const url = rustDownloadUrl(version, plat);
    const rustupHomeDir = `.imp/rustup-home/${key}`;
    const cargoHomeDir = `.imp/cargo-home/${key}`;
    const rustupInitExe = plat.os === "windows" ? "rustup-init.exe" : "rustup-init";

    // rustup-init is downloaded straight to a sandbox-local scratch file
    // (not a declared output — it's discarded with the sandbox) since only
    // the resulting RUSTUP_HOME/CARGO_HOME need caching. rustup writes into
    // them, which we point at via $PWD (run() env can't expand $PWD, so
    // this lives in the script). Profile "minimal" plus explicit rustfmt
    // (for fmt/format-check, rules/rust/fmt.js) and clippy (for lint)
    // components — "default" would also pull in rust-docs, ~740MB of small
    // files that dominate cold-acquire time.
    const chmodStep = plat.os === "windows" ? "" : `chmod +x "${rustupInitExe}"; `;
    const installScript = `set -e; curl -fSL -o "${rustupInitExe}" "$1"; ${chmodStep}export RUSTUP_HOME="$PWD/$2" CARGO_HOME="$PWD/$3"; ./"${rustupInitExe}" -y --no-modify-path --profile minimal --component rustfmt --component clippy --default-toolchain "$4"`;

    await run({
        argv: ["sh", "-c", installScript, "install-rust", url, rustupHomeDir, cargoHomeDir, version],
        tools: coreTools,
        outputs: [
            output(output_path(rustupHomeDir), {
                kind: "directory",
                namedCache: { name: RUSTUP_HOME_CACHE, key },
            }),
            output(output_path(cargoHomeDir), {
                kind: "directory",
                namedCache: { name: CARGO_HOME_CACHE, key },
            }),
        ],
        materialize: false,
        display: `install rust ${version} (${plat.os}/${plat.arch})`,
    });

    return cacheGet(RUSTUP_HOME_CACHE, key);
}

/**
 * Resolve an explicit or default Rust toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveRustToolchainVersion(version) {
    if (version) {
        return version;
    }
    return defaultVersion;
}

/**
 * Return the path to a toolchain binary (default "cargo") for a version.
 *
 * @param {string} [version]
 * @param {string} [name="cargo"]
 * @returns {Promise<string>}
 */
export async function rustBin(version, name = "cargo") {
    const resolved = requireVersion(version);
    const dir = await acquireRustToolchain(resolved);
    const plat = platformInfo();
    const exe = plat.os === "windows" ? ".exe" : "";
    return `${dir}/toolchains/${rustToolchainId(resolved, plat)}/bin/${name}${exe}`;
}

/**
 * Return the Rust toolchain consume descriptor: the two named-cache tool specs
 * plus the fixed sandbox mount paths for RUSTUP_HOME/CARGO_HOME wiring.
 *
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function rustTool(version) {
    const resolved = requireVersion(version);
    await acquireRustToolchain(resolved);
    const plat = platformInfo();
    const key = rustCacheKey(resolved, plat);
    const id = rustToolchainId(resolved, plat);
    return {
        tools: [
            { kind: "tool", name: RUSTUP_HOME_CACHE, cache: RUSTUP_HOME_CACHE, key, binDirs: [`toolchains/${id}/bin`] },
            // CARGO_HOME/bin holds the cargo-subcommand proxies rustup
            // installs for components like rustfmt (cargo-fmt) and clippy
            // (cargo-clippy) — cargo finds `cargo-<sub>` via PATH, so this
            // must be on it too, not just the toolchain's own bin dir.
            { kind: "tool", name: CARGO_HOME_CACHE, cache: CARGO_HOME_CACHE, key, binDirs: ["bin"] },
        ],
        rustupHome: `.imp/tools/${RUSTUP_HOME_CACHE}`,
        cargoHome: `.imp/tools/${CARGO_HOME_CACHE}`,
        // Real, absolute, stable on-disk paths for the same two named
        // caches — bypassing the sandbox "tool" mount above. Only needed
        // when sccache is wrapping rustc: see rustToolEnv() in
        // //rules/rust for why the literal (not just canonically-equal)
        // rustc exe path must stay identical across sandboxes in that case.
        rustupHomeAbs: cacheGet(RUSTUP_HOME_CACHE, key),
        cargoHomeAbs: cacheGet(CARGO_HOME_CACHE, key),
        toolchainId: id,
    };
}

/**
 * Return the currently configured default Rust toolchain version.
 *
 * @returns {string|null}
 */
export function defaultRustToolchainVersion() {
    return defaultVersion;
}

/**
 * Return the currently configured default Rust toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultRustToolchain() {
    return defaultToolchain;
}

product("rust-toolchain", "gen-lockfiles", (handle) =>
    generateToolLockfile({
        handle,
        name: "rust",
        platforms: rustSupportedPlatforms(),
        downloadUrl: rustDownloadUrl,
        artifactName: rustArtifactName,
        lockfile: "//rules/rust/rust.lock",
    }));
