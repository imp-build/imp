// Turns one real Cargo workspace's `cargo metadata` output into a keyed
// expand(), one child per crate name.
//
// A single `cargo clippy --workspace`/`cargo test --no-run --workspace`/
// `cargo fmt --check`/`cargo test --doc --workspace` run is shared by every
// workspace member's corresponding root instead of one cargo invocation per
// crate — most crates' own dependency closures already cover most of a
// typical workspace, so per-crate scoping buys little isolation in practice.
// Each per-crate root locally filters/attributes the shared run's output by
// path substring instead of invoking cargo itself.

import {
	FMT,
	LINT,
	TEST,
	configuration,
	expand,
	files,
	output,
	task,
} from "imp:core";

import {
	cargoPackageHandles,
	linkerHandlesForSpec,
	linkerToolInputs,
	toolEnvAndTools,
} from "//rules/rust";

// Resolves RUSTUP_HOME/CARGO_HOME/PATH (+ linker/build-cache tools/env) for
// one cargo invocation — every task below needs this, not just the compiling
// ones: `cargo fmt`/`cargo metadata` still need RUSTUP_HOME/CARGO_HOME set
// for cargo to recognize the rustfmt/clippy components rustup installed
// (its subcommand dispatch consults rustup's own settings under RUSTUP_HOME,
// not just PATH). The extra linker/cache tools and RUSTC_WRAPPER env picked
// up along the way are unused by non-compiling commands, and harmless.
async function cargoEnv(exec, input, toolchainSpec) {
	return toolEnvAndTools(
		exec,
		{
			rustupHomeTool: input.toolchain,
			cargoHomeTool: input.cargoHomeTool,
			gccTool: input.gccTool,
			moldTool: input.moldTool,
		},
		toolchainSpec,
	);
}

function toolchainInputs(toolchainSpec) {
	return {
		toolchain: toolchainSpec.toolchain.tool,
		cargoHomeTool: toolchainSpec.toolchain.cargoHomeTool,
		...linkerToolInputs(linkerHandlesForSpec(toolchainSpec)),
	};
}

// Extra graph-native input handles (cargoPackage({deps})/{testDeps}) keyed
// for a task()'s own `inputs:` map, and the matching resolved-binding list
// for exec.action()'s `inputs:` array.
function extraInputs(prefix, deps) {
	return Object.fromEntries(deps.map((d, i) => [`${prefix}${i}`, d]));
}

function resolvedExtraInputs(prefix, input, deps) {
	return deps.map((_, i) => input[`${prefix}${i}`]);
}

// The workspace-wide `rustConfig.doctest` default (see
// //rules/rust/generate_build's rustConfigSchema) — this repo's own
// imp.workspace.js sets it to false. No per-package `doctest` override is
// supported yet in the graph-native model (deferred simplification, no real
// crate here needs one today — see //rules/rust's module docstring).
function doctestEnabled() {
	const rust = configuration("rust", {}) || {};
	return rust.doctest !== false;
}

function noopDoctestTask(display) {
	return task({ display, async run() {} });
}

