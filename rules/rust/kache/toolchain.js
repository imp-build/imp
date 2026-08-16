// kache (https://github.com/kunobi-ninja/kache) wraps rustc via RUSTC_WRAPPER
// and caches compiled objects keyed by the actual compiler inputs (source
// content, flags, compiler version) rather than by file mtimes — this is
// what makes it work at all despite imp's sandboxes being fresh/copied on
// every build, which otherwise defeats cargo's own mtime-based incremental
// fingerprinting (cargo's target-dir is never reused across invocations
// today; see the design discussion this toolchain was added for).
//
// Two named caches are used for two different reasons:
//   - KACHE_TOOLCHAIN_CACHE holds the downloaded kache binary itself, keyed
//     by version+platform, exactly like rules/c/mold/index.js.
//   - KACHE_DATA_CACHE holds kache's own object cache (what KACHE_CACHE_DIR
//     points at), keyed by platform only (not kache version) since it's a
//     content-addressed object store kache manages incrementally, not a
//     versioned tool install. It must be mounted as a "tool" (symlinked
//     in-place, not copied) so writes made during a build persist on disk
//     for the next invocation — see materialize_tools_into_sandbox in
//     src/exec.rs.
import {
	Toolchain,
	configuration,
	defineConfigSchema,
	field,
	product,
	namedCache,
	run,
	output,
	platformInfo,
	cachePut,
	cacheGet,
	cacheHas,
	resolveGraphHandle,
	workerStart,
	task,
	toolName,
	tool as graphTool,
} from "imp:core";

import { nativeTool } from "//rules/imp/native-tool";
import { downloadToolArtifact } from "//rules/imp/lockfile";
import { extractArchive } from "//rules/imp/archive";
import {
	toolchainBin,
	toolchainDir,
	toolchainToolSpec,
} from "//rules/imp/toolchain";
import {
	generateToolLockfile,
	GEN_LOCKFILES,
	registerToolchainLockfile,
} from "//rules/workflows/lockfiles";
import { RUST_BUILD_CACHE } from "//rules/rust/products";

// Declared tool identity for products this toolchain implements; also
// consumed by rule modules registering kache-driven products.
export const KACHE_TOOL = toolName("kache");

const KACHE_TOOLCHAIN_CACHE = "kache-toolchains";
const KACHE_LOCKFILE = "//rules/rust/kache/kache.lock";
const KACHE_DATA_CACHE = "kache-data";

// kache's own default (50 GiB) is the only thing bounding KACHE_CACHE_DIR's
// growth otherwise — imp's own GC can't prune inside it (see
// RustKacheWrapper's doc comment below), so an explicit, smaller cap is set
// unless a rule author overrides it via kacheToolchain(version, { cacheSize }).
const DEFAULT_CACHE_SIZE = "4GiB";

export const kacheConfigSchema = {
	cacheExecutables: field.bool({ default: false }),
};

defineConfigSchema("kache", kacheConfigSchema);

function cache_executables_env() {
	const config = configuration("kache", {}) || {};
	return config.cacheExecutables === true ? "1" : "0";
}

// kache ships musl builds for Linux (no glibc-version coupling needed) and
// native builds for macOS/Windows. Unlike sccache, kache's Windows release
// has no tar.gz — only a raw .exe and a .zip — so Windows extracts via zip.
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
		throw new Error(
			`unsupported kache toolchain platform: ${plat.os}/${plat.arch}`,
		);
	}
	return triple;
}

/**
 * Return the kache release artifact filename for a version and platform.
 * Unlike sccache/zola, kache's release assets don't embed the version in the
 * filename — only the release tag in the URL path distinguishes versions.
 *
 * @param {string} _version Unused; kept for parity with other toolchains'
 *   artifactName(version, plat) signature.
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function kacheArtifactName(_version, plat) {
	const ext = plat.os === "windows" ? "zip" : "tar.gz";
	return `kache-${targetTriple(plat)}.${ext}`;
}

/**
 * Return the kache release download URL for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function kacheDownloadUrl(version, plat) {
	return `https://github.com/kunobi-ninja/kache/releases/download/v${version}/${kacheArtifactName(version, plat)}`;
}

/**
 * Return the named-cache key for a kache toolchain version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function kacheCacheKey(version, plat) {
	return `${version}/${plat.os}-${plat.arch}`;
}

/**
 * Return the named-cache key for the kache data (object cache) directory.
 * Deliberately independent of the kache binary version — the on-disk cache
 * format is stable across kache releases in practice, and there's no reason
 * to throw away accumulated cache hits on a routine kache bump.
 *
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function kacheDataCacheKey(plat) {
	return `${plat.os}-${plat.arch}`;
}

/**
 * Return the platforms kache publishes release archives for.
 *
 * @returns {Array<{ os: string, arch: string }>}
 */
