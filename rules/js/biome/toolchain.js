import {
	Toolchain,
	namedCache,
	output,
	platformInfo,
	cachePut,
	cacheGet,
	toolName,
	tool as graphTool,
	task,
} from "imp:core";

import { nativeTool } from "//rules/imp/native-tool";
import { toolchainBin } from "//rules/imp/toolchain";
import { downloadToolArtifact } from "//rules/imp/lockfile";
import {
	graphGenerateToolLockfile,
	GEN_LOCKFILES,
	registerToolchainLockfile,
} from "//rules/workflows/lockfiles";

// Declared tool identity for products this toolchain implements; also
// consumed by rule modules registering biome-driven products (fmt).
export const BIOME_TOOL = toolName("biome");

const BIOME_TOOLCHAIN_CACHE = "biome-toolchains";
const BIOME_LOCKFILE = "//rules/js/biome/biome-toolchain.lock";

// biome's own os/arch tokens (github.com/biomejs/biome releases), distinct
// from imp's plat.os/plat.arch vocabulary — "darwin"/"win32" not
// "macos"/"windows", "x64"/"arm64" not "x86_64"/"aarch64". Same platform set
// as node/pnpm, but unlike pnpm biome publishes all six combinations (no
// darwin-x64 gap) — verified via `gh api repos/biomejs/biome/releases/latest`.
const BIOME_PLATFORM_TOKENS = {
	"linux-x86_64": { os: "linux", arch: "x64" },
	"linux-aarch64": { os: "linux", arch: "arm64" },
	"macos-x86_64": { os: "darwin", arch: "x64" },
	"macos-aarch64": { os: "darwin", arch: "arm64" },
	"windows-x86_64": { os: "win32", arch: "x64" },
	"windows-aarch64": { os: "win32", arch: "arm64" },
};

function biomePlatformTokens(plat) {
	const tokens = BIOME_PLATFORM_TOKENS[`${plat.os}-${plat.arch}`];
	if (!tokens) {
		throw new Error(
			`unsupported biome toolchain platform: ${plat.os}/${plat.arch}`,
		);
	}
	return tokens;
}

/**
 * Return the biome release asset filename for a platform. biome ships one
 * bare, uncompressed executable per platform — no archive to extract.
 *
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function biomeArtifactName(plat) {
	const { os, arch } = biomePlatformTokens(plat);
	const ext = plat.os === "windows" ? ".exe" : "";
	return `biome-${os}-${arch}${ext}`;
}

/**
 * Return the biome release download URL for a version and platform. biome
 * tags releases as `@biomejs/biome@X.Y.Z`, not a bare `vX.Y.Z` like
 * node/pnpm — verified against the real release tag.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function biomeDownloadUrl(version, plat) {
	return `https://github.com/biomejs/biome/releases/download/@biomejs/biome@${version}/${biomeArtifactName(plat)}`;
}

/**
 * Return the named-cache key for a biome toolchain version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function biomeCacheKey(version, plat) {
	return `${version}/${plat.os}-${plat.arch}`;
}

// The platforms this module acquires biome for and publishes lockfile
// entries for (see BIOME_PLATFORM_TOKENS).
export function biomeSupportedPlatforms() {
	return Object.keys(BIOME_PLATFORM_TOKENS).map((key) => {
		const sep = key.indexOf("-");
		return { os: key.slice(0, sep), arch: key.slice(sep + 1) };
	});
}

export class BiomeToolchain extends Toolchain {
	static kind = "biome-toolchain";
	static tool = BIOME_TOOL;
	constructor({ version, unverified }, opts) {
		super(
			{
				kind: BiomeToolchain.kind,
				attrs: { version, ...(unverified ? { unverified } : {}) },
			},
			opts,
		);
	}

	bin() {
		return biomeBin(this.attrs.version);
	}
}

// Built once per declared version, at declaration time: task() refuses to add
// graph nodes during execution, so anything that resolves a toolchain while
// the graph is running must find a handle here rather than build one.
let graphToolchains = new Map();

export function __resetBiomeToolchainStateForTest() {
	BiomeToolchain.clearDefault();
	graphToolchains = new Map();
}

function graphToolFor(version) {
	return graphToolchains.get(version) ?? biomeGraphTool(version);
}

/**
 * Declare a biome toolchain version and optionally set it as the default.
 *
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @param {boolean} [opts.unverified=false] Allow downloading without a
 *   matching lockfile entry (warns instead of failing).
 * @returns {object} Target handle for this biome toolchain.
 * @category configuration
 */
export function biomeToolchain(version, opts = {}) {
	new BiomeToolchain(
		{ version, unverified: opts.unverified },
		{ default: opts.default },
	);
	const graph = biomeGraphTool(version);
	graphToolchains.set(version, graph);
	return graph;
}

/**
 * The `[GEN_LOCKFILES]` root for a biome toolchain version.
 *
 * This is a separate function from biomeToolchain(). biomeToolchain() returns a
 * frozen tool() handle. A frozen object cannot hold an extra
 * property.
 *
 * @param {string} [version]
 * @returns {object} `{ [GEN_LOCKFILES]: ... }`.
 */
