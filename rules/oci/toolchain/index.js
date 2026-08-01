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
// consumed by rule modules registering crane-driven products.
export const CRANE_TOOL = toolName("crane");

const CRANE_TOOLCHAIN_CACHE = "crane-toolchains";
const CRANE_LOCKFILE = "//rules/oci/crane.lock";

// crane (google/go-containerregistry) publishes prebuilt binaries for these
// targets; see https://github.com/google/go-containerregistry/releases. The
// release tarball is flat (crane/gcrane/krane/LICENSE/README.md at the
// archive root, no wrapping directory) for every platform, including
// Windows — unlike zola there's no separate .zip variant to special-case.
const TARGET_OS = {
	linux: "Linux",
	macos: "Darwin",
	windows: "Windows",
};

const TARGET_ARCH = {
	x86_64: "x86_64",
	aarch64: "arm64",
};

function platformParts(plat) {
	const os = TARGET_OS[plat.os];
	const arch = TARGET_ARCH[plat.arch];
	if (!os || !arch) {
		throw new Error(
			`unsupported crane toolchain platform: ${plat.os}/${plat.arch}`,
		);
	}
	return { os, arch };
}

/**
 * Return the crane release artifact filename for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function craneArtifactName(version, plat) {
	const { os, arch } = platformParts(plat);
	return `go-containerregistry_${os}_${arch}.tar.gz`;
}

/**
 * Return the crane release download URL for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function craneDownloadUrl(version, plat) {
	return `https://github.com/google/go-containerregistry/releases/download/v${version}/${craneArtifactName(version, plat)}`;
}

// The platforms crane publishes release archives for, keyed "os-arch".
const CRANE_SUPPORTED_PLATFORMS = [
	{ os: "linux", arch: "x86_64" },
	{ os: "linux", arch: "aarch64" },
	{ os: "macos", arch: "x86_64" },
	{ os: "macos", arch: "aarch64" },
	{ os: "windows", arch: "x86_64" },
];

/**
 * Return the platforms crane publishes release archives for.
 *
 * @returns {Array<{ os: string, arch: string }>}
 */
export function craneSupportedPlatforms() {
	return CRANE_SUPPORTED_PLATFORMS.map((plat) => ({ ...plat }));
}

/**
 * Return the named-cache key for a crane toolchain version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function craneCacheKey(version, plat) {
	return `${version}/${plat.os}-${plat.arch}`;
}

// Bare coreutils the verified-download and extract scripts need. The sandbox
// is fully hermetic — even `mkdir`/`tar` must be declared tools, not
// resolved from an ambient or fixed-base PATH.
function coreToolNames(plat) {
	return [
		...new Set([
			...lockedDownloadTools(plat),
			...extractArchiveTools("tar.gz"),
		]),
	];
}

export class CraneToolchain extends Toolchain {
	static kind = "crane-toolchain";
	static tool = CRANE_TOOL;
	constructor({ version, unverified }, opts) {
		super(
			{
				kind: CraneToolchain.kind,
				attrs: { version, ...(unverified ? { unverified } : {}) },
			},
			opts,
		);
	}

	bin() {
		return craneBin(this.attrs.version);
	}
}

// Declared lazily, once, the first time a toolchain is declared — target()
// addresses are only assigned at workspace-load time, so this must happen
// at BUILD.js top level rather than inside acquireToolchain() at execution time.
let coreToolHandles = null;

export function __resetCraneToolchainStateForTest() {
	CraneToolchain.clearDefault();
	coreToolHandles = null;
}

/**
 * Declare a crane toolchain version and optionally set it as the default.
 *
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @param {boolean} [opts.unverified=false] Allow downloading without a
 *   matching lockfile entry (warns instead of failing).
 * @returns {object} Target handle for this crane toolchain.
 * @category configuration
 */
export function craneToolchain(version, opts = {}) {
	namedCache({ name: CRANE_TOOLCHAIN_CACHE, shared: true });
	if (!coreToolHandles) {
		coreToolHandles = coreToolNames(platformInfo()).map((name) =>
			nativeTool(name),
		);
	}

	return new CraneToolchain(
		{ version, unverified: opts.unverified },
		{ default: opts.default },
	);
}

/**
 * Install a local crane toolchain directory into the named cache.
 *
 * @param {string} version
 * @param {string} source Path to the toolchain root.
 * @returns {string|null} Local path to the cached toolchain root.
 */