export function kacheSupportedPlatforms() {
	return Object.keys(TARGET_TRIPLES).map((key) => {
		const sep = key.indexOf("-");
		return { os: key.slice(0, sep), arch: key.slice(sep + 1) };
	});
}

export class KacheToolchain extends Toolchain {
	static kind = "kache-toolchain";
	static tool = KACHE_TOOL;
	constructor({ version, unverified, cacheSize }, opts) {
		super(
			{
				kind: KacheToolchain.kind,
				attrs: {
					version,
					cacheSize: cacheSize || DEFAULT_CACHE_SIZE,
					...(unverified ? { unverified } : {}),
				},
			},
			opts,
		);
	}

	// kache is a compiler wrapper resolved through the RUST_BUILD_CACHE role,
	// not an @tool-dispatchable binary; expose the cached binary path.
	bin() {
		return kacheBin(this.attrs.version);
	}
}

// Built once per declared version, at declaration time. This map is what
// makes kache work at all: RustKacheWrapper resolves the toolchain from
// inside a running cargo task body (rules/rust/index.js), and task() refuses
// to add graph nodes during execution — so the handle must already exist.
let graphToolchains = new Map();
// The KACHE_DATA_CACHE seed task (see kacheDataSeed); one per platform key.
let dataSeeds = new Map();

export function __resetKacheToolchainStateForTest() {
	KacheToolchain.clearDefault();
	graphToolchains = new Map();
	dataSeeds = new Map();
}

function graphToolFor(version) {
	return graphToolchains.get(version) ?? kacheGraphTool(version);
}

/**
 * Declare a kache toolchain version and optionally set it as the default.
 *
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @param {boolean} [opts.unverified=false] Allow downloading without a
 *   matching lockfile entry (warns instead of failing).
 * @param {string} [opts.cacheSize="4GiB"] KACHE_MAX_SIZE — caps
 *   KACHE_CACHE_DIR's on-disk size (kache's own default is 50 GiB; imp's
 *   GC can't prune inside it, only delete it wholesale — see
 *   RustKacheWrapper's doc comment).
 * @returns {object} Target handle for this kache toolchain.
 * @category configuration
 */
export function kacheToolchain(version, opts = {}) {
	const cacheSize = opts.cacheSize || DEFAULT_CACHE_SIZE;
	namedCache({ name: KACHE_TOOLCHAIN_CACHE, shared: true });
	namedCache({
		name: KACHE_DATA_CACHE,
		details: async () => {
			const plat = platformInfo();
			const toolKey = kacheCacheKey(version, plat);
			const dataKey = kacheDataCacheKey(plat);
			if (
				!cacheHas(KACHE_TOOLCHAIN_CACHE, toolKey) ||
				!cacheHas(KACHE_DATA_CACHE, dataKey)
			) {
				// Never acquired/seeded in this workspace — nothing to report.
				return null;
			}
			const exe = plat.os === "windows" ? "kache.exe" : "kache";
			const bin = `${cacheGet(KACHE_TOOLCHAIN_CACHE, toolKey)}/${exe}`;
			const dataDir = cacheGet(KACHE_DATA_CACHE, dataKey);
			const cacheExecutables = cache_executables_env();

			// Unlike sccache's --show-stats (which auto-spawns its own
			// transient server if none is running), kache's `stats` command
			// only reports against a daemon that's actually up — so ensure it
			// here too, the same way env() does for an actual build. This is
			// idempotent/singleton (see workerStart's own doc comment), so
			// calling it from a standalone `imp cache stats --details`
			// invocation that never ran a build first still works.
			//
			// KACHE_MAX_SIZE must be set here too, on the daemon's own start
			// env, not just on client (rustc wrapper) invocations below: the
			// daemon is a singleton per workspace (see worker.rs) — whichever
			// caller reaches workerStart() first fixes its env for the
			// process's whole lifetime, so if this were the first caller (a
			// standalone `cache stats` before any build) the daemon would
			// otherwise start with kache's own 50GiB default and stay there.
			await workerStart("kache", {
				argv: [bin, "daemon", "run"],
				env: [
					`KACHE_CACHE_DIR=${dataDir}`,
					`KACHE_MAX_SIZE=${cacheSize}`,
					`KACHE_CACHE_EXECUTABLES=${cacheExecutables}`,
					"KACHE_LOCAL_ONLY=1",
				],
				healthCheckArgv: [bin, "daemon", "status"],
			});

			const result = await run({
				argv: [bin, "stats"],
				env: [
					`KACHE_CACHE_DIR=${dataDir}`,
					`KACHE_CACHE_EXECUTABLES=${cacheExecutables}`,
					"KACHE_LOCAL_ONLY=1",
				],
				impure: true,
				sandbox: false,
				allowFailure: true,
				display: "kache stats",
			});
			return result.exitCode === 0 ? result.stdout.trim() : null;
		},
	});
	kacheDataSeed();

	const toolchain = new KacheToolchain(
		{ version, unverified: opts.unverified, cacheSize: opts.cacheSize },
		{ default: opts.default },
	);
	graphToolchains.set(version, kacheGraphTool(version));
	return toolchain;
}

