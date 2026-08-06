import {
	Toolchain,
	product,
	namedCache,
	memo,
	run,
	output,
	output_path,
	platformInfo,
	cachePut,
	cacheGet,
	cacheHas,
	toolName,
	tool as graphTool,
	group,
	task,
} from "imp:core";

import { nativeTool, nativeToolSpec } from "//rules/imp/native-tool";
import {
	downloadToolArtifact,
	lockedDownloadTools,
} from "//rules/imp/lockfile";
import {
	generateToolLockfile,
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

// Bare coreutils the download/install scripts need — same reasoning as
// coreToolNames in pex_toolchain.js: the sandbox is fully hermetic, so even
// these must be declared tools. No tar/extraction step (biome is a single
// executable, not an archive).
function coreToolNames(plat) {
	const extra = plat.os === "windows" ? ["cp"] : ["cp", "chmod"];
	return [...new Set([...lockedDownloadTools(plat), ...extra])];
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

// Declared lazily, once — target() addresses are only assigned at
// workspace-load time, so tool handles must be created when a toolchain is
// declared at BUILD.js top level, not inside acquireBiomeToolchain().
let coreToolHandles = null;
let graphToolchains = new Map();

export function __resetBiomeToolchainStateForTest() {
	BiomeToolchain.clearDefault();
	coreToolHandles = null;
	graphToolchains = new Map();
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
	namedCache({ name: BIOME_TOOLCHAIN_CACHE, shared: true });
	if (!coreToolHandles) {
		coreToolHandles = coreToolNames(platformInfo()).map((name) =>
			nativeTool(name),
		);
	}

	new BiomeToolchain(
		{ version, unverified: opts.unverified },
		{ default: opts.default },
	);
	const graph = biomeGraphTool(version);
	graphToolchains.set(version, graph);
	return graph;
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
 * Acquire a biome toolchain, downloading and caching it if not already
 * installed in the named cache.
 *
 * @param {string} version
 * @returns {Promise<string>} Local path to the toolchain directory (containing `biome`).
 */
export const acquireBiomeToolchain = memo(
	async function acquireBiomeToolchain(version) {
		const plat = platformInfo();
		const key = biomeCacheKey(version, plat);

		if (!coreToolHandles) {
			throw new Error(
				"no biome toolchain declared via biomeToolchain(); nothing to acquire",
			);
		}
		const coreTools = await group(
			coreToolHandles.map((handle) => nativeToolSpec(handle)),
		);

		if (!cacheHas(BIOME_TOOLCHAIN_CACHE, key)) {
			// No archive to extract — the verified download lands the single
			// `biome` executable straight into a download path, then a small
			// install run marks it executable and publishes it into the cache.
			const exe = plat.os === "windows" ? "biome.exe" : "biome";
			const dir = `.imp/biome-toolchains/${key}`;
			const downloadPath = `.imp/biome-downloads/${key}/${biomeArtifactName(plat)}`;
			await downloadToolArtifact({
				lockfile: BIOME_LOCKFILE,
				tool: "biome-toolchain",
				version,
				plat,
				url: biomeDownloadUrl(version, plat),
				downloadPath,
				tools: coreTools,
				display: `download biome ${version} (${plat.os}/${plat.arch})`,
				unverified: BiomeToolchain.resolveUnverified(version),
			});

			const script =
				plat.os === "windows"
					? `mkdir -p "$2" && cp "$1" "$2/${exe}"`
					: `mkdir -p "$2" && cp "$1" "$2/${exe}" && chmod +x "$2/${exe}"`;
			await run({
				argv: ["sh", "-c", script, "install-biome", downloadPath, dir],
				tools: coreTools,
				inputs: [{ kind: "file", path: downloadPath }],
				outputs: [
					output(output_path(dir), {
						kind: "directory",
						namedCache: { name: BIOME_TOOLCHAIN_CACHE, key },
					}),
				],
				materialize: true,
				display: `install biome ${version} (${plat.os}/${plat.arch})`,
			});
		}

		return cacheGet(BIOME_TOOLCHAIN_CACHE, key);
	},
	{ display: "acquire Biome Toolchain {0}", level: "info" },
);

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
 * Return the biome executable path for a toolchain version.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function biomeBin(version) {
	const resolved = BiomeToolchain.requireVersion(version);
	const dir = await acquireBiomeToolchain(resolved);
	const exe = platformInfo().os === "windows" ? "biome.exe" : "biome";
	return `${dir}/${exe}`;
}

/**
 * Return a named-cache-backed biome tool descriptor for sandbox execution.
 *
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function biomeTool(version) {
	const resolved = BiomeToolchain.requireVersion(version);
	await acquireBiomeToolchain(resolved);
	const plat = platformInfo();
	return {
		kind: "tool",
		name: "biome",
		cache: BIOME_TOOLCHAIN_CACHE,
		key: biomeCacheKey(resolved, plat),
		binDirs: ["."],
	};
}

/**
 * Return a graph-native Biome tool. The legacy declaration API still owns
 * default-version and lockfile-generation policy during this migration.
 */
export function biomeGraphTool(version) {
	const resolved = BiomeToolchain.requireVersion(version);
	const plat = platformInfo();
	const key = biomeCacheKey(resolved, plat);
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
				outputs: { directory: output.directory("toolchain") },
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
product(
	BiomeToolchain,
	GEN_LOCKFILES,
	BIOME_TOOL,
	(handle) => generateToolLockfile({ handle, ...LOCKFILE_SPEC }),
	{ display: "gen lockfiles {0}", level: "info" },
);
