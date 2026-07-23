// Fans a cargoPackage out into one separately-addressable, separately-
// runnable `rust_test` target per test binary (a lib's `#[cfg(test)]` unit
// tests, each bin's unit tests, each `tests/*.rs` integration-test file) —
// mirrors how rules/c/cmake/index.js's expandCmakeProject fans a CMake
// project out into per-executable cc_test targets. Discovery is driven by
// `cargo metadata --no-deps` (see discoverTestTargets), not by compiling:
// metadata's per-target `kind`/`test` fields report exactly which targets
// `cargo test --no-run` would produce a binary for, straight from the
// manifest/on-disk layout. The actual `cargo test --no-run --message-
// format=json` compile (see buildTestBinaries) only happens lazily, once per
// crate, the first time some rust_test's own build/run product needs it —
// each minted target then matches its own name/kind against that one
// shared compile's stdout to find its compiled path (see rustTestBuild).
//
// Doc-tests aren't discoverable this way (they only ever run through a real
// `cargo test`, never `--no-run`) — they're still covered by the existing,
// unscoped cargoTest product on cargo-package itself; this fan-out is
// additive, not a replacement.

import {
	Target,
	expand,
	glob,
	hydrateTarget,
	memo,
	output,
	output_path,
	product,
	registerTarget,
	run,
	targetAddress,
	targetOutputSlug,
	BUILD,
	TEST,
} from "imp:core";

import {
	cargoInvocationScript,
	declared_path,
	defaultRustToolchain,
	normalize_deps,
	resources,
	resourcesForDirs,
	rust_toolchain_version,
	rustBuildCacheTools,
	rustLinkerTools,
	rustToolEnv,
	sources,
	wholeWorkspaceSources,
} from "//rules/rust";
import { CargoPackage } from "//rules/rust/cargo_package";
import {
	workspaceMetadataFor,
	workspaceRootRelativeFor,
} from "//rules/rust/workspace_closure";

import { rustTool } from "//rules/rust/toolchain";
import { nativeToolSpec } from "//rules/imp/native_tool";
import { RUST_TOOL } from "//rules/rust/toolchain";

function safe_target_address(handle) {
	if (!handle || handle.__imp !== true) return null;
	try {
		return targetAddress(handle);
	} catch (_) {
		return null;
	}
}

// The cargo-package a rust_test was fanned out from (see expandCargoTests),
// recovered from the rust_test's own deps rather than threaded through as a
// plain attr — a plain attr would get re-serialized/re-digested every time
// *this* target's own attrs are hashed, and (more importantly) every
// rust_test sibling would still be a distinct memo() key from the
// cargo-package itself, defeating buildTestBinaries' sharing below. Going
// through the real dep edge means every sibling's rustTestBuild resolves the
// exact same handle object the expander used, so buildTestBinaries(...) is a
// genuine memo() hit for every sibling but the first (imp#12).
function parentCargoPackage(handle) {
	const parent = (hydrateTarget(handle).deps || [])
		.map((dep) => dep.handle)
		.find((dep) => dep && dep.kind === CargoPackage.kind);
	if (!parent) {
		throw new Error(
			`${targetAddress(handle)}: rust_test has no cargo-package dependency — ` +
				"rust_test targets must be minted by expandCargoTests, not constructed directly",
		);
	}
	return parent;
}

// cargo test --no-run --message-format=json message shapes let us recover
// which target kinds produce test-profile binaries, but discovering that by
// running `--no-run` costs a full compile. `cargo metadata --no-deps` reports
// the same information (each package target's `kind` and `test` flag)
// straight from the manifest/on-disk layout, with no compilation at all —
// confirmed experimentally against real cargo: `kind`/`name`/`test` line up
// exactly with what a compiler-artifact message's `target` field reports.
// Doc-tests and build scripts never produce a `--no-run` binary, so they're
// excluded here the same way parseTestBinaries excludes them below.
function testTargetsIn(pkg) {
	if (!pkg) return [];
	return (pkg.targets || [])
		.filter(
			(t) =>
				t.test &&
				(t.kind.includes("lib") ||
					t.kind.includes("bin") ||
					t.kind.includes("test")),
		)
		.map((t) => ({ name: t.name, kind: t.kind[0] }));
}