/**
 * Install a local kache toolchain directory into the named cache.
 *
 * @param {string} version
 * @param {string} source Path to the toolchain root.
 * @returns {string|null} Local path to the cached toolchain root.
 */
export function installKacheToolchain(version, source) {
	namedCache({ name: KACHE_TOOLCHAIN_CACHE, shared: true });
	const plat = platformInfo();
	const key = kacheCacheKey(version, plat);
	cachePut(KACHE_TOOLCHAIN_CACHE, key, source);
	return cacheGet(KACHE_TOOLCHAIN_CACHE, key);
}

/**
 * Acquire the kache binary as a graph-native tool: a straightforward
 * downloadToolArtifact()+extractArchive() port, mirroring
 * rules/odin/toolchain.js's odinGraphTool() — kache's release archives are
 * flat, so no stripComponents is needed here either.
 *
 * The RUSTC_WRAPPER env/daemon-lifecycle wiring (workerStart(), see
 * RustKacheWrapper below) has no graph-native equivalent to port to yet: it
 * stays a plain async helper, called directly from inside whichever cargo
 * action task body needs it (rules/rust's graph-native build/test/lint
 * passes) rather than being wrapped in its own task() here.
 *
 * @param {string} [version]
 * @returns {object} A tool handle accepted by exec.tool()/exec.action().
 */
export function kacheGraphTool(version) {
	const resolved = KacheToolchain.requireVersion(version);
	const plat = platformInfo();
	const key = kacheCacheKey(resolved, plat);
	namedCache({ name: KACHE_TOOLCHAIN_CACHE, shared: true });
	const archive = downloadToolArtifact({
		lockfile: KACHE_LOCKFILE,
		tool: "kache",
		version: resolved,
		plat,
		url: kacheDownloadUrl(resolved, plat),
		output: `kache-downloads/${key}/${kacheArtifactName(resolved, plat)}`,
		display: `download kache ${resolved} (${plat.os}/${plat.arch})`,
		unverified: KacheToolchain.resolveUnverified(resolved),
	});
	const directory = extractArchive({
		archive,
		dest: "kache-toolchain",
		format: plat.os === "windows" ? "zip" : "tar.gz",
		namedCache: { name: KACHE_TOOLCHAIN_CACHE, key },
		display: `install kache ${resolved} (${plat.os}/${plat.arch})`,
	});
	return graphTool(directory, { binDirs: ["."] });
}

/**
 * Task that creates KACHE_DATA_CACHE as a real, empty directory.
 *
 * kache's object cache must be mounted as a "tool" (symlinked in place, not
 * copied) so writes made during a build persist for the next invocation, and
 * a tool mount needs its cache path to already exist as a directory.
 * Re-running this task cannot discard the accumulated object cache: a
 * named-cache slot is immutable by key, so materialize_named_cache_artifacts
 * skips a destination that already exists (crates/imp-store/src/cache.rs).
 */
function kacheDataSeed() {
	const plat = platformInfo();
	const key = kacheDataCacheKey(plat);
	const existing = dataSeeds.get(key);
	if (existing) return existing;
	const shell = nativeTool("sh");
	const mkdir = nativeTool("mkdir");
	const seed = task({
		display: `init kache data dir (${plat.os}/${plat.arch})`,
		inputs: { shell, mkdir },
		outputs: { directory: output.artifact() },
		async run(exec, inputs) {
			const result = await exec.action({
				argv: [
					exec.tool(inputs.shell, "sh"),
					"-c",
					'mkdir -p "$1"',
					"init-kache-data",
					"kache-data",
				],
				tools: [inputs.shell, inputs.mkdir],
				outputs: {
					directory: output.directory("kache-data", {
						namedCache: { name: KACHE_DATA_CACHE, key },
					}),
				},
			});
			return { directory: result.outputs.directory };
		},
	});
	dataSeeds.set(key, seed.outputs.directory);
	return seed.outputs.directory;
}