// Parses `cargo test --no-run --message-format=json`'s newline-delimited
// stdout for compiled test-binary artifacts and rebases each absolute
// executable path onto the workspace-relative buildDir it was compiled
// under. Includes each binary's own `manifestPath` (cargo's absolute
// `manifest_path` for the package that produced it) — a shared,
// whole-workspace build makes a same-named test target in two different
// crates a real (if unlikely) possibility, so name+kind alone isn't enough
// to disambiguate.
function parseTestBinaries(stdout, buildDir) {
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

// Every cargoPackage({testTools}) declared for crate directory `dir`, deduped
// by reference — nativeTool() bindings are stable per call site, so the same
// tool declared twice resolves to the same object. Mirrors the legacy
// testToolsForDirs (rules/rust/index.js, pre-migration): test binaries and
// doc-tests run as real subprocesses that may shell out to tools the crate
// itself doesn't build with (e.g. git, tar), declared via cargoPackage's
// `testTools` option. Read from the registry rather than threaded through
// expand()'s own inputs, since a crate's own testTools aren't knowable until
// every crates/*/BUILD.js has been loaded — safe here because create()'s
// body only runs during graph resolution, after all BUILD.js evaluation.
function registryValuesForDir(dir, field) {
	const seen = new Set();
	const values = [];
	for (const spec of cargoPackageHandles()) {
		if (spec.path !== dir) continue;
		for (const value of spec[field]) {
			if (seen.has(value)) continue;
			seen.add(value);
			values.push(value);
		}
	}
	return values;
}

function registryValuesForDirs(dirs, field) {
	const seen = new Set();
	const values = [];
	for (const dir of dirs) {
		for (const value of registryValuesForDir(dir, field)) {
			if (seen.has(value)) continue;
			seen.add(value);
			values.push(value);
		}
	}
	return values;
}

function testToolsForDir(dir) {
	return registryValuesForDir(dir, "testTools");
}

function testToolsForDirs(dirs) {
	return registryValuesForDirs(dirs, "testTools");
}

// A crate's own build-time resource inputs (cargoPackage({deps})) — needed
// wherever cargo actually compiles that crate's code (clippy, test-build,
// doctest all compile; fmt/metadata don't). Same registry-read rationale as
// testToolsForDir above: not knowable until every crates/*/BUILD.js has
// loaded, so read lazily from create()'s body rather than threaded through
// expand()'s own inputs.
function depsForDir(dir) {
	return registryValuesForDir(dir, "deps");
}

function depsForDirs(dirs) {
	return registryValuesForDirs(dirs, "deps");
}

// A crate's own runtime-only resource inputs (cargoPackage({testDeps})) —
// needed only where compiled code actually executes (test binaries,
// doctests), not at compile time.
function testDepsForDir(dir) {
	return registryValuesForDir(dir, "testDeps");
}

function testDepsForDirs(dirs) {
	return registryValuesForDirs(dirs, "testDeps");
}

// cargo's own `manifest_path`/`workspace_root` fields are always absolute;
// every other path used throughout the Rust rules is workspace-relative.
function manifestDirRelativeTo(manifestPath, workspaceRoot) {
	const rel = manifestPath.slice(workspaceRoot.length).replace(/^\/+/, "");
	const index = rel.lastIndexOf("/");
	return index < 0 ? "." : rel.slice(0, index);
}

function manifestSources(root) {
	return files({
		root,
		include: ["**/Cargo.toml", "Cargo.lock", "**/*.rs"],
		exclude: ["target/**"],
	});
}

function metadataTask(
	display,
	manifestPath,
	manifests,
	toolchainSpec,
	extraArgs = [],
) {
	return task({
		display,
		inputs: { manifests, ...toolchainInputs(toolchainSpec) },
		outputs: { metadata: output.value() },
		async run(exec, input) {
			const { tools, env } = await cargoEnv(exec, input, toolchainSpec);
			const result = await exec.action({
				argv: [
					exec.tool(input.toolchain, "cargo"),
					"metadata",
					"--locked",
					"--no-deps",
					"--format-version=1",
					"--manifest-path",
					manifestPath,
					...extraArgs,
				],
				tools,
				env,
				inputs: [input.manifests],
			});
			if (result.exitCode !== 0) throw new Error(result.stderr);
			return { metadata: JSON.parse(result.stdout) };
		},
	});
}

// One shared `cargo clippy --workspace` run for a real workspace root. No
// `-D warnings` here (unlike the standalone, single-crate path below):
// promoting a warning to a hard compile error under `--workspace` would stop
// that crate's artifact from being produced at all, silently starving every
// dependent crate of any diagnostic whatsoever — see lint.js's module
// docstring for the full reasoning, which this mirrors exactly.
function workspaceClippyTask(
	workspaceRootRelative,
	manifestPath,
	manifests,
	toolchainSpec,
	deps,
) {
	return task({
		display: `cargo clippy --workspace ${workspaceRootRelative}`,
		inputs: {
			manifests,
			...toolchainInputs(toolchainSpec),
			...extraInputs("dep", deps),
		},
		outputs: { report: output.value() },
		async run(exec, input) {
			const { tools, env, rustflags } = await cargoEnv(
				exec,
				input,
				toolchainSpec,
			);
			const result = await exec.action({
				argv: [
					exec.tool(input.toolchain, "cargo"),
					"clippy",
					"--locked",
					"--workspace",
					"--message-format=json",
					"--manifest-path",
					manifestPath,
					"--color=always",
				],
				tools,
				env: [...env, `RUSTFLAGS=${rustflags}`],
				inputs: [input.manifests, ...resolvedExtraInputs("dep", input, deps)],
				allowFailure: true,
			});
			const messages = [];
			for (const line of result.stdout.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					messages.push(JSON.parse(trimmed));
				} catch (_) {
					// non-JSON diagnostic noise clippy writes straight to
					// stdout/stderr; ignored, same as lint.js.
				}
			}
			return {
				report: { exitCode: result.exitCode, messages, stderr: result.stderr },
			};
		},
	});
}