// Standalone (non-workspaceMember) crates aren't covered by the shared,
// root-rooted workspaceMetadataFor() below — mirrors sources()'s own
// workspaceMember branch (//rules/rust): a standalone crate's manifest is
// self-contained, so a narrow, path-scoped `cargo metadata` sees everything
// it needs without the workspace-inheritance machinery workspaceClosureFor
// exists for.
const standaloneCargoMetadata = memo(
	async function standaloneCargoMetadata(path) {
		const toolSpec = await rustTool();
		const result = await run({
			argv: [
				"sh",
				"-c",
				'cargo metadata --locked --no-deps --format-version=1 --manifest-path "$1"',
				"cargo-metadata-test-discovery",
				`${path}/Cargo.toml`,
			],
			tools: toolSpec.tools,
			env: [
				`RUSTUP_HOME=${toolSpec.rustupHome}`,
				`CARGO_HOME=${toolSpec.cargoHome}`,
			],
			inputs: [
				glob({
					root: path,
					include: ["**/Cargo.toml", "Cargo.lock", "**/*.rs"],
					exclude: ["target/**"],
				}),
			],
			materialize: false,
			display: `cargo metadata ${path}`,
		});
		return JSON.parse(result.stdout);
	},
	{ display: "standalone Cargo Metadata {0}", level: "debug" },
);

// Test-binary-producing targets for one cargo-package, discovered without
// compiling anything (see testTargetsIn/standaloneCargoMetadata above).
async function discoverTestTargets(handle) {
	const path = declared_path(handle, handle.attrs.path || ".");
	if (!handle.attrs.workspaceMember) {
		const metadata = await standaloneCargoMetadata(path);
		const manifestPath = `${metadata.workspace_root}/Cargo.toml`;
		const pkg = (metadata.packages || []).find(
			(p) => p.manifest_path === manifestPath,
		);
		return testTargetsIn(pkg);
	}
	const metadata = await workspaceMetadataFor(
		path,
		rust_toolchain_version(handle),
	);
	const manifestPath = `${metadata.workspace_root}/${path}/Cargo.toml`;
	const pkg = (metadata.packages || []).find(
		(p) => p.manifest_path === manifestPath,
	);
	return testTargetsIn(pkg);
}

