import { target, rule, namedCache, download, extract, platformInfo, cachePut, cacheGet, cacheHas } from "imp:core";

// ---------------------------------------------------------------------------
// Odin toolchain management
// ---------------------------------------------------------------------------

let _defaultVersion = null;

/**
 * Declare an Odin toolchain version and optionally set it as the default.
 *
 * Call during module load (in imp.workspace.js or a rules file):
 *
 *     odinToolchain("dev-2026-03", { default: true });
 *
 * @param {string} version  Odin release version (matches .odin-version).
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]  Set as the default toolchain.
 * @returns {string} The named cache key for this toolchain version+platform.
 */
export function odinToolchain(version, opts = {}) {
    const cacheName = "odin-toolchains";
    namedCache({ name: cacheName });

    if (opts.default) {
        _defaultVersion = version;
    }

    // Return the cache key so callers can reference it.
    const plat = platformInfo();
    return `${cacheName}/${version}/${plat.os}-${plat.arch}`;
}

/**
 * Acquire (download and cache) an Odin toolchain.
 *
 * Returns the local directory containing the `odin` binary. Subsequent calls
 * for the same version+platform return instantly from the named cache.
 *
 * @param {string} version  Odin release version, e.g. "dev-2026-03".
 * @returns {string} Local path to the toolchain root (contains `odin` binary).
 */
export function acquireOdinToolchain(version) {
    const cacheName = "odin-toolchains";
    const plat = platformInfo();
    const key = `${version}/${plat.os}-${plat.arch}`;

    if (cacheHas(cacheName, key)) {
        return cacheGet(cacheName, key);
    }

    const osMap = { linux: "linux", macos: "macos", windows: "windows" };
    const archMap = { x86_64: "amd64", aarch64: "arm64" };
    const ext = plat.os === "windows" ? "zip" : "tar.gz";
    const artifact = `odin-${osMap[plat.os]}-${archMap[plat.arch]}-${version}.${ext}`;
    const url = `https://github.com/odin-lang/Odin/releases/download/${version}/${artifact}`;

    const archive = download(url);

    // Extract to a staging location, then move into the named cache.
    const staging = `/tmp/imp-odin-${version}-${plat.arch}`;
    extract(archive, staging, { format: ext === "zip" ? "zip" : "tar.gz", strip_components: 1 });

    cachePut(cacheName, key, staging);
    return cacheGet(cacheName, key);
}

/**
 * Return the path to the odin binary for a given toolchain version.
 * Uses the default version when none is given.
 */
export function odinBin(version) {
    if (!version && _defaultVersion) version = _defaultVersion;
    if (!version) throw new Error("no Odin toolchain version specified and no default set");
    const dir = acquireOdinToolchain(version);
    const exe = platformInfo().os === "windows" ? "odin.exe" : "odin";
    return `${dir}/${exe}`;
}

// ---------------------------------------------------------------------------
// Rules and target constructors
// ---------------------------------------------------------------------------

rule({ kind: "odin-package", product: "sources",      action: "snapshot {sources}", requiresOwnSources: false, dependencyProduct: null });
rule({ kind: "odin-package", product: "odin-package", action: "odin build",         requiresOwnSources: true,  dependencyProduct: "default" });

/**
 * Declare an odin package target.
 *
 * @param {object} opts
 * @param {string[]} opts.srcs  Odin source files.
 * @param {string} [opts.toolchain]  Odin toolchain version. Uses the default if set.
 * @param {Array} [opts.deps=[]]
 * @returns {object} Target handle.
 */
export function odinPackage({ srcs, toolchain, deps = [] }) {
    return target({
        kind: "odin-package",
        fields: {
            sources: srcs.join(","),
            ...(toolchain ? { toolchain } : {}),
        },
        deps,
    });
}