function attributedMessages(messages, dir) {
	return messages.filter((msg) => {
		const p = (msg.target && msg.target.src_path) || msg.manifest_path;
		return typeof p === "string" && p.includes(`/${dir}/`);
	});
}

// Per-crate [LINT] root: attributes the shared workspace clippy run's
// diagnostics back to this one crate by path substring, same as
// lint.js's cargoClippy(). Returns { ok, output } (not throw-on-failure) —
// //rules/workflows/lint_goal's graphLintGoal aggregates every selected
// target's own { ok, output } result into one pass/fail report (same
// contract rules/odin/index.js's own [LINT] task uses), rather than treating
// a per-target exception as the failure signal the way [TEST] does.
function crateLintTask(workspaceRootRelative, dir, clippy) {
	return task({
		display: `cargo clippy ${dir}`,
		inputs: { report: clippy.outputs.report, dir },
		outputs: { result: output.value() },
		async run(_exec, input) {
			const { exitCode, messages, stderr } = input.report;
			const own = attributedMessages(messages, input.dir);
			const diagnostics = own
				.filter((msg) => msg.reason === "compiler-message" && msg.message)
				.map((msg) => msg.message.rendered)
				.filter(Boolean);
			const warnOrError = own.some(
				(msg) =>
					msg.reason === "compiler-message" &&
					msg.message &&
					(msg.message.level === "warning" || msg.message.level === "error"),
			);
			if (exitCode !== 0 && diagnostics.length === 0) {
				// The shared run failed for a reason not attributed to this
				// crate — surface it rather than claiming a clean pass.
				return {
					result: {
						ok: false,
						output:
							stderr ||
							`cargo clippy --workspace failed before reaching ${input.dir}`,
					},
				};
			}
			if (warnOrError) {
				return { result: { ok: false, output: diagnostics.join("\n") } };
			}
			return { result: { ok: true, output: "" } };
		},
	});
}

// One shared `cargo test --no-run --workspace` build for a real workspace
// root, mirroring test/index.js's buildWorkspaceTestBinaries.
function workspaceTestBuildTask(
	workspaceRootRelative,
	manifestPath,
	manifests,
	toolchainSpec,
	deps,
) {
	const buildDir = `build/rust/${workspaceRootRelative === "." ? "root" : workspaceRootRelative}`;
	return task({
		display: `cargo test --no-run --workspace ${workspaceRootRelative}`,
		inputs: {
			manifests,
			...toolchainInputs(toolchainSpec),
			...extraInputs("dep", deps),
		},
		outputs: { binaries: output.artifact(), report: output.value() },
		async run(exec, input) {
			const { tools, env, rustflags } = await cargoEnv(
				exec,
				input,
				toolchainSpec,
			);
			const result = await exec.action({
				argv: [
					exec.tool(input.toolchain, "cargo"),
					"test",
					"--locked",
					"--no-run",
					"--workspace",
					"--message-format=json",
					"--manifest-path",
					manifestPath,
					"--target-dir",
					buildDir,
				],
				tools,
				env: [...env, `RUSTFLAGS=${rustflags}`],
				inputs: [input.manifests, ...resolvedExtraInputs("dep", input, deps)],
				outputs: { binaries: output.directory(buildDir) },
			});
			return {
				binaries: result.outputs.binaries,
				report: { stdout: result.stdout, buildDir },
			};
		},
	});
}

