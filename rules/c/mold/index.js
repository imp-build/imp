import {
	Toolchain,
	product,
	namedCache,
	memo,
	output,
	platformInfo,
	cachePut,
	cacheGet,
	cacheHas,
	toolName,
	group,
	task,
	tool as graphTool,
} from "imp:core";

import { nativeTool, nativeToolSpec } from "//rules/imp/native-tool";
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
import { ODIN_LINKER } from "//rules/odin/products";

// Declared tool identity for products this toolchain implements; also
// consumed by rule modules registering mold-driven products.
export const MOLD_TOOL = toolName("mold");

const MOLD_TOOLCHAIN_CACHE = "mold-toolchains";
const MOLD_LOCKFILE = "//rules/c/mold/mold.lock";

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

export class MoldToolchain extends Toolchain {
	static kind = "mold-toolchain";
	static tool = MOLD_TOOL;
	constructor({ version, unverified }, opts) {
		super(
			{
				kind: MoldToolchain.kind,
				attrs: { version, ...(unverified ? { unverified } : {}) },
			},
			opts,
		);
	}

	bin() {
		return moldBin(this.attrs.version);
	}
}

// Declared lazily, once, the first time a toolchain is declared — target()
// addresses are only assigned at workspace-load time, so this must happen
// at BUILD.js top level rather than inside acquireToolchain() at execution time.
let coreToolHandles = null;

export function __resetMoldToolchainStateForTest() {
	MoldToolchain.clearDefault();
	coreToolHandles = null;
}

/**
 * Declare a mold toolchain version and optionally set it as the default.
 *
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @param {boolean} [opts.unverified=false] Allow downloading without a
 *   matching lockfile entry (warns instead of failing).
 * @returns {object} Target handle for this mold toolchain.
 * @category configuration
 */
export function moldToolchain(version, opts = {}) {
	namedCache({ name: MOLD_TOOLCHAIN_CACHE, shared: true });
	if (!coreToolHandles) {
		coreToolHandles = coreToolNames(platformInfo()).map((name) =>
			nativeTool(name),
		);
	}

	return new MoldToolchain(
		{ version, unverified: opts.unverified },
		{ default: opts.default },
	);
}

/**
 * Install a local mold toolchain directory into the named cache.
 *
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
 * @param {string} version
 * @returns {Promise<string>} Local path to the toolchain root.
 */
export const acquireMoldToolchain = memo(
	async function acquireMoldToolchain(version) {
		const plat = platformInfo();
		const key = moldCacheKey(version, plat);

		if (cacheHas(MOLD_TOOLCHAIN_CACHE, key)) {
			return cacheGet(MOLD_TOOLCHAIN_CACHE, key);
		}
		if (!coreToolHandles) {
			throw new Error(
				"no mold toolchain declared via moldToolchain(); nothing to acquire",
			);
		}

		const coreTools = await group(
			coreToolHandles.map((handle) => nativeToolSpec(handle)),
		);

		const downloadPath = `.imp/mold-downloads/${key}/${moldArtifactName(version, plat)}`;
		await downloadToolArtifact({
			lockfile: MOLD_LOCKFILE,
			tool: "mold",
			version,
			plat,
			url: moldDownloadUrl(version, plat),
			downloadPath,
			tools: coreTools,
			display: `download mold ${version} (${plat.os}/${plat.arch})`,
			unverified: MoldToolchain.resolveUnverified(version),
		});

		// mold's release tarball already ships bin/mold and bin/ld.mold (the
		// name clang's -fuse-ld=mold looks for) — no wrapper needed.
		await extractArchive({
			archive: downloadPath,
			dest: `.imp/mold-toolchains/${key}`,
			format: "tar.gz",
			stripComponents: 1,
			tools: coreTools,
			namedCache: { name: MOLD_TOOLCHAIN_CACHE, key },
			display: `install mold ${version} (${plat.os}/${plat.arch})`,
		});

		return cacheGet(MOLD_TOOLCHAIN_CACHE, key);
	},
	{ display: "acquire Mold Toolchain {0}", level: "info" },
);

/**
 * Build the managed mold distribution as a graph-native tool.
 *
 * A custom task() (rather than extractArchive()'s shared graph helper) so
 * the extracted directory can also populate MOLD_TOOLCHAIN_CACHE via
 * output.directory()'s namedCache option — extractArchive()'s graph form
 * explicitly rejects namedCache (it "owns its tools"), but
 * moldRustLinkerEnv() (below) needs that named-cache's real, absolute,
 * stable path: a relative `-fuse-ld=<path>` breaks in practice, the same
 * way a relative `-C linker=<path>` does — see gccRustLinkDriverEnv()'s
 * docstring in //rules/c/gcc for the confirmed failure and reasoning.
 */
export function moldGraphTool(version) {
	const resolved = MoldToolchain.requireVersion(version);
	const plat = platformInfo();
	namedCache({ name: MOLD_TOOLCHAIN_CACHE, shared: true });
	const cacheKey = moldCacheKey(resolved, plat);
	const archive = downloadToolArtifact({
		lockfile: MOLD_LOCKFILE,
		tool: "mold",
		version: resolved,
		plat,
		url: moldDownloadUrl(resolved, plat),
		output: `mold-downloads/${cacheKey}/${moldArtifactName(resolved, plat)}`,
		display: `download mold ${resolved} (${plat.os}/${plat.arch})`,
		unverified: MoldToolchain.resolveUnverified(resolved),
	});
	const mkdir = nativeTool("mkdir");
	const tar = nativeTool("tar");
	const gzip = nativeTool("gzip");
	const directory = task({
		display: `install mold ${resolved} (${plat.os}/${plat.arch})`,
		inputs: { archive, mkdir, tar, gzip },
		outputs: { directory: output.artifact() },
		async run(exec, inputs) {
			// mold's release tarball already ships bin/mold and bin/ld.mold
			// (the name clang's -fuse-ld=mold looks for) — no wrapper needed,
			// same as the legacy acquire path above.
			const result = await exec.action({
				argv: [
					"sh",
					"-c",
					'mkdir -p "$2" && tar -xzf "$1" -C "$2" --strip-components=1',
					"mold-install",
					exec.path(inputs.archive),
					"mold-toolchain",
				],
				tools: [inputs.mkdir, inputs.tar, inputs.gzip],
				outputs: {
					directory: output.directory("mold-toolchain", {
						namedCache: { name: MOLD_TOOLCHAIN_CACHE, key: cacheKey },
					}),
				},
			});
			return { directory: result.outputs.directory };
		},
	}).outputs.directory;
	return graphTool(directory, { binDirs: ["bin"] });
}

