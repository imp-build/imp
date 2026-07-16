import {
	describe,
	expect,
	test,
	withFakeRun,
	withFakeWriteWorkspace,
} from "//rules/imp/test";
import {
	odinPackage,
	odinTestPackage,
	odinToolchain,
	own_sources,
	sources,
	imports,
	odinPackageAnalysis,
	inferred_deps,
	effective_deps,
	collection_flags,
	collection_dirs,
	resources as odinResources,
	generateBuild,
	tool,
	odinBuild,
	odinTest,
	odinRun,
	odinLint,
	default_output_path,
	odin_output_path,
	OdinPackage,
} from "//rules/odin";
import { resourcePackage } from "//rules/asset";
import { gccToolchain } from "//rules/c/gcc/toolchain";
import { moldToolchain } from "//rules/c/mold/toolchain";

// odinBuild/odinTest's build/link path always needs a declared default gcc
// toolchain (see odinScriptTools() in //rules/odin) — declare it once, up
// front, for every test in this file that actually exercises that path (via
// withFakeRun, which only stubs run()'s execution, not the tool-resolution
// code that runs before it). mold is opt-in (not required) — declared here
// only so tests below can exercise odinToolchain({ linker: mold }).
gccToolchain("2025.08-1", { default: true, unverified: true });
const moldForTests = moldToolchain("2.41.0", { unverified: true });
import {
	target,
	hydrateTarget,
	gatherTransitiveClosure,
	glob,
	paths,
	getMemoTrace,
	configure,
	pathsInDigest,
} from "imp:core";

// A run() input FileSet gets collapsed into an opaque {kind:"digest", digest}
// entry (merge_digests, commit 827bd09) rather than one {kind:"file", path}
// entry per matched file, so "was this path fed into the sandbox" has to walk
// the digest's contents instead of comparing a bare `.path` field.
function inputsIncludePath(inputs, path) {
	return inputs.some(
		(input) =>
			input.kind === "digest" && pathsInDigest(input.digest).includes(path),
	);
}