// Per-crate [TEST] root: filters the shared workspace test-build's compiled
// binaries down to this crate's own, then runs each one. `testTools`/`deps`/
// `testDeps` (see testToolsForDir/depsForDir/testDepsForDir above) are this
// one crate's own cargoPackage({testTools, deps, testDeps}) declarations,
// not the whole workspace's. Both `deps` and `testDeps` are materialized for
// the binary's own run, not just the compile step — a `deps` entry isn't
// necessarily baked in via include_str!/include_bytes!; e.g. imp-engine
// declares its own rules/ tree as `deps`, but its tests read it from disk at
// runtime, not compile time.
function crateTestTask(dir, testBuild, testTools, deps, testDeps) {
	return task({
		display: `cargo test ${dir}`,
		inputs: {
			binaries: testBuild.outputs.binaries,
			report: testBuild.outputs.report,
			dir,
			...extraInputs("dep", deps),
			...extraInputs("testDep", testDeps),
			...extraInputs("tool", testTools),
		},
		async run(exec, input) {
			const own = parseTestBinaries(
				input.report.stdout,
				input.report.buildDir,
			).filter(
				(bin) =>
					typeof bin.manifestPath !== "string" ||
					bin.manifestPath.includes(`/${input.dir}/`),
			);
			const binariesRoot = exec.path(input.binaries);
			const prefix = `${input.report.buildDir}/`;
			const depInputs = resolvedExtraInputs("dep", input, deps);
			const testDepInputs = resolvedExtraInputs("testDep", input, testDeps);
			const resolvedTestTools = resolvedExtraInputs("tool", input, testTools);
			for (const bin of own) {
				const relative = bin.executable.startsWith(prefix)
					? bin.executable.slice(prefix.length)
					: bin.executable;
				await exec.action({
					argv: [`${binariesRoot}/${relative}`, "--test-threads=1"],
					tools: resolvedTestTools,
					inputs: [input.binaries, ...depInputs, ...testDepInputs],
				});
			}
		},
	});
}

// One shared `cargo fmt --check` run for a real workspace root. `--all` is
// load-bearing, not cosmetic: the root manifest of a real Cargo workspace is
// virtual (a `[workspace]` table with no `[package]` of its own), and
// `cargo fmt` without `--all` tries to format just "the current crate" —
// confirmed directly against real cargo (1.93): it exits nonzero with
// "Failed to find targets" rather than falling back to every member. Reports
// one "Diff in <abs path> at line N:" header per unformatted file; anything
// else printed is diagnostic noise (e.g. a trailing summary), ignored the
// same way clippy's non-JSON stdout lines are.
function workspaceFmtTask(
	workspaceRootRelative,
	manifestPath,
	manifests,
	toolchainSpec,
) {
	return task({
		display: `cargo fmt --check --workspace ${workspaceRootRelative}`,
		inputs: { manifests, ...toolchainInputs(toolchainSpec) },
		outputs: { report: output.value() },
		async run(exec, input) {
			const { tools, env } = await cargoEnv(exec, input, toolchainSpec);
			const result = await exec.action({
				argv: [
					exec.tool(input.toolchain, "cargo"),
					"fmt",
					"--manifest-path",
					manifestPath,
					"--all",
					"--check",
				],
				tools,
				env,
				inputs: [input.manifests],
				allowFailure: true,
			});
			const unformatted = [
				...result.stdout.matchAll(/^Diff in (.+) at line \d+:/gm),
			].map((m) => m[1]);
			return {
				report: {
					exitCode: result.exitCode,
					unformatted,
					stdout: result.stdout,
				},
			};
		},
	});
}