/**
 * Graph-native mold toolchain: moldGraphTool() wrapped with version
 * metadata, mirroring gccGraphToolchain()'s shape (//rules/c/gcc).
 *
 * @param {string} [version]
 * @returns {{ tool: object, version: string }}
 */
export function moldGraphToolchain(version) {
	const resolved = MoldToolchain.requireVersion(version);
	return Object.freeze({
		tool: moldGraphTool(resolved),
		version: resolved,
	});
}

/**
 * Return the currently configured default mold toolchain as graph-native
 * handles, or null if none is declared.
 *
 * @returns {object|null}
 */
export function defaultMoldGraphToolchain() {
	const version = MoldToolchain.defaultVersion();
	return version ? moldGraphToolchain(version) : null;
}

/**
 * Resolve an explicit or default mold toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveMoldToolchainVersion(version) {
	return MoldToolchain.resolveVersion(version);
}

/**
 * Return the mold executable path for a toolchain version.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function moldBin(version) {
	const resolved = MoldToolchain.requireVersion(version);
	const dir = await acquireMoldToolchain(resolved);
	return `${dir}/bin/mold`;
}

/**
 * Return a named-cache-backed mold tool descriptor for sandbox execution.
 *
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function moldTool(version) {
	const resolved = MoldToolchain.requireVersion(version);
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
 * @returns {string|null}
 */
export function defaultMoldToolchainVersion() {
	return MoldToolchain.defaultVersion();
}

/**
 * Return the currently configured default mold toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultMoldToolchain() {
	return MoldToolchain.default();
}

// Importing this rule provisions the pinned default. A workspace can replace
// it by declaring another moldToolchain(..., { default: true }).
moldToolchain("2.41.0", { default: true });

const LOCKFILE_SPEC = registerToolchainLockfile(
	{
		name: "mold",
		platforms: moldSupportedPlatforms(),
		downloadUrl: moldDownloadUrl,
		artifactName: moldArtifactName,
		lockfile: MOLD_LOCKFILE,
	},
	["2.41.0"],
);
product(
	MoldToolchain,
	GEN_LOCKFILES,
	MOLD_TOOL,
	(handle) => generateToolLockfile({ handle, ...LOCKFILE_SPEC }),
	{ display: "gen lockfiles {0}", level: "info" },
);

/**
 * Adapter exposing a mold toolchain as Odin's `-linker:mold` linker role.
 * Registered as the "odin-linker" product for the "mold-toolchain" kind so
 * odinScriptTools() (rules/odin/index.js) can resolve it dynamically via
 * productFor(handle, ODIN_LINKER) instead of a hardcoded default lookup.
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

product(
	MoldToolchain,
	ODIN_LINKER,
	MOLD_TOOL,
	(handle) => new OdinMoldLinker(handle),
	{ display: "odin linker {0}", level: "info" },
);

/**
 * Given a task's `exec` and its already-declared, resolved
 * `moldGraphToolchain().tool` input, resolve the rustflags/pathDirs
 * rustLinkerTools() (//rules/rust) needs to enable mold as rustc's backend
 * linker.
 *
 * Unlike gcc's own `-C linker=<path>` (which does accept an absolute path),
 * this Bootlin-built gcc's `-fuse-ld=` rejects an absolute path outright —
 * confirmed by a real `imp lint //crates/imp:imp` failure: "x86_64-linux-
 * gcc.br_real: error: unrecognized command-line option '-fuse-ld=<path>'"
 * (see #60/#31). So this keeps a bare `-fuse-ld=mold` PATH-search form, and
 * instead returns the real, absolute, stable MOLD_TOOLCHAIN_CACHE bin
 * directory (via cacheGet(), populated by moldGraphTool()'s own install task
 * above) as `pathDirs` for the caller to fold into PATH — mirroring how
 * rustGraphToolEnv()'s kache-active branch already builds PATH from
 * named-cache directories (//rules/rust/toolchain). exec.path() is still
 * called, purely to consume() the binding so the graph scheduler orders
 * mold's install task (and therefore this named-cache population) first.
 *
 * @param {object} exec Task's exec (see task()'s run(exec, resolved) body).
 * @param {object} resolvedMoldTool Resolved `moldGraphToolchain().tool` input.
 * @param {string} version `moldGraphToolchain().version`.
 * @returns {{ rustflags: string[], pathDirs: string[] }}
 */
export function moldRustLinkerEnv(exec, resolvedMoldTool, version) {
	exec.path(resolvedMoldTool);
	const plat = platformInfo();
	const dir = cacheGet(MOLD_TOOLCHAIN_CACHE, moldCacheKey(version, plat));
	return {
		rustflags: ["-C", "link-arg=-fuse-ld=mold"],
		pathDirs: [`${dir}/bin`],
	};
}