export function installCraneToolchain(version, source) {
	namedCache({ name: CRANE_TOOLCHAIN_CACHE, shared: true });
	const plat = platformInfo();
	const key = craneCacheKey(version, plat);
	cachePut(CRANE_TOOLCHAIN_CACHE, key, source);
	return cacheGet(CRANE_TOOLCHAIN_CACHE, key);
}

/**
 * Acquire a crane toolchain, downloading and caching it if not already
 * installed in the named cache.
 *
 * @param {string} version
 * @returns {Promise<string>} Local path to the toolchain root.
 */
export const acquireCraneToolchain = memo(
	async function acquireCraneToolchain(version) {
		const plat = platformInfo();
		const key = craneCacheKey(version, plat);

		if (cacheHas(CRANE_TOOLCHAIN_CACHE, key)) {
			return cacheGet(CRANE_TOOLCHAIN_CACHE, key);
		}
		if (!coreToolHandles) {
			throw new Error(
				"no crane toolchain declared via craneToolchain(); nothing to acquire",
			);
		}

		const coreTools = await Promise.all(
			coreToolHandles.map((handle) => nativeToolSpec(handle)),
		);

		const downloadPath = `.imp/crane-downloads/${key}/${craneArtifactName(version, plat)}`;
		await downloadToolArtifact({
			lockfile: CRANE_LOCKFILE,
			tool: "crane",
			version,
			plat,
			url: craneDownloadUrl(version, plat),
			downloadPath,
			tools: coreTools,
			display: `download crane ${version} (${plat.os}/${plat.arch})`,
			unverified: CraneToolchain.resolveUnverified(version),
		});

		// crane's release tarball ships crane/gcrane/krane at the archive root
		// (no wrapping directory), so no --strip-components is needed.
		await extractArchive({
			archive: downloadPath,
			dest: `.imp/crane-toolchains/${key}`,
			format: "tar.gz",
			tools: coreTools,
			namedCache: { name: CRANE_TOOLCHAIN_CACHE, key },
			display: `install crane ${version} (${plat.os}/${plat.arch})`,
		});

		return cacheGet(CRANE_TOOLCHAIN_CACHE, key);
	},
	{ display: "acquire Crane Toolchain {0}", level: "info" },
);

/**
 * Resolve an explicit or default crane toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveCraneToolchainVersion(version) {
	return CraneToolchain.resolveVersion(version);
}

/**
 * Return the crane executable path for a toolchain version.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function craneBin(version) {
	const resolved = CraneToolchain.requireVersion(version);
	const dir = await acquireCraneToolchain(resolved);
	const plat = platformInfo();
	return plat.os === "windows" ? `${dir}/crane.exe` : `${dir}/crane`;
}

/**
 * Return a named-cache-backed crane tool descriptor for sandbox execution.
 *
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function craneTool(version) {
	const resolved = CraneToolchain.requireVersion(version);
	await acquireCraneToolchain(resolved);
	const plat = platformInfo();
	return {
		kind: "tool",
		name: "crane",
		cache: CRANE_TOOLCHAIN_CACHE,
		key: craneCacheKey(resolved, plat),
		binDirs: ["."],
	};
}

/**
 * Return the currently configured default crane toolchain version.
 *
 * @returns {string|null}
 */
export function defaultCraneToolchainVersion() {
	return CraneToolchain.defaultVersion();
}

/**
 * Return the currently configured default crane toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultCraneToolchain() {
	return CraneToolchain.default();
}

// Importing this rule provisions the pinned default. A workspace can replace
// it by declaring another craneToolchain(..., { default: true }).
craneToolchain("0.20.6", { default: true });

const LOCKFILE_SPEC = registerToolchainLockfile(
	{
		name: "crane",
		platforms: craneSupportedPlatforms(),
		downloadUrl: craneDownloadUrl,
		artifactName: craneArtifactName,
		lockfile: CRANE_LOCKFILE,
	},
	["0.20.6"],
);
product(
	CraneToolchain,
	GEN_LOCKFILES,
	CRANE_TOOL,
	(handle) => generateToolLockfile({ handle, ...LOCKFILE_SPEC }),
	{ display: "gen lockfiles {0}", level: "info" },
);