describe("Odin rules", () => {
	test("uses the default Odin toolchain target", () => {
		const toolchain = odinToolchain("dev-2026-03", { default: true });
		const pkg = odinPackage({ srcs: ["**/*.odin"] });

		expect(pkg.attrs.toolchain).toBe(toolchain);
		expect(pkg.attrs.toolchain.attrs.version).toBe("dev-2026-03");
	});

	test("keeps explicit string versions free of toolchain target deps", () => {
		const pkg = odinPackage({ srcs: ["**/*.odin"], toolchain: "dev-2026-04" });

		expect(pkg.attrs.toolchainVersion).toBe("dev-2026-04");
		expect(pkg.attrs.toolchain).toBe(undefined);
	});

	test("packages depend on collection config without collection membership", () => {
		const pkg = odinPackage({
			srcs: ["**/*.odin"],
			toolchain: "dev-2026-04",
			collections: [
				{ name: "root", path: "." },
				{ name: "lib", path: "library" },
			],
		});

		expect((pkg.attrs.collections || []).length).toBe(2);
	});

	test("hydrateTarget returns kind, attrs, and dep handles", () => {
		const pkg = odinPackage({
			srcs: ["rules/odin/index.js"],
			toolchain: "dev-2026-04",
		});
		const hydrated = hydrateTarget(pkg);

		expect(hydrated.kind).toBe("odin-package");
		expect(Array.isArray(hydrated.attrs.srcs)).toBeTruthy();
		expect(Array.isArray(hydrated.deps)).toBeTruthy();
	});

	test("gatherTransitiveClosure finds all odin-package targets", () => {
		const lib = odinPackage({
			srcs: ["rules/odin/index.js"],
			toolchain: "dev-2026-04",
		});
		const app = odinPackage({
			srcs: ["rules/odin/index_test.js"],
			toolchain: "dev-2026-04",
			deps: [lib],
		});
		const closure = gatherTransitiveClosure(app, OdinPackage);

		expect(closure.length).toBe(2);
	});

	test("own_sources(pkg) returns a FileSet descriptor", async () => {
		const pkg = odinPackage({ srcs: ["**/*.odin"], toolchain: "dev-2026-04" });
		const fs = await own_sources(pkg);
		expect(fs.__fileset).toBe(true);
		expect(fs.kind).toBe("glob");
	});

	test("own_sources defaults missing srcs for odin-package targets", async () => {
		const pkg = target({
			kind: "odin-package",
			attrs: { path: "rules/odin/example", toolchainVersion: "dev-2026-04" },
		});
		const result = paths(await own_sources(pkg));
		expect(result).toContain("rules/odin/example/main.odin");
	});

	test("odinPackage treats empty srcs as the default package sources", async () => {
		const pkg = odinPackage({
			path: "rules/odin/example",
			srcs: [],
			toolchain: "dev-2026-04",
		});
		const result = paths(await own_sources(pkg));
		expect(result).toContain("rules/odin/example/main.odin");
	});

	test("sources(pkg) with no deps returns a FileSet", async () => {
		const pkg = odinPackage({ srcs: ["**/*.odin"], toolchain: "dev-2026-04" });
		const fs = await sources(pkg);
		expect(fs.__fileset).toBe(true);
	});

	test("imports(pkg) scans Odin import declarations", async () => {
		const pkg = odinPackage({
			path: "rules/odin/example",
			toolchain: "dev-2026-04",
		});
		const result = await imports(pkg);
		expect(result).toContain("core:fmt");
	});

	test("odinPackageAnalysis(pkg) reports imports, collections, and main entrypoint", async () => {
		const pkg = odinPackage({
			path: "rules/odin/example",
			toolchain: "dev-2026-04",
		});
		const analysis = await odinPackageAnalysis(pkg);
		expect(analysis.sourceFiles).toContain("rules/odin/example/main.odin");
		expect(analysis.packagePath).toBe("rules/odin/example");
		expect(analysis.imports).toContain("core:fmt");
		expect(analysis.collections).toContain("core");
		expect(analysis.hasMainEntrypoint).toBe(true);
	});

	test("sources(app) with a dep includes transitive files", async () => {
		const lib = odinPackage({
			srcs: ["rules/odin/index.js"],
			toolchain: "dev-2026-04",
		});
		const app = odinPackage({
			srcs: ["rules/odin/index_test.js"],
			toolchain: "dev-2026-04",
			deps: [lib],
		});
		const result = paths(await sources(app));
		expect(result).toContain("rules/odin/index.js");
		expect(result).toContain("rules/odin/index_test.js");
	});

	test("resources(app) with a resource dep includes resource files", async () => {
		const fonts = resourcePackage({
			path: "rules/odin",
			srcs: ["toolchain.js"],
		});
		const app = odinPackage({
			srcs: ["rules/odin/index.js"],
			toolchain: "dev-2026-04",
			deps: [fonts],
		});
		// resources() returns a list of run()-inputs entries (FileSets and/or
		// {kind:"digest"} objects) rather than a single FileSet, so flatten the
		// FileSet entries' own paths() to check for the expected file.
		const result = (await odinResources(app)).flatMap(paths);
		expect(result).toContain("rules/odin/toolchain.js");
	});

	test("sources(app) does not include resource package files", async () => {
		const fonts = resourcePackage({
			path: "rules/odin",
			srcs: ["toolchain.js"],
		});
		const app = odinPackage({
			srcs: ["rules/odin/index.js"],
			toolchain: "dev-2026-04",
			deps: [fonts],
		});
		const result = paths(await sources(app));
		expect(result).not.toContain("rules/odin/toolchain.js");
	});

	test("resources(app) includes resource deps from transitive Odin deps", async () => {
		const fonts = resourcePackage({
			path: "rules/odin",
			srcs: ["toolchain.js"],
		});
		const lib = odinPackage({
			srcs: ["rules/odin/index.js"],
			toolchain: "dev-2026-04",
			deps: [fonts],
		});
		const app = odinPackage({
			srcs: ["rules/odin/index_test.js"],
			toolchain: "dev-2026-04",
			deps: [lib],
		});
		const result = (await odinResources(app)).flatMap(paths);
		expect(result).toContain("rules/odin/toolchain.js");
	});

	test("odinBuild declares resource package files as sandbox inputs", async () => {
		await withFakeRun(async () => {
			const fonts = resourcePackage({
				path: "rules/odin",
				srcs: ["toolchain.js"],
			});
			const app = odinPackage({
				srcs: ["rules/odin/index.js"],
				toolchain: "dev-2026-04",
				output: "build/odin/target",
				deps: [fonts],
			});
			await odinBuild(app);
			const { trace } = getMemoTrace();
			const runEffect = trace.find(
				(t) =>
					t.event === "effect" &&
					t.kind === "run" &&
					t.display === "odin build rules/odin",
			);
			expect(
				inputsIncludePath(runEffect.inputs, "rules/odin/toolchain.js"),
			).toBe(true);
		});
	});

	test("repeated sources() calls are memoized", async () => {
		const pkg = odinPackage({ srcs: ["**/*.odin"], toolchain: "dev-2026-04" });
		const a = await sources(pkg);
		const b = await sources(pkg);
		expect(a).toBe(b);
	});

	test("tool is exported as a function", () => {
		expect(typeof tool).toBe("function");
	});

	test("odinBuild product is exported as a function", () => {
		expect(typeof odinBuild).toBe("function");
	});

	test("odinTest product is exported as a function", () => {
		expect(typeof odinTest).toBe("function");
	});

	test("dependency inference helpers are exported as functions", () => {
		expect(typeof inferred_deps).toBe("function");
		expect(typeof effective_deps).toBe("function");
	});

	test("generateBuild product is exported as a function", () => {
		expect(typeof generateBuild).toBe("function");
	});

	test("collection_flags(pkg) returns flags for all collection deps", async () => {
		configure("odin", null);
		const pkg = odinPackage({
			srcs: ["**/*.odin"],
			toolchain: "dev-2026-04",
			collections: [
				{ name: "root", path: "." },
				{ name: "lib", path: "library" },
			],
		});
		const flags = await collection_flags(pkg);
		expect(flags).toEqual(["-collection:root=.", "-collection:lib=library"]);
	});

	test("collection_flags(pkg) reads workspace Odin collection config", async () => {
		configure("odin", null);
		configure("odin", {
			collections: {
				root: ".",
				lib: "library",
			},
		});
		const pkg = odinPackage({ srcs: ["**/*.odin"], toolchain: "dev-2026-04" });
		const flags = await collection_flags(pkg);
		// Workspace config round-trips through serde_json, whose objects sort keys,
		// so config-derived collections come out alphabetically (lib before root).
		expect(flags).toEqual(["-collection:lib=library", "-collection:root=."]);
	});

	test("package collections extend workspace Odin collection config", async () => {
		configure("odin", null);
		configure("odin", { collections: { lib: "library" } });
		const pkg = odinPackage({
			srcs: ["**/*.odin"],
			toolchain: "dev-2026-04",
			collections: { vendor: "vendor/odin" },
		});
		const flags = await collection_flags(pkg);
		expect(flags).toEqual([
			"-collection:lib=library",
			"-collection:vendor=vendor/odin",
		]);
	});

	test("collection_dirs(pkg) returns non-root collection directories once", async () => {
		configure("odin", null);
		configure("odin", {
			collections: {
				root: ".",
				lib: "library",
				libAlias: { path: "library" },
			},
		});
		const pkg = odinPackage({ srcs: ["**/*.odin"], toolchain: "dev-2026-04" });
		const dirs = await collection_dirs(pkg);
		expect(dirs).toEqual(["library"]);
	});

	test("odinBuild materializes collection directories before invoking Odin", async () => {
		configure("odin", null);
		configure("odin", { collections: { root: ".", lib: "library" } });
		try {
			await withFakeRun(async () => {
				const app = odinPackage({
					srcs: ["rules/odin/index.js"],
					toolchain: "dev-2026-04",
					output: "build/odin/target",
				});
				await odinBuild(app);
				const { trace } = getMemoTrace();
				const runEffect = trace.find(
					(t) =>
						t.event === "effect" &&
						t.kind === "run" &&
						t.display === "odin build rules/odin",
				);
				expect(runEffect.argv[6]).toBe("1");
				expect(runEffect.argv[7]).toBe("library");
				// Config-derived collection flags are alphabetical (lib before root).
				expect(runEffect.argv[8]).toBe("-collection:lib=library");
				expect(runEffect.argv).toContain("-collection:root=.");
				expect(
					runEffect.inputs.some((input) => input.kind === "directory"),
				).toBe(false);
			});
		} finally {
			configure("odin", null);
		}
	});

	test("odinBuild uses library build mode when package has no main entrypoint", async () => {
		configure("odin", null);
		try {
			await withFakeRun(async () => {
				const lib = odinPackage({
					srcs: ["rules/odin/index.js"],
					toolchain: "dev-2026-04",
					output: "build/odin/target",
				});
				await odinBuild(lib);
				const { trace } = getMemoTrace();
				const runEffect = trace.find(
					(t) =>
						t.event === "effect" &&
						t.kind === "run" &&
						t.display === "odin build rules/odin",
				);
				expect(runEffect.argv).toContain("-build-mode:lib");
				expect(runEffect.outputs).toEqual([
					{ kind: "file", path: "build/odin/target.a" },
					{ kind: "directory", path: "build/odin" },
				]);
			});
		} finally {
			configure("odin", null);
		}
	});

	test("default_output_path(handle) derives build/odin/<name> from the handle's label", () => {
		const fakeHandle = { label: { name: "hello" } };
		expect(default_output_path(fakeHandle)).toBe("build/odin/hello");
	});

	test("odin_output_path appends .a for library build mode, leaves binaries alone", () => {
		expect(
			odin_output_path("build/odin/target", { hasMainEntrypoint: true }),
		).toBe("build/odin/target");
		expect(
			odin_output_path("build/odin/target", { hasMainEntrypoint: false }),
		).toBe("build/odin/target.a");
	});

	test("odinBuild's return value is enriched with outputPath", async () => {
		configure("odin", null);
		try {
			await withFakeRun(async () => {
				const lib = odinPackage({
					srcs: ["rules/odin/index.js"],
					toolchain: "dev-2026-04",
					output: "build/odin/target",
				});
				const result = await odinBuild(lib);
				expect(result.outputPath).toBe("build/odin/target.a");
			});
		} finally {
			configure("odin", null);
		}
	});

	test("odinRun builds, publishes the executable, then returns a run template reusing odinBuild's outputPath", async () => {
		configure("odin", null);
		try {
			await withFakeRun(async () => {
				await withFakeWriteWorkspace(async (calls) => {
					const pkg = odinPackage({
						path: "rules/odin/example",
						toolchain: "dev-2026-04",
						output: "build/odin/target",
					});
					const template = await odinRun(pkg);
					const { trace } = getMemoTrace();
					const buildEffect = trace.find(
						(t) =>
							t.event === "effect" &&
							t.kind === "run" &&
							t.display.startsWith("odin build"),
					);
					// odinRun itself no longer executes the binary — it publishes it
					// (via writeWorkspace) and returns a runTemplate; the `run` goal
					// (runFromTemplate, rules/workflows/run.js) is what actually runs
					// it, unsandboxed and impure.
					expect(calls.length).toBe(1);
					expect(calls[0].from).toBe(calls[0].path);
					expect(template.opts.argv).toEqual([buildEffect.outputs[0].path]);
					expect(template.opts.display).toBe(`run ${buildEffect.outputs[0].path}`);
				});
			});
		} finally {
			configure("odin", null);
		}
	});

	test("odinRun rejects packages with no main entrypoint", async () => {
		configure("odin", null);
		let message = "";
		try {
			const lib = odinPackage({
				srcs: ["rules/odin/index.js"],
				toolchain: "dev-2026-04",
				output: "build/odin/target",
			});
			await odinRun(lib);
		} catch (error) {
			message = error && error.message ? error.message : String(error);
		} finally {
			configure("odin", null);
		}
		expect(message).toContain("no main entrypoint");
	});

	test("odinLint runs odin check -vet against the package", async () => {
		configure("odin", null);
		try {
			await withFakeRun(async () => {
				const pkg = odinPackage({
					path: "rules/odin/example",
					toolchain: "dev-2026-04",
				});
				const result = await odinLint(pkg);
				expect(result.ok).toBe(true);
				const { trace } = getMemoTrace();
				const runEffect = trace.find(
					(t) =>
						t.event === "effect" &&
						t.kind === "run" &&
						t.display.startsWith("odin check"),
				);
				expect(runEffect.argv[2]).toContain("odin check");
				expect(runEffect.argv[2]).toContain("-vet");
				expect(runEffect.allowFailure).toBe(true);
			});
		} finally {
			configure("odin", null);
		}
	});

	test("odinLint reports a nonzero exit as ok:false instead of throwing", async () => {
		configure("odin", null);
		try {
			const pkg = odinPackage({
				path: "rules/odin/example",
				toolchain: "dev-2026-04",
			});
			const originalRun = globalThis.__host_run;
			globalThis.__host_run = async () => ({
				stdout: "",
				stderr: "declared but not used\n",
				exitCode: 1,
			});
			try {
				const result = await odinLint(pkg);
				expect(result.ok).toBe(false);
				expect(result.output).toContain("declared but not used");
			} finally {
				globalThis.__host_run = originalRun;
			}
		} finally {
			configure("odin", null);
		}
	});

	// odinDistPackage just returns artifact(buildResult.outputDigest, {from}) —
	// publishing to dist/ now happens in the `package` goal (packageGoal,
	// rules/workflows/package.js), not here. But that digest comes from
	// __host_run's real return value, which withFakeRun doesn't fake (it only
	// stubs stdout/stderr/exitCode), so this is still covered end-to-end via
	// `imp package` rather than a unit test here.

	test("odinBuild rejects packages with no source files after excludes", async () => {
		configure("odin", null);
		const pkg = odinPackage({
			path: "rules/odin",
			srcs: ["missing*.odin"],
			toolchain: "dev-2026-04",
		});
		let message = "";
		try {
			await odinBuild(pkg);
		} catch (error) {
			message = error && error.message ? error.message : String(error);
		}
		expect(message).toContain("has no Odin source files");
		expect(message).toContain("exclude: []");
	});

	test("odinBuild uses the single source directory when it differs from target path", async () => {
		configure("odin", null);
		try {
			await withFakeRun(async () => {
				const pkg = odinPackage({
					path: "rules/odin",
					srcs: ["example/*.odin"],
					toolchain: "dev-2026-04",
					output: "build/odin/target",
				});
				await odinBuild(pkg);
				const { trace } = getMemoTrace();
				const runEffect = trace.find(
					(t) =>
						t.event === "effect" &&
						t.kind === "run" &&
						t.display === "odin build rules/odin/example",
				);
				expect(runEffect.argv).toContain("rules/odin/example");
				expect(
					inputsIncludePath(runEffect.inputs, "rules/odin/example/main.odin"),
				).toBe(true);
			});
		} finally {
			configure("odin", null);
		}
	});

	test("odinBuild does not use library build mode when package has a main entrypoint", async () => {
		configure("odin", null);
		try {
			await withFakeRun(async () => {
				const app = odinPackage({
					path: "rules/odin/example",
					toolchain: "dev-2026-04",
					output: "build/odin/target",
				});
				await odinBuild(app);
				const { trace } = getMemoTrace();
				const runEffect = trace.find(
					(t) =>
						t.event === "effect" &&
						t.kind === "run" &&
						t.display === "odin build rules/odin/example",
				);
				expect(runEffect.argv).not.toContain("-build-mode:lib");
				expect(runEffect.outputs).toEqual([
					{ kind: "file", path: "build/odin/target" },
					{ kind: "directory", path: "build/odin" },
				]);
			});
		} finally {
			configure("odin", null);
		}
	});

	test("odinBuild links without an explicit linker override (no mold flag/tool)", async () => {
		configure("odin", null);
		try {
			await withFakeRun(async () => {
				const toolchain = odinToolchain("dev-2026-06", {});
				const app = odinPackage({
					path: "rules/odin/example",
					toolchain,
					output: "build/odin/target",
				});
				await odinBuild(app);
				const { trace } = getMemoTrace();
				const runEffect = trace.find(
					(t) =>
						t.event === "effect" &&
						t.kind === "run" &&
						t.display === "odin build rules/odin/example",
				);
				expect(runEffect.argv).not.toContain("-linker:mold");
				expect(runEffect.tools.some((t) => t.name === "mold")).toBe(false);
			});
		} finally {
			configure("odin", null);
		}
	});

	test("odinBuild uses -linker:mold and a mold tool when the toolchain configures a linker", async () => {
		configure("odin", null);
		try {
			await withFakeRun(async () => {
				const toolchain = odinToolchain("dev-2026-06", {
					linker: moldForTests,
				});
				const app = odinPackage({
					path: "rules/odin/example",
					toolchain,
					output: "build/odin/target",
				});
				await odinBuild(app);
				const { trace } = getMemoTrace();
				const runEffect = trace.find(
					(t) =>
						t.event === "effect" &&
						t.kind === "run" &&
						t.display === "odin build rules/odin/example",
				);
				expect(runEffect.argv).toContain("-linker:mold");
				expect(runEffect.tools.some((t) => t.name === "mold")).toBe(true);
			});
		} finally {
			configure("odin", null);
		}
	});

	test("odinTestPackage declares an Odin test target", () => {
		const pkg = odinTestPackage({
			path: "rules/odin/example",
			toolchain: "dev-2026-04",
		});
		expect(pkg.kind).toBe("odin-test-package");
		expect(pkg.attrs.path).toBe("rules/odin/example");
		expect(pkg.attrs.exclude).toBe(undefined);
	});

	test("odinTest runs odin test with package sources", async () => {
		configure("odin", null);
		try {
			await withFakeRun(async () => {
				const pkg = odinTestPackage({
					path: "rules/odin/example",
					toolchain: "dev-2026-04",
				});
				await odinTest(pkg);
				const { trace } = getMemoTrace();
				const runEffect = trace.find(
					(t) =>
						t.event === "effect" &&
						t.kind === "run" &&
						t.display === "odin test rules/odin/example",
				);
				expect(runEffect.argv).toContain("rules/odin/example");
				expect(runEffect.argv[2]).toContain("odin test");
				expect(
					inputsIncludePath(runEffect.inputs, "rules/odin/example/main.odin"),
				).toBe(true);
				expect(runEffect.impure).toBe(true);
			});
		} finally {
			configure("odin", null);
		}
	});
});