// Shared, memoized `cargo test --no-run --workspace` build for one real
// workspace root + toolchain configuration — replaces a per-crate build for
// workspaceMember crates (see buildTestBinaries below), same reasoning as
// runWorkspaceClippy (rules/rust/lint.js) and wholeWorkspaceFor's docstring
// (//rules/rust/workspace_closure): most crates' own closures already cover
// most or all of a typical workspace, so per-crate scoping bought little,
// and it required a narrowed manifest that fought `--locked` over lockfile
// trims. Unlike clippy's `-D warnings`, plain `cargo test --no-run` never
// artificially turns a lint into a hard error, so there's no cascading
// "sibling's issue starves this crate of any result" concern here — a
// compile error genuinely blocking a dependent is real, unavoidable cargo
// behavior, not something this rework introduces.
const buildWorkspaceTestBinaries = memo(
	async function buildWorkspaceTestBinaries(
		workspaceRootRelative,
		toolchainVersion,
		toolchainHandle,
	) {
		const toolSpec = await rustTool(toolchainVersion);
		const kacheActive = !!(toolchainHandle && toolchainHandle.attrs.kache);
		const {
			tools: linkerTools,
			rustflags,
			env: linkerEnv,
		} = await rustLinkerTools(toolchainHandle);
		const {
			tools: cacheTools,
			env: cacheEnv,
			scriptPreamble,
		} = await rustBuildCacheTools(toolchainHandle);
		const { tools: rustTools, env: rustEnv } = rustToolEnv(
			toolSpec,
			kacheActive,
		);

		const { files: srcs, memberDirs } = await wholeWorkspaceSources(
			workspaceRootRelative,
			toolchainVersion,
		);
		const resourceInputs = await resourcesForDirs(memberDirs);
		const buildDir = output_path(
			`build/rust/${workspaceRootRelative === "." ? "root" : workspaceRootRelative}`,
		);

		const prefix =
			workspaceRootRelative === "." ? "" : `${workspaceRootRelative}/`;
		const script = cargoInvocationScript(
			'cargo test --locked --no-run --workspace --message-format=json --manifest-path "$manifest" --target-dir "$target_dir" "$@"',
			{ scriptPreamble, kacheActive },
		);

		const result = await run({
			argv: [
				"sh",
				"-c",
				script,
				"cargo-test-build-workspace",
				`${prefix}Cargo.toml`,
				buildDir,
				rustflags,
			],
			tools: [...rustTools, ...linkerTools, ...cacheTools],
			env: [...rustEnv, ...linkerEnv, ...cacheEnv],
			inputs: [srcs, resourceInputs],
			outputs: [output(output_path(buildDir), { kind: "directory" })],
			materialize: false,
			display: `cargo test --no-run --workspace ${workspaceRootRelative}`,
		});

		return { result, buildDir };
	},
	{ display: "workspace test binaries {0}", level: "debug" },
);

// Compiles every test binary in the crate (without running any of them) and
// materializes the whole cargo target-dir, same as cargoBuild/cargoTest's
// toolchain/linker resolution. Always called with the cargo-package's own
// handle (see parentCargoPackage above) — every rust_test sibling shares one
// memo() entry (and, for a workspaceMember crate, one shared
// buildWorkspaceTestBinaries() execution across the whole real workspace,
// not just this crate) instead of each independently recompiling the whole
// crate (imp#12). The target-dir is declared as a materialized directory
// output, so every binary it contains already sits at its normal on-disk
// path afterwards, with no per-binary staging step needed.
const buildTestBinaries = memo(
	async function buildTestBinaries(handle) {
		const path = declared_path(handle, handle.attrs.path || ".");

		if (!handle.attrs.workspaceMember) {
			const toolSpec = await rustTool(rust_toolchain_version(handle));
			const toolchainHandle = handle.attrs.toolchain || defaultRustToolchain();
			const kacheActive = !!(toolchainHandle && toolchainHandle.attrs.kache);
			const {
				tools: linkerTools,
				rustflags,
				env: linkerEnv,
			} = await rustLinkerTools(toolchainHandle);
			const {
				tools: cacheTools,
				env: cacheEnv,
				scriptPreamble,
			} = await rustBuildCacheTools(toolchainHandle);
			const { tools: rustTools, env: rustEnv } = rustToolEnv(
				toolSpec,
				kacheActive,
			);
			const { files: srcs } = await sources(handle);
			const resourceInputs = await resources(handle);
			const buildDir = output_path(`build/rust/${targetOutputSlug(handle)}`);

			const script = cargoInvocationScript(
				'cargo test --locked --no-run --message-format=json --manifest-path "$manifest" --target-dir "$target_dir" "$@"',
				{ scriptPreamble, kacheActive },
			);

			const result = await run({
				argv: [
					"sh",
					"-c",
					script,
					"cargo-test-build",
					`${path}/Cargo.toml`,
					buildDir,
					rustflags,
				],
				tools: [...rustTools, ...linkerTools, ...cacheTools],
				env: [...rustEnv, ...linkerEnv, ...cacheEnv],
				inputs: [srcs, resourceInputs],
				outputs: [output(output_path(buildDir), { kind: "directory" })],
				materialize: false,
				display: `cargo test --no-run ${path}`,
			});

			return { result, buildDir, path };
		}

		const toolchainVersion = rust_toolchain_version(handle);
		const toolchainHandle = handle.attrs.toolchain || defaultRustToolchain();
		const workspaceRootRelative = await workspaceRootRelativeFor(
			path,
			toolchainVersion,
		);
		const { result, buildDir } = await buildWorkspaceTestBinaries(
			workspaceRootRelative,
			toolchainVersion,
			toolchainHandle,
		);
		return { result, buildDir, path };
	},
	{ display: "build Test Binaries {0}", level: "debug" },
);