// Per-crate [FMT] root: attributes the shared workspace fmt-check run's
// unformatted-file list back to this one crate by path substring, same
// attribution technique as crateLintTask.
function crateFmtTask(dir, fmt) {
	return task({
		display: `cargo fmt --check ${dir}`,
		inputs: { report: fmt.outputs.report, dir },
		async run(_exec, input) {
			const { exitCode, unformatted, stdout } = input.report;
			const own = unformatted.filter((p) => p.includes(`/${input.dir}/`));
			if (exitCode !== 0 && own.length === 0 && unformatted.length === 0) {
				// cargo fmt --check failed for a reason with no per-file
				// attribution at all (e.g. a syntax error) — surface it rather
				// than claiming a clean pass.
				throw new Error(
					stdout || `cargo fmt --check failed before reaching ${input.dir}`,
				);
			}
			if (own.length > 0) {
				throw new Error(`unformatted: ${own.join(", ")}`);
			}
		},
	});
}

// One shared `cargo test --doc --workspace --no-fail-fast` run for a real
// workspace root, mirroring the legacy runWorkspaceDocTests
// (rules/rust/index.js). `--no-fail-fast` is load-bearing, not cosmetic:
// without it, `cargo test --doc --workspace` stops at the first package
// whose doc-tests fail and never even attempts any package ordered after
// it — confirmed directly against real cargo, not assumed.
function workspaceDoctestTask(
	workspaceRootRelative,
	manifestPath,
	manifests,
	toolchainSpec,
	testTools,
	deps,
	testDeps,
) {
	const buildDir = `build/rust-doctest/${workspaceRootRelative === "." ? "root" : workspaceRootRelative}`;
	return task({
		display: `cargo test --doc --workspace ${workspaceRootRelative}`,
		inputs: {
			manifests,
			...toolchainInputs(toolchainSpec),
			...extraInputs("dep", deps),
			...extraInputs("testDep", testDeps),
			...extraInputs("tool", testTools),
		},
		outputs: { stderr: output.value() },
		async run(exec, input) {
			const { tools, env, rustflags } = await cargoEnv(
				exec,
				input,
				toolchainSpec,
			);
			const result = await exec.action({
				argv: [
					exec.tool(input.toolchain, "cargo"),
					"test",
					"--locked",
					"--doc",
					"--no-fail-fast",
					"--workspace",
					"--manifest-path",
					manifestPath,
					"--target-dir",
					buildDir,
				],
				tools: [...tools, ...resolvedExtraInputs("tool", input, testTools)],
				env: [...env, `RUSTFLAGS=${rustflags}`],
				inputs: [
					input.manifests,
					...resolvedExtraInputs("dep", input, deps),
					...resolvedExtraInputs("testDep", input, testDeps),
				],
				allowFailure: true,
			});
			return { stderr: result.stderr };
		},
	});
}

// Parses `cargo test --doc --workspace --no-fail-fast` stderr for per-crate
// attribution — see the legacy index.js's parseDocTestOutput for the
// full reasoning behind these two textual markers (doc-tests have no
// `--message-format=json` equivalent).
function parseDocTestOutput(stderr) {
	const attemptedLibNames = new Set(
		[...stderr.matchAll(/^\s*Doc-tests (\S+)\s*$/gm)].map((m) => m[1]),
	);
	const failedPackageNames = new Set(
		[...stderr.matchAll(/`-p (\S+) --doc`/g)].map((m) => m[1]),
	);
	return { attemptedLibNames, failedPackageNames };
}

function libNameFor(pkg) {
	const libTarget = (pkg.targets || []).find((t) =>
		(t.kind || []).some((k) => k === "lib" || k === "proc-macro"),
	);
	return libTarget ? libTarget.name : null;
}