/**
 * Return the absolute host path of the kache binary for a toolchain version.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function kacheBin(version) {
	const resolved = KacheToolchain.requireVersion(version);
	const plat = platformInfo();
	return toolchainBin(graphToolFor(resolved), {
		name: KACHE_TOOLCHAIN_CACHE,
		key: kacheCacheKey(resolved, plat),
		exe: plat.os === "windows" ? "kache.exe" : "kache",
	});
}

/**
 * Resolve an explicit or default kache toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveKacheToolchainVersion(version) {
	return KacheToolchain.resolveVersion(version);
}

/**
 * Return a named-cache-backed kache tool descriptor for sandbox execution.
 *
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function kacheTool(version) {
	const resolved = KacheToolchain.requireVersion(version);
	const plat = platformInfo();
	return toolchainToolSpec(graphToolFor(resolved), {
		toolName: "kache",
		name: KACHE_TOOLCHAIN_CACHE,
		key: kacheCacheKey(resolved, plat),
		binDirs: ["."],
	});
}

/**
 * Return the real, absolute, on-disk path of kache's persistent data (object
 * cache) directory — deliberately the raw cacheGet() path, not a
 * sandbox-mounted "tool" alias. Sandboxed run()s aren't namespace-isolated
 * (see materialize_tools_into_sandbox in src/exec.rs: tools are symlinked
 * in, inputs hardlinked in, but the spawned process still has full,
 * ordinary filesystem access), so a real absolute path is reachable from
 * inside the sandbox just fine — and it needs to be a genuinely stable path,
 * not a sandbox-relative one, precisely because it's handed to a long-lived
 * kache background daemon (see RustKacheWrapper.wrapScript) whose own env
 * must outlive any single sandbox.
 *
 * @returns {Promise<string>}
 */
export async function kacheDataDir() {
	const key = kacheDataCacheKey(platformInfo());
	await resolveGraphHandle(kacheDataSeed());
	return cacheGet(KACHE_DATA_CACHE, key);
}

/**
 * Return the currently configured default kache toolchain version.
 *
 * @returns {string|null}
 */
export function defaultKacheToolchainVersion() {
	return KacheToolchain.defaultVersion();
}

/**
 * Return the currently configured default kache toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultKacheToolchain() {
	return KacheToolchain.default();
}

// Importing this rule provisions the pinned default. A workspace can replace
// it by declaring another kacheToolchain(..., { default: true }).
kacheToolchain("0.11.0", { default: true });

const LOCKFILE_SPEC = registerToolchainLockfile(
	{
		name: "kache",
		platforms: kacheSupportedPlatforms(),
		downloadUrl: kacheDownloadUrl,
		artifactName: kacheArtifactName,
		lockfile: KACHE_LOCKFILE,
	},
	["0.11.0"],
);
product(
	KacheToolchain,
	GEN_LOCKFILES,
	KACHE_TOOL,
	function generateKacheLockfiles(handle) {
		return generateToolLockfile({ handle, ...LOCKFILE_SPEC });
	},
	{ display: "gen lockfiles {0}", level: "info" },
);

/**
 * Adapter exposing a kache toolchain as Rust's RUSTC_WRAPPER, sharing a
 * persistent on-disk object cache across sandboxed cargo builds. Registered
 * as the "rust-build-cache" product for the "kache-toolchain" kind so
 * rules/rust/index.js can resolve it dynamically via
 * productFor(handle, RUST_BUILD_CACHE) the same way it resolves
 * "rust-link-driver"/"rust-linker".
 */
export class RustKacheWrapper {
	constructor(handle) {
		this.handle = handle;
	}

	/** @returns {Promise<object[]>} run({ tools }) entries this wrapper needs. */
	async tools() {
		return [await kacheTool(this.handle.attrs.version)];
	}