// Parses `cargo test --no-run --message-format=json`'s newline-delimited
// stdout for compiled test-binary artifacts (reliable across task-cache
// hits — run()'s stdout is itself part of the persisted cache record, not
// miss-only) and rebases each absolute executable path onto the
// workspace-relative buildDir it was compiled under. Includes each binary's
// own `manifestPath` (cargo's absolute `manifest_path` for the package that
// produced it) — a shared, whole-workspace build (buildWorkspaceTestBinaries
// above) makes a same-named test target in two different crates a real (if
// unlikely) possibility that a single crate's own build never had to
// consider, so name+kind alone is no longer enough to disambiguate.
export function parseTestBinaries(stdout, buildDir) {
	const binaries = [];
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let msg;
		try {
			msg = JSON.parse(trimmed);
		} catch (_) {
			continue;
		}
		if (
			msg.reason !== "compiler-artifact" ||
			!msg.executable ||
			!(msg.profile && msg.profile.test)
		)
			continue;
		const idx = msg.executable.indexOf(buildDir);
		const executable = idx === -1 ? msg.executable : msg.executable.slice(idx);
		binaries.push({
			name: msg.target.name,
			kind: (msg.target.kind && msg.target.kind[0]) || "test",
			executable,
			manifestPath: msg.manifest_path || null,
		});
	}
	return binaries;
}

export class RustTest extends Target {
	static kind = "rust_test";
	constructor({
		cargoPackage,
		path = ".",
		toolchain,
		toolchainVersion,
		testName,
		testKind,
		testArgs = [],
		testTools = [],
		deps = [],
		workspaceMember = false,
	}) {
		// Forwards the parent cargoPackage's own resource-package deps (see
		// //rules/asset) so resources(handle) resolves the same way for a
		// fanned-out rust_test as it does for the parent — the whole crate
		// (this test binary included) is recompiled from the same sources,
		// so it needs the same extra files.
		const normalizedDeps = normalize_deps(deps);
		const normalizedTestTools = normalize_deps(testTools);
		super({
			kind: RustTest.kind,
			attrs: {
				path,
				testName,
				testKind,
				testArgs,
				testTools: normalizedTestTools,
				workspaceMember,
				...(toolchain ? { toolchain } : {}),
				...(toolchainVersion ? { toolchainVersion } : {}),
				...(normalizedDeps.length ? { deps: normalizedDeps } : {}),
			},
			deps: [
				// See parentCargoPackage above — this is how rustTestBuild finds
				// its way back to the exact handle buildTestBinaries is memo()'d
				// on, so every sibling shares one build.
				...(cargoPackage ? [{ target: cargoPackage }] : []),
				...(toolchain ? [{ target: toolchain, mode: "tool" }] : []),
				...normalizedDeps.map((target) => ({ target })),
				...normalizedTestTools.map((target) => ({ target, mode: "tool" })),
			],
		});
	}
}

