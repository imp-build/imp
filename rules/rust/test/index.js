// Canonical Rust package-test entrypoint.
// Lazily discovers and runs a Cargo package label's test binaries. Discovery
// uses `cargo metadata --no-deps`; compilation uses one memoized `cargo test
// --no-run --message-format=json` call, shared across a real Cargo workspace,
// and the package handler executes the matching binaries concurrently.
//
// Doc-tests are not discoverable through `--no-run`; the package label's
// companion cargoTest action covers them separately.

import {
	glob,
	memo,
	output,
	output_path,
	run,
} from "imp:core";

import {
	cargoInvocationScript,
	cargoPackageAddress,
	cargoPackageActionHandle,
	cargoPackageOutputSlug,
	declared_path,
	resources,
	resourcesForDirs,
	rust_toolchain_version,
	rustBuildCacheTools,
	rustLinkerTools,
	rustToolEnv,
	sources,
	wholeWorkspaceSources,
} from "//rules/rust";
import {
	workspaceMetadataFor,
	workspaceRootRelativeFor,
} from "//rules/rust/workspace_closure";

import { defaultRustToolchain, rustTool } from "//rules/rust/toolchain";
import { nativeToolSpec } from "//rules/imp/native_tool";

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

// Test-binary-producing targets for one Cargo package, discovered without
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

// Compiles every test binary in the crate without running it. Workspace
// members share buildWorkspaceTestBinaries() across the real workspace; the
// target directory is one CAS directory output consumed by the per-binary
// runs below.
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
			const buildDir = output_path(
				`build/rust/${cargoPackageOutputSlug(handle)}`,
			);

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

// Run a package's discovered test binaries concurrently while retaining one
// memoized compile for the package (and one shared compile for a real Cargo
// workspace). The binaries are execution details of the exported package
// label rather than separately selectable synthetic targets.
export async function cargoPackageTests(handle) {
	handle = cargoPackageActionHandle(handle);
	const expected = await discoverTestTargets(handle);
	if (expected.length === 0) return [];

	const { result, buildDir, path } = await buildTestBinaries(handle);
	const ownSuffix = `/${path}/Cargo.toml`;
	const built = parseTestBinaries(result.stdout, buildDir).filter(
		(bin) =>
			(typeof bin.manifestPath !== "string" ||
				bin.manifestPath.endsWith(ownSuffix)) &&
			expected.some(
				(target) => target.name === bin.name && target.kind === bin.kind,
			),
	);
	for (const target of expected) {
		if (
			!built.some(
				(bin) => bin.name === target.name && bin.kind === target.kind,
			)
		) {
			const address = cargoPackageAddress(handle) || path;
			throw new Error(
				`${address}: cargo test --no-run didn't produce a ` +
					`"${target.kind}" binary named "${target.name}"`,
			);
		}
	}

	const testTools = await Promise.all(
		(handle.attrs.testTools || []).map(nativeToolSpec),
	);
	return Promise.all(
		built.map((binary) =>
			run({
				argv: [
					binary.executable,
					"--test-threads=1",
					...(handle.attrs.testArgs || []),
				],
				tools: testTools,
				inputs: [{ kind: "digest", digest: result.outputDigest }],
				display: `cargo test binary ${binary.executable}`,
			}),
		),
	);
}