export function biomeGenLockfiles(version) {
	const resolved = BiomeToolchain.requireVersion(version);
	return {
		[GEN_LOCKFILES]: graphGenerateToolLockfile({
			version: resolved,
			...LOCKFILE_SPEC,
		}),
	};
}

/**
 * Install a local biome executable into the named cache.
 *
 * @param {string} version
 * @param {string} source Path to the biome executable.
 * @returns {string|null} Local path to the cached toolchain directory.
 */
export function installBiomeToolchain(version, source) {
	namedCache({ name: BIOME_TOOLCHAIN_CACHE, shared: true });
	const plat = platformInfo();
	const key = biomeCacheKey(version, plat);
	cachePut(BIOME_TOOLCHAIN_CACHE, key, source);
	return cacheGet(BIOME_TOOLCHAIN_CACHE, key);
}

/**
 * Resolve an explicit or default biome toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveBiomeToolchainVersion(version) {
	return BiomeToolchain.resolveVersion(version);
}

/**
 * Return the biome executable path for a toolchain version, installing the
 * toolchain if necessary.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function biomeBin(version) {
	const resolved = BiomeToolchain.requireVersion(version);
	const plat = platformInfo();
	return toolchainBin(graphToolFor(resolved), {
		name: BIOME_TOOLCHAIN_CACHE,
		key: biomeCacheKey(resolved, plat),
		exe: plat.os === "windows" ? "biome.exe" : "biome",
	});
}

/**
 * Return a graph-native Biome tool. The legacy declaration API still owns
 * default-version and lockfile-generation policy during this migration.
 */
export function biomeGraphTool(version) {
	const resolved = BiomeToolchain.requireVersion(version);
	const plat = platformInfo();
	const key = biomeCacheKey(resolved, plat);
	// Declared here rather than in biomeToolchain(): the install task below
	// publishes into this cache, and it is the graph tool — not the
	// declaration call — that every path to an installed biome goes through.
	namedCache({ name: BIOME_TOOLCHAIN_CACHE, shared: true });
	const archive = downloadToolArtifact({
		lockfile: BIOME_LOCKFILE,
		tool: "biome-toolchain",
		version: resolved,
		plat,
		url: biomeDownloadUrl(resolved, plat),
		output: `.imp/biome-downloads/${key}/${biomeArtifactName(plat)}`,
		display: `download biome ${resolved} (${plat.os}/${plat.arch})`,
		unverified: BiomeToolchain.resolveUnverified(resolved),
	});
	const shell = nativeTool("sh");
	const cp = nativeTool("cp");
	const mkdir = nativeTool("mkdir");
	const chmod = plat.os === "windows" ? null : nativeTool("chmod");
	const install = task({
		display: `install biome ${resolved} (${plat.os}/${plat.arch})`,
		inputs: { archive, shell, cp, mkdir, ...(chmod ? { chmod } : {}) },
		outputs: { directory: output.artifact() },
		async run(exec, inputs) {
			const exe = plat.os === "windows" ? "biome.exe" : "biome";
			const result = await exec.action({
				argv: [
					exec.tool(inputs.shell, "sh"),
					"-c",
					plat.os === "windows"
						? 'mkdir -p "$2" && cp "$1" "$2/biome.exe"'
						: 'mkdir -p "$2" && cp "$1" "$2/biome" && chmod +x "$2/biome"',
					"install-biome",
					exec.path(inputs.archive),
					"toolchain",
				],
				tools: [
					inputs.shell,
					inputs.cp,
					inputs.mkdir,
					...(inputs.chmod ? [inputs.chmod] : []),
				],
				outputs: {
					// Published into the named cache as well as the CAS: a
					// sandboxed consumer reaches this through exec.tool(), but
					// `imp @biome` executes it directly and needs a real
					// absolute path (see //rules/imp/toolchain).
					directory: output.directory("toolchain", {
						namedCache: { name: BIOME_TOOLCHAIN_CACHE, key },
					}),
				},
			});
			return { directory: result.outputs.directory };
		},
	});
	return graphTool(install.outputs.directory, { binDirs: ["."] });
}

/**
 * Return the currently configured default biome toolchain version.
 *
 * @returns {string|null}
 */
export function defaultBiomeToolchainVersion() {
	return BiomeToolchain.defaultVersion();
}

/**
 * Return the currently configured default biome toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultBiomeToolchain() {
	const version = BiomeToolchain.defaultVersion();
	return version ? (graphToolchains.get(version) ?? null) : null;
}

// Importing this rule provisions the pinned default. A workspace can replace
// it by declaring another biomeToolchain(..., { default: true }).
biomeToolchain("2.5.4", { default: true });

const LOCKFILE_SPEC = registerToolchainLockfile(
	{
		name: "biome-toolchain",
		platforms: biomeSupportedPlatforms(),
		downloadUrl: biomeDownloadUrl,
		artifactName: (_version, plat) => biomeArtifactName(plat),
		lockfile: BIOME_LOCKFILE,
	},
	["2.5.4"],
);