export const rustTestBuild = product(
	RustTest,
	BUILD,
	RUST_TOOL,
	async function rustTestBuild(handle) {
		const cargoPackage = parentCargoPackage(handle);
		const { result, buildDir } = await buildTestBinaries(cargoPackage);
		const binaries = parseTestBinaries(result.stdout, buildDir);
		// A shared, whole-workspace build (buildWorkspaceTestBinaries) means
		// binaries from every crate share one stdout stream — disambiguate by
		// this rust_test's own crate directory (its manifest path's suffix),
		// not just name+kind, in case two different crates happen to declare
		// a same-named test target.
		const ownSuffix = `/${declared_path(cargoPackage, cargoPackage.attrs.path || ".")}/Cargo.toml`;
		const candidates = binaries.filter(
			(bin) =>
				bin.name === handle.attrs.testName &&
				bin.kind === handle.attrs.testKind,
		);
		const match =
			candidates.length <= 1
				? candidates[0]
				: candidates.find(
						(bin) =>
							typeof bin.manifestPath === "string" &&
							bin.manifestPath.endsWith(ownSuffix),
					);
		if (!match) {
			throw new Error(
				`${targetAddress(handle)}: cargo test --no-run didn't produce a ` +
					`"${handle.attrs.testKind}" binary named "${handle.attrs.testName}" ` +
					`(built: ${binaries.map((b) => `${b.kind}:${b.name}`).join(", ") || "none"})`,
			);
		}
		return {
			outputPath: match.executable,
			outputDigest: result.outputDigest,
		};
	},
	{ display: "build {0}", level: "info" },
);

// No outputs/materialize on this final step: test results aren't
// user-addressable artifacts. No impure flag: a passing run is cached and
// replayed on a later run with unchanged inputs; a failing run bails
// before any cache record is written, so it always reruns until it
// passes — same choice cargoTest/odinTest/runCTest make.
//
// --test-threads=1 makes this one binary's own #[test] fns run serially —
// the fan-out itself is what gets the parallelism/isolation (each binary is
// its own imp target, its own sandbox), not thread-level concurrency
// within a single binary.
export const rustTestRun = product(
	RustTest,
	TEST,
	RUST_TOOL,
	async function rustTestRun(handle) {
		const { outputPath, outputDigest } = await rustTestBuild(handle);
		const testTools = await Promise.all(
			(handle.attrs.testTools || []).map(nativeToolSpec),
		);
		return run({
			argv: [outputPath, "--test-threads=1", ...handle.attrs.testArgs],
			tools: testTools,
			inputs: [{ kind: "digest", digest: outputDigest }],
			display: `cargo test binary ${outputPath}`,
		});
	},
	{ display: "test {0}", level: "info" },
);

// Runs at most once per invocation, only for cargo-package targets actually
// reachable from the current goal's selection (see `ensure_expanded` in
// spike.rs). Pure `cargo metadata` — no compilation — so expansion itself
// never triggers a build; the crate is compiled exactly once, lazily, the
// first time any of its rust_test siblings' rustTestBuild actually runs
// (shared via buildTestBinaries' memo() on the cargo-package handle, see
// above).
//
// Minted addresses are prefixed with the parent cargoPackage's own target
// name (`${parentName}_tests_${discoveredName}`) to avoid collisions: a
// discovered target's name (crate name for lib unit tests, bin name for bin
// unit tests, file stem for integration tests) can otherwise collide with
// the parent's own hand-declared name, or with a sibling cargoPackage's
// discovered binaries in the same directory.
export const expandCargoTests = expand(
	CargoPackage,
	async function expandCargoTests(handle) {
		const targets = await discoverTestTargets(handle);

		const parentAddress = safe_target_address(handle);
		if (!parentAddress) return;
		const [scope, parentName] = [
			parentAddress.split(":")[0],
			parentAddress.split(":")[1],
		];

		for (const target of targets) {
			registerTarget(
				new RustTest({
					cargoPackage: handle,
					path: handle.attrs.path,
					toolchain: handle.attrs.toolchain,
					toolchainVersion: handle.attrs.toolchainVersion,
					testName: target.name,
					testKind: target.kind,
					testArgs: [],
					testTools: handle.attrs.testTools || [],
					deps: handle.attrs.deps || [],
					workspaceMember: handle.attrs.workspaceMember,
				}),
				`${scope}:${parentName}_tests_${target.name}`,
			);
		}
	},
	{
		goals: ["test"],
		display: "expand Cargo tests {0}",
		level: "info",
	},
);
