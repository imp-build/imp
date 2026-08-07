// Graph-native counterpart to workspace_closure.js's expansion-facing role:
// turns one real Cargo workspace's `cargo metadata` output into a keyed
// expand(), one child per crate name. workspace_closure.js itself is
// untouched — its pure graph-walk helpers and legacy memo()/run()-based
// metadata fetch stay in place for the still-legacy rules/rust/index.js,
// lint.js, fmt.js, and test/index.js. Both this file's new package.js
// consumer (graph-native, additive) and the legacy label-based factory
// coexist until the migration's cutover PR flips crates/*/BUILD.js and
// deletes the legacy code in one shot (see the migration plan's PR 4) — a
// real single-shot swap of `cargoPackage()`'s export shape can't land
// piecemeal, since every real crates/*/BUILD.js consumer would break the
// moment the shape changed out from under it.
//
// A single `cargo clippy --workspace`/`cargo test --no-run --workspace`/
// `cargo fmt --check`/`cargo test --doc --workspace` run is shared by every
// workspace member's corresponding root instead of one cargo invocation per
// crate — same reasoning as the legacy runWorkspaceClippy/
// buildWorkspaceTestBinaries/runWorkspaceDocTests (rules/rust/lint.js,
// test/index.js, index.js): most crates' own dependency closures already
// cover most of a typical workspace, so per-crate scoping bought little
// isolation in practice. Each per-crate root locally filters/attributes the
// shared run's output by path substring instead of invoking cargo itself.

import { FMT, LINT, TEST, expand, file, files, output, task } from "imp:core";

import { parseTestBinaries } from "//rules/rust/test";

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

