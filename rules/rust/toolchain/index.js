// Canonical Rust toolchain entrypoint.
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
} from "imp:core";
import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";
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
// consumed by rule modules registering rust-driven products.
export const RUST_TOOL = toolName("rust");

// Rust is installed via rustup, which lays out two env-located state trees:
// RUSTUP_HOME (rustup itself + installed toolchains) and CARGO_HOME (cargo
// registry + proxies). We give each its own named cache and point rustup at
// them so it never touches ~/.rustup / ~/.cargo. See declareToolchain/acquire.
const RUST_LOCKFILE = "//rules/rust/rust.lock";
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
		throw new Error(
			`unsupported rust toolchain platform: ${plat.os}/${plat.arch}`,
		);
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
	const extra = plat.os === "windows" ? [] : ["chmod"];
	return [...new Set([...lockedDownloadTools(plat), ...extra])];
}

export class RustToolchain extends Toolchain {
	static kind = "rust-toolchain";
	static tool = RUST_TOOL;
	constructor({ version, linkDriver, linker, kache, unverified }, opts) {
		super(
			{
				kind: RustToolchain.kind,
				attrs: {
					version,
					...(linkDriver ? { linkDriver } : {}),
					...(linker ? { linker } : {}),
					...(kache ? { kache } : {}),
					...(unverified ? { unverified } : {}),
				},
			},
			opts,
		);
	}

	bin() {
		return rustBin(this.attrs.version);
	}
}

// Declared lazily, once — target() addresses are only assigned at
// workspace-load time, so tool handles must be created when a toolchain is
// declared at BUILD.js top level, not inside acquireToolchain().
let coreToolHandles = null;

export function __resetRustToolchainStateForTest() {
	RustToolchain.clearDefault();
	coreToolHandles = null;
}

function declareBothCaches() {
	namedCache({ name: RUSTUP_HOME_CACHE, shared: true });
	namedCache({ name: CARGO_HOME_CACHE, shared: true });
}

/**
 * Declare a Rust toolchain version and optionally set it as the default.
 *
 * @param {string} version Exact Rust version, e.g. "1.79.0" (channels rejected).
 * @param {object} [opts]
 * @param {boolean} [opts.default=false] Set as the default toolchain.
 * @param {boolean} [opts.unverified=false] Allow downloading rustup-init
 *   without a matching lockfile entry (warns instead of failing).
 * @param {object} [opts.linkDriver] C link driver toolchain handle (e.g.
 *   gccToolchain()) registering a "rust-link-driver" product. Falls back to
 *   defaultGccToolchain() if omitted.
 * @param {object} [opts.linker] Linker toolchain handle (e.g. moldToolchain())
 *   registering a "rust-linker" product. No extra backend flag is added if
 *   omitted.
 * @param {object} [opts.kache] kache toolchain handle (e.g.
 *   kacheToolchain(), see //rules/rust/kache) registering a
 *   "rust-build-cache" product. Wraps rustc with kache and points it at a
 *   persistent on-disk object cache; no build caching beyond cargo's own
 *   (mtime-defeated, sandbox-fresh) incremental state is added if omitted.
 * @returns {object} Target handle for this Rust toolchain.
 * @category configuration
 */
