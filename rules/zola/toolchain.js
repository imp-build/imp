import {
	Toolchain,
	product,
	namedCache,
	memo,
	platformInfo,
	cachePut,
	cacheGet,
	cacheHas,
	toolName,
} from "imp:core";

import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";
import {
	downloadToolArtifact,
	lockedDownloadTools,
} from "//rules/imp/lockfile";
import { extractArchive, extractArchiveTools } from "//rules/imp/archive";
import {
	generateToolLockfile,
	GEN_LOCKFILES,
	registerToolchainLockfile,
} from "//rules/workflows/lockfiles";

// Declared tool identity for products this toolchain implements; also
// consumed by rule modules registering zola-driven products.
export const ZOLA_TOOL = toolName("zola");

const ZOLA_TOOLCHAIN_CACHE = "zola-toolchains";
const ZOLA_LOCKFILE = "//rules/zola/zola.lock";

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
		throw new Error(
			`unsupported zola toolchain platform: ${plat.os}/${plat.arch}`,
		);
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
 * Return the platforms zola publishes release archives for, derived from the
 * module's TARGET_TRIPLES map (keyed "os-arch").
 *
 * @returns {Array<{ os: string, arch: string }>}
 */
export function zolaSupportedPlatforms() {
	return Object.keys(TARGET_TRIPLES).map((key) => {
		const sep = key.indexOf("-");
		return { os: key.slice(0, sep), arch: key.slice(sep + 1) };
	});
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

// Bare coreutils the verified-download and extract scripts need. The sandbox
// is fully hermetic — even `mkdir`/`tar` must be declared tools, not
// resolved from an ambient or fixed-base PATH.
function coreToolNames(plat) {
	return [
		...new Set([
			...lockedDownloadTools(plat),
			...extractArchiveTools(plat.os === "windows" ? "zip" : "tar.gz"),
		]),
	];
}

export class ZolaToolchain extends Toolchain {
	static kind = "zola-toolchain";
	static tool = ZOLA_TOOL;
	constructor({ version, unverified }, opts) {
		super(
			{
				kind: ZolaToolchain.kind,
				attrs: { version, ...(unverified ? { unverified } : {}) },
			},
			opts,
		);
	}

	bin() {
		return zolaBin(this.attrs.version);
	}
}

// Declared lazily, once, the first time a toolchain is declared — target()
// addresses are only assigned at workspace-load time, so this must happen
// at BUILD.js top level rather than inside acquireToolchain() at execution time.
let coreToolHandles = null;

export function __resetZolaToolchainStateForTest() {
	ZolaToolchain.clearDefault();
	coreToolHandles = null;
}

/**
 * Declare a zola toolchain version and optionally set it as the default.
 *
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @param {boolean} [opts.unverified=false] Allow downloading without a
 *   matching lockfile entry (warns instead of failing).
 * @returns {object} Target handle for this zola toolchain.
 * @category configuration
 */
export function zolaToolchain(version, opts = {}) {
	namedCache({ name: ZOLA_TOOLCHAIN_CACHE, shared: true });
	if (!coreToolHandles) {
		coreToolHandles = coreToolNames(platformInfo()).map((name) =>
			nativeTool(name),
		);
	}

	return new ZolaToolchain(
		{ version, unverified: opts.unverified },
		{ default: opts.default },
	);
}

/**
 * Install a local zola toolchain directory into the named cache.
 *
 * @param {string} version
 * @param {string} source Path to the toolchain root.
 * @returns {string|null} Local path to the cached toolchain root.
 */
export function installZolaToolchain(version, source) {
	namedCache({ name: ZOLA_TOOLCHAIN_CACHE, shared: true });
	const plat = platformInfo();
	const key = zolaCacheKey(version, plat);
	cachePut(ZOLA_TOOLCHAIN_CACHE, key, source);
	return cacheGet(ZOLA_TOOLCHAIN_CACHE, key);
}

/**
 * Acquire a zola toolchain, downloading and caching it if not already
 * installed in the named cache.
 *
 * @param {string} version
 * @returns {Promise<string>} Local path to the toolchain root.
 */
export const acquireZolaToolchain = memo(
	async function acquireZolaToolchain(version) {
		const plat = platformInfo();
		const key = zolaCacheKey(version, plat);

		if (cacheHas(ZOLA_TOOLCHAIN_CACHE, key)) {
			return cacheGet(ZOLA_TOOLCHAIN_CACHE, key);
		}
		if (!coreToolHandles) {
			throw new Error(
				"no zola toolchain declared via zolaToolchain(); nothing to acquire",
			);
		}

		const coreTools = await Promise.all(
			coreToolHandles.map((handle) => nativeToolSpec(handle)),
		);

		const downloadPath = `.imp/zola-downloads/${key}/${zolaArtifactName(version, plat)}`;
		await downloadToolArtifact({
			lockfile: ZOLA_LOCKFILE,
			tool: "zola",
			version,
			plat,
			url: zolaDownloadUrl(version, plat),
			downloadPath,
			tools: coreTools,
			display: `download zola ${version} (${plat.os}/${plat.arch})`,
			unverified: ZolaToolchain.resolveUnverified(version),
		});

		// Zola's release archive ships the `zola` binary at the archive root
		// (no wrapping directory), so no --strip-components is needed.
		await extractArchive({
			archive: downloadPath,
			dest: `.imp/zola-toolchains/${key}`,
			format: plat.os === "windows" ? "zip" : "tar.gz",
			tools: coreTools,
			namedCache: { name: ZOLA_TOOLCHAIN_CACHE, key },
			display: `install zola ${version} (${plat.os}/${plat.arch})`,
		});

		return cacheGet(ZOLA_TOOLCHAIN_CACHE, key);
	},
	{ display: "acquire Zola Toolchain {0}", level: "info" },
);

/**
 * Resolve an explicit or default zola toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveZolaToolchainVersion(version) {
	return ZolaToolchain.resolveVersion(version);
}

/**
 * Return the zola executable path for a toolchain version.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function zolaBin(version) {
	const resolved = ZolaToolchain.requireVersion(version);
	const dir = await acquireZolaToolchain(resolved);
	const plat = platformInfo();
	return plat.os === "windows" ? `${dir}/zola.exe` : `${dir}/zola`;
}

/**
 * Return a named-cache-backed zola tool descriptor for sandbox execution.
 *
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function zolaTool(version) {
	const resolved = ZolaToolchain.requireVersion(version);
	await acquireZolaToolchain(resolved);
	const plat = platformInfo();
	return {
		kind: "tool",
		name: "zola",
		cache: ZOLA_TOOLCHAIN_CACHE,
		key: zolaCacheKey(resolved, plat),
		binDirs: ["."],
	};
}

/**
 * Return the currently configured default zola toolchain version.
 *
 * @returns {string|null}
 */
export function defaultZolaToolchainVersion() {
	return ZolaToolchain.defaultVersion();
}

/**
 * Return the currently configured default zola toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultZolaToolchain() {
	return ZolaToolchain.default();
}

// Importing this rule provisions the pinned default. A workspace can replace
// it by declaring another zolaToolchain(..., { default: true }).
zolaToolchain("0.22.1", { default: true });

const LOCKFILE_SPEC = registerToolchainLockfile(
	{
		name: "zola",
		platforms: zolaSupportedPlatforms(),
		downloadUrl: zolaDownloadUrl,
		artifactName: zolaArtifactName,
		lockfile: ZOLA_LOCKFILE,
	},
	["0.22.1"],
);
product(
	ZolaToolchain,
	GEN_LOCKFILES,
	ZOLA_TOOL,
	(handle) => generateToolLockfile({ handle, ...LOCKFILE_SPEC }),
	{ display: "gen lockfiles {0}", level: "info" },
);