// Per-crate TEST facet's `doctests` sub-facet: attributes the shared
// workspace doc-test run back to this one crate by package/lib name (see
// parseDocTestOutput above). A bin-only package (no lib/proc-macro target)
// has no doc-tests and is silently skipped by `--workspace` — this returns
// cleanly rather than erroring.
function crateDoctestTask(pkg, doctest) {
	return task({
		display: `cargo test --doc ${pkg.name}`,
		inputs: {
			stderr: doctest.outputs.stderr,
			packageName: pkg.name,
			libName: libNameFor(pkg),
		},
		async run(_exec, input) {
			if (!input.libName) return;
			const { attemptedLibNames, failedPackageNames } = parseDocTestOutput(
				input.stderr,
			);
			if (failedPackageNames.has(input.packageName)) {
				throw new Error(`doc-tests failed for ${input.packageName}`);
			}
			if (!attemptedLibNames.has(input.libName)) {
				throw new Error(
					`doc-tests for ${input.packageName} were never reached — likely a ` +
						"compile error elsewhere in the shared workspace run",
				);
			}
		},
	});
}

/**
 * One expand() per real Cargo workspace root, keyed by crate name — the
 * first multi-key expand() in this repo (rules/odin's is single-key). Every
 * workspace member's [LINT]/[TEST] root shares one workspace-wide cargo
 * clippy/test-build run; expansion.get(crateName, workflow) resolves one
 * crate's own attributed result, expansion.all(workflow) resolves every
 * member's.
 *
 * @param {string} workspaceRootRelative Workspace-relative root directory
 *   (as returned by workspace_closure.js's workspaceRootRelativeFor()), "."
 *   for the repo root itself.
 * @param {object} toolchainSpec `{toolchain, legacyToolchainHandle,
 *   linkerHandles}` — see //rules/rust's cargoPackage(), which builds this
 *   bridge.
 */
export function cargoWorkspaceExpansion(workspaceRootRelative, toolchainSpec) {
	const prefix =
		workspaceRootRelative === "." ? "" : `${workspaceRootRelative}/`;
	const manifestPath = `${prefix}Cargo.toml`;
	const manifests = manifestSources(workspaceRootRelative);

	const metadata = metadataTask(
		`cargo metadata (workspace) ${workspaceRootRelative}`,
		manifestPath,
		manifests,
		toolchainSpec,
	);

	return expand({
		display: `expand cargo workspace ${workspaceRootRelative}`,
		inputs: {
			metadata: metadata.outputs.metadata,
			manifests,
			...toolchainInputs(toolchainSpec),
		},
		// create() receives resolved bindings, not handles — manifests/toolchain
		// are read from the enclosing closure (the original handles) instead,
		// so the per-crate tasks below register real task() inputs rather than
		// treating an already-resolved binding as opaque literal JSON (which
		// would deep-freeze its nested fileset and break a second, sibling
		// task's materialization of the same files() source set).
		create({ metadata }) {
			const byId = new Map(
				(metadata.packages || []).map((pkg) => [pkg.id, pkg]),
			);
			const members = (metadata.workspace_members || [])
				.map((id) => byId.get(id))
				.filter(Boolean)
				.map((pkg) => ({
					pkg,
					dir: manifestDirRelativeTo(
						pkg.manifest_path,
						metadata.workspace_root,
					),
				}));
			const memberDirs = members.map((m) => m.dir);
			const deps = depsForDirs(memberDirs);
			const testDeps = testDepsForDirs(memberDirs);

			const clippy = workspaceClippyTask(
				workspaceRootRelative,
				manifestPath,
				manifests,
				toolchainSpec,
				deps,
			);
			const testBuild = workspaceTestBuildTask(
				workspaceRootRelative,
				manifestPath,
				manifests,
				toolchainSpec,
				deps,
			);
			const fmt = workspaceFmtTask(
				workspaceRootRelative,
				manifestPath,
				manifests,
				toolchainSpec,
			);

			const doctest = doctestEnabled()
				? workspaceDoctestTask(
						workspaceRootRelative,
						manifestPath,
						manifests,
						toolchainSpec,
						testToolsForDirs(memberDirs),
						deps,
						testDeps,
					)
				: null;

			const children = {};
			for (const { pkg, dir } of members) {
				children[pkg.name] = {
					[LINT]: crateLintTask(workspaceRootRelative, dir, clippy).outputs
						.result,
					[TEST]: {
						unit: crateTestTask(
							dir,
							testBuild,
							testToolsForDir(dir),
							depsForDir(dir),
							testDepsForDir(dir),
						),
						doctests: doctest
							? crateDoctestTask(pkg, doctest)
							: noopDoctestTask(`cargo test --doc ${pkg.name} (disabled)`),
					},
					[FMT]: crateFmtTask(dir, fmt),
				};
			}
			return children;
		},
	});
}