export function rustToolchain(version, opts = {}) {
	requirePinnedVersion(version);
	declareBothCaches();
	if (!coreToolHandles) {
		coreToolHandles = coreToolNames(platformInfo()).map((name) =>
			nativeTool(name),
		);
	}

	return new RustToolchain(
		{
			version,
			linkDriver: opts.linkDriver,
			linker: opts.linker,
			kache: opts.kache,
			unverified: opts.unverified,
		},
		{ default: opts.default },
	);
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
export const acquireRustToolchain = memo(
	async function acquireRustToolchain(version) {
		const plat = platformInfo();
		const key = rustCacheKey(version, plat);

		if (cacheHas(RUSTUP_HOME_CACHE, key) && cacheHas(CARGO_HOME_CACHE, key)) {
			return cacheGet(RUSTUP_HOME_CACHE, key);
		}
		if (!coreToolHandles) {
			throw new Error(
				"no rust toolchain declared via rustToolchain(); nothing to acquire",
			);
		}

		const coreTools = await Promise.all(
			coreToolHandles.map((handle) => nativeToolSpec(handle)),
		);

		const rustupHomeDir = `.imp/rustup-home/${key}`;
		const cargoHomeDir = `.imp/cargo-home/${key}`;
		const rustupInitExe =
			plat.os === "windows" ? "rustup-init.exe" : "rustup-init";

		// The verified rustup-init download (pinned by rust.lock) lands in a
		// materialized scratch path; only the resulting RUSTUP_HOME/CARGO_HOME
		// are cached — the installer file is discarded with the sandbox.
		const downloadPath = `.imp/rust-downloads/${key}/${rustupInitExe}`;
		await downloadToolArtifact({
			lockfile: RUST_LOCKFILE,
			tool: "rust",
			version,
			plat,
			url: rustDownloadUrl(version, plat),
			downloadPath,
			tools: coreTools,
			display: `download rustup-init for rust ${version} (${plat.os}/${plat.arch})`,
			unverified: RustToolchain.resolveUnverified(version),
		});

		// rustup writes into RUSTUP_HOME/CARGO_HOME, which we point at via $PWD
		// (run() env can't expand $PWD, so this lives in the script). Profile
		// "minimal" plus explicit rustfmt (for fmt/format-check,
		// rules/rust/fmt.js) and clippy (for lint) components — "default" would
		// also pull in rust-docs, ~740MB of small files that dominate
		// cold-acquire time.
		const chmodStep = plat.os === "windows" ? "" : 'chmod +x "$1"; ';
		const installScript = `set -e; ${chmodStep}export RUSTUP_HOME="$PWD/$2" CARGO_HOME="$PWD/$3"; ./"$1" -y --no-modify-path --profile minimal --component rustfmt --component clippy --default-toolchain "$4"`;

		await run({
			argv: [
				"sh",
				"-c",
				installScript,
				"install-rust",
				downloadPath,
				rustupHomeDir,
				cargoHomeDir,
				version,
			],
			tools: coreTools,
			inputs: [{ kind: "file", path: downloadPath }],
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
	},
	{ display: "acquire Rust Toolchain {0}", level: "info" },
);

/**
 * Resolve an explicit or default Rust toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveRustToolchainVersion(version) {
	return RustToolchain.resolveVersion(version);
}

/**
 * Return the path to a toolchain binary (default "cargo") for a version.
 *
 * @param {string} [version]
 * @param {string} [name="cargo"]
 * @returns {Promise<string>}
 */
export async function rustBin(version, name = "cargo") {
	const resolved = RustToolchain.requireVersion(version);
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
	const resolved = RustToolchain.requireVersion(version);
	await acquireRustToolchain(resolved);
	const plat = platformInfo();
	const key = rustCacheKey(resolved, plat);
	const id = rustToolchainId(resolved, plat);
	return {
		tools: [
			{
				kind: "tool",
				name: RUSTUP_HOME_CACHE,
				cache: RUSTUP_HOME_CACHE,
				key,
				binDirs: [`toolchains/${id}/bin`],
			},
			// CARGO_HOME/bin holds the cargo-subcommand proxies rustup
			// installs for components like rustfmt (cargo-fmt) and clippy
			// (cargo-clippy) — cargo finds `cargo-<sub>` via PATH, so this
			// must be on it too, not just the toolchain's own bin dir.
			{
				kind: "tool",
				name: CARGO_HOME_CACHE,
				cache: CARGO_HOME_CACHE,
				key,
				binDirs: ["bin"],
			},
		],
		rustupHome: `.imp/tools/${RUSTUP_HOME_CACHE}`,
		cargoHome: `.imp/tools/${CARGO_HOME_CACHE}`,
		// Real, absolute, stable on-disk paths for the same two named
		// caches — bypassing the sandbox "tool" mount above. Only needed
		// when kache is wrapping rustc: see rustToolEnv() in
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
	return RustToolchain.defaultVersion();
}

/**
 * Return the currently configured default Rust toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultRustToolchain() {
	return RustToolchain.default();
}

// Importing this rule provisions the pinned default. A workspace can replace
// it by declaring another rustToolchain(..., { default: true }).
rustToolchain("1.93.0", { default: true });

const LOCKFILE_SPEC = registerToolchainLockfile(
	{
		name: "rust",
		platforms: rustSupportedPlatforms(),
		downloadUrl: rustDownloadUrl,
		artifactName: rustArtifactName,
		lockfile: RUST_LOCKFILE,
	},
	["1.93.0"],
);
product(
	RustToolchain,
	GEN_LOCKFILES,
	RUST_TOOL,
	(handle) => generateToolLockfile({ handle, ...LOCKFILE_SPEC }),
	{ display: "gen lockfiles {0}", level: "info" },
);