	/**
	 * Shell text to run before invoking cargo, once the caller has captured
	 * `imp_sandbox_root="$(pwd)"` as the first statement of its own script
	 * (same idiom as rules/c/cmake/index.js's zigEnvExportStmts — see its doc
	 * comment for why this can't just be one more entry in env()'s array).
	 *
	 * KACHE_BASE_DIR can't be a literal path handed through run()'s env:,
	 * because the sandbox root doesn't exist yet when env: is hashed into the
	 * task key (crates/imp-execution/src/exec.rs computes the key before
	 * creating the sandbox) — only the symbolic shell reference
	 * `$imp_sandbox_root`, resolved by the shell at actual run time, is
	 * safe to bake into the hashed script text. Without KACHE_BASE_DIR at
	 * all, kache keys compiles partly off the absolute paths rustc is
	 * invoked with, which differ on every sandbox — so cache entries almost
	 * never hit and the cache just grows. KACHE_BASE_DIR tells kache which
	 * prefix is "the sandbox" so it can normalize those paths away before
	 * hashing.
	 *
	 * @returns {string}
	 */
	scriptPreamble() {
		return 'export KACHE_BASE_DIR="$imp_sandbox_root"; ';
	}

	/**
	 * Ensure kache's background daemon is running, then return the env
	 * entries wiring rustc through it.
	 *
	 * The daemon is started via workerStart() (see //rules/imp, backed by
	 * src/worker.rs) rather than left to run ad hoc from inside a sandbox:
	 * every imp run() sandbox gets a fresh TMPDIR/HOME that's deleted with
	 * its sandbox (src/exec.rs's sandbox_home_tmp), so a daemon spawned from
	 * inside one sandbox would end up pointed at directories that no longer
	 * exist as soon as that sandbox is torn down. workerStart() instead
	 * spawns the daemon directly from the host into a stable,
	 * workspace-scoped directory that outlives any single sandbox (and this
	 * imp process), and is idempotent/singleton across concurrent run()s
	 * (`--jobs > 1`) requesting it at once.
	 *
	 * @returns {Promise<string[]>} env entries wiring rustc through kache.
	 */
	async env() {
		const version = this.handle.attrs.version;
		const plat = platformInfo();
		const resolved = KacheToolchain.requireVersion(version);
		const exe = plat.os === "windows" ? "kache.exe" : "kache";
		const dir = await toolchainDir(graphToolFor(resolved), {
			name: KACHE_TOOLCHAIN_CACHE,
			key: kacheCacheKey(resolved, plat),
		});
		const bin = `${dir}/${exe}`;
		const dataDir = await kacheDataDir();
		const cacheSize = this.handle.attrs.cacheSize;
		const cacheExecutables = cache_executables_env();

		// KACHE_MAX_SIZE goes on the daemon's own start env, not just the
		// client env returned below: the daemon is a singleton per workspace
		// (see worker.rs) that fixes its env at first start, so it must carry
		// the real limit itself rather than relying on whichever client
		// happens to start it. It's set on the client env too (below) since
		// kache's own docs describe size-pressure GC as triggered by "the
		// wrapper" — each individual `kache rustc ...` client invocation
		// checks the store size against KACHE_MAX_SIZE and spawns a `kache
		// gc` subprocess when needed — so both sides need it.
		await workerStart("kache", {
			argv: [bin, "daemon", "run"],
			env: [
				`KACHE_CACHE_DIR=${dataDir}`,
				`KACHE_MAX_SIZE=${cacheSize}`,
				`KACHE_CACHE_EXECUTABLES=${cacheExecutables}`,
				"KACHE_LOCAL_ONLY=1",
			],
			healthCheckArgv: [bin, "daemon", "status"],
		});

		return [
			`KACHE_CACHE_DIR=${dataDir}`,
			"RUSTC_WRAPPER=kache",
			`KACHE_MAX_SIZE=${cacheSize}`,
			`KACHE_CACHE_EXECUTABLES=${cacheExecutables}`,
			// User-requested: never let kache reach for S3/planner remote
			// caching, even if a config file elsewhere on the host enables
			// it — env wins over the config file for this setting.
			"KACHE_LOCAL_ONLY=1",
			// kache strips rustc's own `-C incremental=<dir>` flag itself
			// (setting CARGO_INCREMENTAL=0 on the child process would be too
			// late, since cargo injects the flag before the wrapper runs),
			// but kache's own benchmark/e2e scenarios still set this
			// explicitly too — it keeps cargo's target-dir lean and removes
			// a redundant, discarded-every-sandbox incremental state anyway.
			"CARGO_INCREMENTAL=0",
		];
	}
}

product(
	KacheToolchain,
	RUST_BUILD_CACHE,
	KACHE_TOOL,
	function kacheRustBuildCacheWrapper(handle) {
		return new RustKacheWrapper(handle);
	},
	{ display: "rust build cache {0}", level: "info" },
);