// Standalone (non-workspaceMember) crate: same shape, but a single-key
// expand() — no `--workspace` flag, no demux, since there's only one crate.
// Routes through expand() for uniformity with cargoWorkspaceExpansion()
// rather than a structurally different code path, matching rules/odin's
// precedent of always going through expand().
export function cargoStandaloneExpansion(path, toolchainSpec) {
	const manifestPath = `${path}/Cargo.toml`;
	const manifests = manifestSources(path);

	const metadata = metadataTask(
		`cargo metadata ${path}`,
		manifestPath,
		manifests,
		toolchainSpec,
	);

	return expand({
		display: `expand standalone crate ${path}`,
		inputs: {
			metadata: metadata.outputs.metadata,
			manifests,
			...toolchainInputs(toolchainSpec),
		},
		// See cargoWorkspaceExpansion()'s create() comment: manifests/toolchain
		// are the enclosing closure's original handles, not the resolved
		// bindings create() receives.
		create() {
			const deps = depsForDir(path);
			const testDeps = testDepsForDir(path);

			const clippy = task({
				display: `cargo clippy ${path}`,
				inputs: {
					manifests,
					...toolchainInputs(toolchainSpec),
					...extraInputs("dep", deps),
				},
				outputs: { report: output.value() },
				async run(exec, input) {
					const { tools, env, rustflags } = await cargoEnv(
						exec,
						input,
						toolchainSpec,
					);
					const result = await exec.action({
						argv: [
							exec.tool(input.toolchain, "cargo"),
							"clippy",
							"--locked",
							"--manifest-path",
							manifestPath,
							"--no-deps",
							"--color=always",
							"--",
							"-D",
							"warnings",
						],
						tools,
						env: [...env, `RUSTFLAGS=${rustflags}`],
						inputs: [
							input.manifests,
							...resolvedExtraInputs("dep", input, deps),
						],
						allowFailure: true,
					});
					return {
						report: {
							ok: result.exitCode === 0,
							output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
						},
					};
				},
			});

			const testBuild = task({
				display: `cargo test --no-run ${path}`,
				inputs: {
					manifests,
					...toolchainInputs(toolchainSpec),
					...extraInputs("dep", deps),
				},
				outputs: { binaries: output.artifact(), report: output.value() },
				async run(exec, input) {
					const { tools, env, rustflags } = await cargoEnv(
						exec,
						input,
						toolchainSpec,
					);
					const buildDir = `build/rust/${path}`;
					const result = await exec.action({
						argv: [
							exec.tool(input.toolchain, "cargo"),
							"test",
							"--locked",
							"--no-run",
							"--message-format=json",
							"--manifest-path",
							manifestPath,
							"--target-dir",
							buildDir,
						],
						tools,
						env: [...env, `RUSTFLAGS=${rustflags}`],
						inputs: [
							input.manifests,
							...resolvedExtraInputs("dep", input, deps),
						],
						outputs: { binaries: output.directory(buildDir) },
					});
					return {
						binaries: result.outputs.binaries,
						report: { stdout: result.stdout, buildDir },
					};
				},
			});

			const fmt = task({
				display: `cargo fmt --check ${path}`,
				inputs: { manifests, ...toolchainInputs(toolchainSpec) },
				async run(exec, input) {
					const { tools, env } = await cargoEnv(exec, input, toolchainSpec);
					const result = await exec.action({
						argv: [
							exec.tool(input.toolchain, "cargo"),
							"fmt",
							"--manifest-path",
							manifestPath,
							"--all",
							"--check",
						],
						tools,
						env,
						inputs: [input.manifests],
					});
					if (result.exitCode !== 0) throw new Error(result.stdout);
				},
			});

			// No workspace-wide run to share/attribute against, so this is a
			// plain per-crate `cargo test --doc` invocation. A bin-only crate
			// (no `[lib]` target) has no doc-tests by definition, but `cargo
			// test --doc` still hard-errors on it ("no library targets found
			// in package ...", exit 101) instead of just finding zero
			// doc-tests — so that specific message is treated as a benign
			// no-op, same as the legacy standalone cargoTest.
			const doctest = doctestEnabled()
				? task({
						display: `cargo test --doc ${path}`,
						inputs: {
							manifests,
							...toolchainInputs(toolchainSpec),
							...extraInputs("dep", deps),
							...extraInputs("testDep", testDeps),
							...extraInputs("tool", testToolsForDir(path)),
						},
						async run(exec, input) {
							const { tools, env, rustflags } = await cargoEnv(
								exec,
								input,
								toolchainSpec,
							);
							const result = await exec.action({
								argv: [
									exec.tool(input.toolchain, "cargo"),
									"test",
									"--locked",
									"--doc",
									"--manifest-path",
									manifestPath,
								],
								tools: [
									...tools,
									...resolvedExtraInputs("tool", input, testToolsForDir(path)),
								],
								env: [...env, `RUSTFLAGS=${rustflags}`],
								inputs: [
									input.manifests,
									...resolvedExtraInputs("dep", input, deps),
									...resolvedExtraInputs("testDep", input, testDeps),
								],
								allowFailure: true,
							});
							const benign =
								result.exitCode === 0 ||
								result.stdout.includes("no library targets found") ||
								result.stderr.includes("no library targets found");
							if (!benign) {
								throw new Error(
									[result.stdout, result.stderr].filter(Boolean).join("\n"),
								);
							}
						},
					})
				: noopDoctestTask(`cargo test --doc ${path} (disabled)`);

			return {
				[path]: {
					[LINT]: task({
						display: `cargo clippy ${path} (attribute)`,
						inputs: { report: clippy.outputs.report },
						outputs: { result: output.value() },
						async run(_exec, input) {
							return { result: input.report };
						},
					}).outputs.result,
					[TEST]: {
						unit: task({
							display: `cargo test ${path}`,
							inputs: {
								binaries: testBuild.outputs.binaries,
								report: testBuild.outputs.report,
								...extraInputs("dep", deps),
								...extraInputs("testDep", testDeps),
								...extraInputs("tool", testToolsForDir(path)),
							},
							async run(exec, input) {
								const binaries = parseTestBinaries(
									input.report.stdout,
									input.report.buildDir,
								);
								const binariesRoot = exec.path(input.binaries);
								const prefix = `${input.report.buildDir}/`;
								const depInputs = resolvedExtraInputs("dep", input, deps);
								const testDepInputs = resolvedExtraInputs(
									"testDep",
									input,
									testDeps,
								);
								const resolvedTestTools = resolvedExtraInputs(
									"tool",
									input,
									testToolsForDir(path),
								);
								for (const bin of binaries) {
									const relative = bin.executable.startsWith(prefix)
										? bin.executable.slice(prefix.length)
										: bin.executable;
									await exec.action({
										argv: [`${binariesRoot}/${relative}`, "--test-threads=1"],
										tools: resolvedTestTools,
										inputs: [input.binaries, ...depInputs, ...testDepInputs],
									});
								}
							},
						}),
						doctests: doctest,
					},
					[FMT]: fmt,
				},
			};
		},
	});
}