function metadataTask(display, manifest, manifests, toolchain, extraArgs = []) {
	return task({
		display,
		inputs: { manifest, manifests, toolchain },
		outputs: { metadata: output.value() },
		async run(exec, input) {
			const result = await exec.action({
				argv: [
					exec.tool(input.toolchain, "cargo"),
					"metadata",
					"--locked",
					"--no-deps",
					"--format-version=1",
					"--manifest-path",
					exec.path(input.manifest),
					...extraArgs,
				],
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
	manifest,
	manifests,
	toolchain,
) {
	return task({
		display: `cargo clippy --workspace ${workspaceRootRelative}`,
		inputs: { manifest, manifests, toolchain },
		outputs: { report: output.value() },
		async run(exec, input) {
			const result = await exec.action({
				argv: [
					exec.tool(input.toolchain, "cargo"),
					"clippy",
					"--locked",
					"--workspace",
					"--message-format=json",
					"--manifest-path",
					exec.path(input.manifest),
					"--color=always",
				],
				inputs: [input.manifests],
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
// lint.js's cargoClippy(). No outputs — a thrown error is the failure signal.
function crateLintTask(workspaceRootRelative, dir, clippy) {
	return task({
		display: `cargo clippy ${dir}`,
		inputs: { report: clippy.outputs.report, dir },
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
				throw new Error(
					stderr ||
						`cargo clippy --workspace failed before reaching ${input.dir}`,
				);
			}
			if (warnOrError) throw new Error(diagnostics.join("\n"));
		},
	});
}

// One shared `cargo test --no-run --workspace` build for a real workspace
// root, mirroring test/index.js's buildWorkspaceTestBinaries.
function workspaceTestBuildTask(
	workspaceRootRelative,
	manifest,
	manifests,
	toolchain,
) {
	const buildDir = `build/rust/${workspaceRootRelative === "." ? "root" : workspaceRootRelative}`;
	return task({
		display: `cargo test --no-run --workspace ${workspaceRootRelative}`,
		inputs: { manifest, manifests, toolchain },
		outputs: { binaries: output.artifact(), report: output.value() },
		async run(exec, input) {
			const result = await exec.action({
				argv: [
					exec.tool(input.toolchain, "cargo"),
					"test",
					"--locked",
					"--no-run",
					"--workspace",
					"--message-format=json",
					"--manifest-path",
					exec.path(input.manifest),
					"--target-dir",
					buildDir,
				],
				inputs: [input.manifests],
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
// binaries down to this crate's own, then runs each one.
function crateTestTask(dir, testBuild) {
	return task({
		display: `cargo test ${dir}`,
		inputs: {
			binaries: testBuild.outputs.binaries,
			report: testBuild.outputs.report,
			dir,
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
			for (const bin of own) {
				const relative = bin.executable.startsWith(prefix)
					? bin.executable.slice(prefix.length)
					: bin.executable;
				await exec.action({
					argv: [`${binariesRoot}/${relative}`, "--test-threads=1"],
					inputs: [input.binaries],
				});
			}
		},
	});
}

// One shared `cargo fmt --check` run for a real workspace root — cargo fmt
// itself already covers every workspace member from the root manifest, no
// `--workspace` flag needed. Reports one "Diff in <abs path> at line N:"
// header per unformatted file; anything else printed is diagnostic noise
// (e.g. a trailing summary), ignored the same way clippy's non-JSON stdout
// lines are.
function workspaceFmtTask(
	workspaceRootRelative,
	manifest,
	manifests,
	toolchain,
) {
	return task({
		display: `cargo fmt --check --workspace ${workspaceRootRelative}`,
		inputs: { manifest, manifests, toolchain },
		outputs: { report: output.value() },
		async run(exec, input) {
			const result = await exec.action({
				argv: [
					exec.tool(input.toolchain, "cargo"),
					"fmt",
					"--manifest-path",
					exec.path(input.manifest),
					"--check",
				],
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
	manifest,
	manifests,
	toolchain,
) {
	const buildDir = `build/rust-doctest/${workspaceRootRelative === "." ? "root" : workspaceRootRelative}`;
	return task({
		display: `cargo test --doc --workspace ${workspaceRootRelative}`,
		inputs: { manifest, manifests, toolchain },
		outputs: { stderr: output.value() },
		async run(exec, input) {
			const result = await exec.action({
				argv: [
					exec.tool(input.toolchain, "cargo"),
					"test",
					"--locked",
					"--doc",
					"--no-fail-fast",
					"--workspace",
					"--manifest-path",
					exec.path(input.manifest),
					"--target-dir",
					buildDir,
				],
				inputs: [input.manifests],
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
 * @param {object} toolchain A tool()-wrapped rust/cargo handle.
 */
export function cargoWorkspaceExpansion(workspaceRootRelative, toolchain) {
	const prefix =
		workspaceRootRelative === "." ? "" : `${workspaceRootRelative}/`;
	const manifest = file(`${prefix}Cargo.toml`);
	const manifests = manifestSources(workspaceRootRelative);

	const metadata = metadataTask(
		`cargo metadata (workspace) ${workspaceRootRelative}`,
		manifest,
		manifests,
		toolchain,
	);

	return expand({
		display: `expand cargo workspace ${workspaceRootRelative}`,
		inputs: {
			metadata: metadata.outputs.metadata,
			manifest,
			manifests,
			toolchain,
		},
		// create() receives resolved bindings, not handles — manifest/manifests/
		// toolchain are read from the enclosing closure (the original handles)
		// instead, so the per-crate tasks below register real task() inputs
		// rather than treating an already-resolved binding as opaque literal
		// JSON (which would deep-freeze its nested fileset and break a second,
		// sibling task's materialization of the same files() source set).
		create({ metadata }) {
			const clippy = workspaceClippyTask(
				workspaceRootRelative,
				manifest,
				manifests,
				toolchain,
			);
			const testBuild = workspaceTestBuildTask(
				workspaceRootRelative,
				manifest,
				manifests,
				toolchain,
			);
			const fmt = workspaceFmtTask(
				workspaceRootRelative,
				manifest,
				manifests,
				toolchain,
			);
			const doctest = workspaceDoctestTask(
				workspaceRootRelative,
				manifest,
				manifests,
				toolchain,
			);

			const byId = new Map(
				(metadata.packages || []).map((pkg) => [pkg.id, pkg]),
			);
			const children = {};
			for (const id of metadata.workspace_members || []) {
				const pkg = byId.get(id);
				if (!pkg) continue;
				const dir = manifestDirRelativeTo(
					pkg.manifest_path,
					metadata.workspace_root,
				);
				children[pkg.name] = {
					[LINT]: crateLintTask(workspaceRootRelative, dir, clippy),
					[TEST]: {
						unit: crateTestTask(dir, testBuild),
						doctests: crateDoctestTask(pkg, doctest),
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
export function cargoStandaloneExpansion(path, toolchain) {
	const manifest = file(`${path}/Cargo.toml`);
	const manifests = manifestSources(path);

	const metadata = metadataTask(
		`cargo metadata ${path}`,
		manifest,
		manifests,
		toolchain,
	);

	return expand({
		display: `expand standalone crate ${path}`,
		inputs: {
			metadata: metadata.outputs.metadata,
			manifest,
			manifests,
			toolchain,
		},
		// See cargoWorkspaceExpansion()'s create() comment: manifest/manifests/
		// toolchain are the enclosing closure's original handles, not the
		// resolved bindings create() receives.
		create() {
			const clippy = task({
				display: `cargo clippy ${path}`,
				inputs: { manifest, manifests, toolchain },
				outputs: { report: output.value() },
				async run(exec, input) {
					const result = await exec.action({
						argv: [
							exec.tool(input.toolchain, "cargo"),
							"clippy",
							"--locked",
							"--manifest-path",
							exec.path(input.manifest),
							"--no-deps",
							"--color=always",
							"--",
							"-D",
							"warnings",
						],
						inputs: [input.manifests],
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
				inputs: { manifest, manifests, toolchain },
				outputs: { binaries: output.artifact(), report: output.value() },
				async run(exec, input) {
					const buildDir = `build/rust/${path}`;
					const result = await exec.action({
						argv: [
							exec.tool(input.toolchain, "cargo"),
							"test",
							"--locked",
							"--no-run",
							"--message-format=json",
							"--manifest-path",
							exec.path(input.manifest),
							"--target-dir",
							buildDir,
						],
						inputs: [input.manifests],
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
				inputs: { manifest, manifests, toolchain },
				async run(exec, input) {
					const result = await exec.action({
						argv: [
							exec.tool(input.toolchain, "cargo"),
							"fmt",
							"--manifest-path",
							exec.path(input.manifest),
							"--check",
						],
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
			const doctest = task({
				display: `cargo test --doc ${path}`,
				inputs: { manifest, manifests, toolchain },
				async run(exec, input) {
					const result = await exec.action({
						argv: [
							exec.tool(input.toolchain, "cargo"),
							"test",
							"--locked",
							"--doc",
							"--manifest-path",
							exec.path(input.manifest),
						],
						inputs: [input.manifests],
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
			});

			return {
				[path]: {
					[LINT]: task({
						display: `cargo clippy ${path} (attribute)`,
						inputs: { report: clippy.outputs.report },
						async run(_exec, input) {
							if (!input.report.ok) throw new Error(input.report.output);
						},
					}),
					[TEST]: {
						unit: task({
							display: `cargo test ${path}`,
							inputs: {
								binaries: testBuild.outputs.binaries,
								report: testBuild.outputs.report,
							},
							async run(exec, input) {
								const binaries = parseTestBinaries(
									input.report.stdout,
									input.report.buildDir,
								);
								const binariesRoot = exec.path(input.binaries);
								const prefix = `${input.report.buildDir}/`;
								for (const bin of binaries) {
									const relative = bin.executable.startsWith(prefix)
										? bin.executable.slice(prefix.length)
										: bin.executable;
									await exec.action({
										argv: [`${binariesRoot}/${relative}`, "--test-threads=1"],
										inputs: [input.binaries],
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
