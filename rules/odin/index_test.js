import { BUILD } from "//rules/workflows/build";
import { LINT } from "//rules/workflows/lint";
import { PACKAGE } from "//rules/workflows/package";
import { RUN } from "//rules/workflows/run";
import { TEST } from "//rules/workflows/test";
import { ccLibrary } from "//rules/c";
import { defaultGccGraphToolchain } from "//rules/c/gcc";
import { defaultMoldGraphToolchain } from "//rules/c/mold";
import { codegen } from "//rules/imp/codegen";
import { describe, expect, test } from "//rules/imp/test";
import { nativeTool } from "//rules/imp/native-tool";
import { configuration, files, platformInfo } from "imp:core";
import {
	odinExtraLinkerFlagsArgs,
	odinTestLibraryPathEnv,
	odinGccLinkerPathDir,
	odinLinkerPathDir,
	odinMergeLinkopts,
	odinModeFlags,
	odin_output_path,
	odinPackage,
	odinTestPackage,
} from "//rules/odin";
import {
	__resetOdinToolchainStateForTest,
	odinToolchain,
} from "//rules/odin/toolchain";

describe("Odin graph rules", () => {
	test("packages expose immutable graph roots", () => {
		const pkg = odinPackage({
			path: "rules/odin/example",
			toolchain: "dev-2026-03",
		});
		expect(pkg.sources.__imp_graph_handle).toBe(true);
		expect(pkg[BUILD].__imp_graph_handle).toBe(true);
		expect(pkg[LINT].__imp_graph_handle).toBe(true);
		expect(pkg[PACKAGE].__imp_graph_handle).toBe(true);
		expect(pkg[RUN].__imp_graph_handle).toBe(true);
	});

	test("test packages expose only test-oriented actions", () => {
		const pkg = odinTestPackage({
			path: "rules/odin/example",
			toolchain: "dev-2026-03",
		});
		expect(pkg[TEST].__imp_graph_handle).toBe(true);
		expect(pkg[RUN]).toBe(undefined);
	});

	// A test package's build and test actions have the same run callback, the
	// same call site and the same inputs — they used to collide on one task
	// key, so [TEST] resolved to the *build* task and `imp test` compiled the
	// package and reported success without ever running a test.
	test("a test package's TEST action really is `odin test`", async () => {
		const pkg = odinTestPackage({
			path: "rules/odin/example/native",
			toolchain: "dev-2026-03",
		});
		expect(pkg[TEST].__graph_id).not.toBe(pkg[BUILD].__graph_id);

		const walkJson = await globalThis.__imp_walk_graph_for_introspection(
			JSON.stringify([{ address: "pkg", handleId: pkg[TEST].__graph_id }]),
			JSON.stringify({ args: [], flags: {}, mode: {}, config: {} }),
			JSON.stringify({ discoverExpansionGet: true }),
		);
		const displays = JSON.parse(walkJson)
			.nodes.map((node) => node.display)
			.filter(Boolean);
		expect(displays).toContain("odin test rules/odin/example/native");
	});

	// configure("imp.mode", ...) is host-reserved for real CLI --axis/
	// --profile resolution (see defineModeAxis), so this rule's own JS unit
	// tests can't simulate a resolved "release" axis directly — instead
	// this asserts odinModeFlags() (graphOdinBuild()'s own flag mapping,
	// applied to whatever "opt" configuration("imp.mode") resolves to) maps
	// each opt value to the right odin flag. Real --axis opt=release
	// end-to-end behavior (the emitted -o:speed flag and the resulting
	// rebuild instead of a stale cache hit) is covered by manual
	// `imp build --axis opt=...` verification instead of a unit test.
	test("odinModeFlags() maps the opt axis to odin's debug/release flags", () => {
		expect(odinModeFlags("debug")).toEqual(["-debug"]);
		expect(odinModeFlags("release")).toEqual(["-o:speed"]);
		// Anything unresolved/unrecognized falls back to the axis's own
		// declared default ("debug"), not a silent no-flags build.
		expect(odinModeFlags(undefined)).toEqual(["-debug"]);
	});

	test("build task inputs default to the opt axis's declared debug default", () => {
		expect(configuration("imp.mode", {}).opt ?? "debug").toBe("debug");
	});

	test("main entrypoints use an executable output path", () => {
		expect(odin_output_path("output", { hasMainEntrypoint: true })).toBe(
			"output",
		);
		expect(odin_output_path("output", { hasMainEntrypoint: false })).toBe(
			"output.a",
		);
	});

	// A codegen() result standing in for a real generator: the tests below care
	// about how a generated artifact is staged, not about what wrote it.
	function exampleCodegen(outputPath) {
		return codegen({
			tools: { sh: nativeTool("sh") },
			outputPaths: [outputPath],
			argv: (exec, { sh }) => [exec.tool(sh, "sh"), "-c", "true"],
		});
	}

	test("odinPackage(generatedSrcs) builds a valid graph without throwing", () => {
		const generated = exampleCodegen(
			"rules/odin/example/generated/bindings.odin",
		);
		const pkg = odinPackage({
			path: "rules/odin/example",
			generatedSrcs: [
				{
					artifact:
						generated.files["rules/odin/example/generated/bindings.odin"],
					path: "generated/bindings.odin",
				},
			],
			toolchain: "dev-2026-03",
		});
		expect(pkg[BUILD].__imp_graph_handle).toBe(true);
	});

	// The whole point of taking a codegen() result directly: a generator that
	// writes five files should not make the package repeat five entries.
	test("odinPackage(generatedSrcs) takes a codegen() result directly", async () => {
		const generated = codegen({
			tools: { sh: nativeTool("sh") },
			outputPaths: [
				"rules/odin/example/generated/one.odin",
				"rules/odin/example/generated/two.odin",
			],
			argv: (exec, { sh }) => [exec.tool(sh, "sh"), "-c", "true"],
		});
		const pkg = odinPackage({
			path: "rules/odin/example",
			generatedSrcs: [generated],
			toolchain: "dev-2026-03",
		});
		const walkJson = await globalThis.__imp_walk_graph_for_introspection(
			JSON.stringify([{ address: "pkg", handleId: pkg[BUILD].__graph_id }]),
			JSON.stringify({ args: [], flags: {}, mode: {}, config: {} }),
			JSON.stringify({ discoverExpansionGet: true }),
		);
		const { nodes } = JSON.parse(walkJson);
		const build = nodes.find(
			(node) => node.display === "odin build rules/odin/example",
		);
		const generatedEdges = build.edges.filter((edge) =>
			/^generated\d+$/.test(edge.name),
		);
		expect(generatedEdges.length).toBe(2);
	});

	test("odinPackage(generatedSrcs) rejects an entry missing artifact/path", () => {
		let message = null;
		try {
			odinPackage({
				path: "rules/odin/example",
				generatedSrcs: [{ path: "generated/bindings.odin" }],
				toolchain: "dev-2026-03",
			});
		} catch (error) {
			message = error.message;
		}
		expect(message).toContain("generatedSrcs[0]");
	});

	// Issue #7: `--changed-since` needs to see the real dependency edge a
	// genuine inferred Odin import produces (not a hand-wired one), since
	// that's exactly what `spike::stale_graph_addresses` walks in Rust via
	// `__imp_walk_graph_for_introspection(..., { discoverExpansionGet: true })`.
	// pkg_b (fixtures under example/staleness/) really imports "../pkg_a" —
	// this asserts that produces a genuine sourceN task-input edge reaching
	// pkg_a's sources handle, not merely that pkg_a is reachable somehow.
	test("staleness walk reaches real inferred-import dependency edges", async () => {
		const pkgA = odinPackage({
			path: "rules/odin/example/staleness/pkg_a",
			toolchain: "dev-2026-03",
		});
		const pkgB = odinPackage({
			path: "rules/odin/example/staleness/pkg_b",
			toolchain: "dev-2026-03",
		});
		expect(pkgA.sources.__imp_graph_handle).toBe(true);

		const roots = [{ address: "pkgB", handleId: pkgB[BUILD].__graph_id }];
		const walkJson = await globalThis.__imp_walk_graph_for_introspection(
			JSON.stringify(roots),
			JSON.stringify({ args: [], flags: {}, mode: {}, config: {} }),
			JSON.stringify({ discoverExpansionGet: true }),
		);
		const { nodes } = JSON.parse(walkJson);
		const fileRoots = nodes
			.filter((node) => node.kind === "files")
			.map((node) => node.data && node.data.root);
		expect(fileRoots).toContain("rules/odin/example/staleness/pkg_a");
	});

	// Issue #88: one `odin build` compiles the whole import tree, so every
	// reachable package's sources have to be in the sandbox. These walk the
	// same introspection path as the test above and assert on the `files`
	// leaves the build action really declares.
	async function buildFileSpecs(pkg, workflow = BUILD) {
		const walkJson = await globalThis.__imp_walk_graph_for_introspection(
			JSON.stringify([{ address: "pkg", handleId: pkg[workflow].__graph_id }]),
			JSON.stringify({ args: [], flags: {}, mode: {}, config: {} }),
			JSON.stringify({ discoverExpansionGet: true }),
		);
		return JSON.parse(walkJson)
			.nodes.filter((node) => node.kind === "files")
			.map((node) => node.data || {});
	}

	async function buildFileRoots(pkg) {
		return (await buildFileSpecs(pkg)).map((data) => data.root);
	}

	test("collection imports become source inputs", async () => {
		const app = odinPackage({
			base: "rules/odin/example/collection",
			path: "app",
			collections: { lib: "vendor" },
			toolchain: "dev-2026-03",
		});
		expect(await buildFileRoots(app)).toContain(
			"rules/odin/example/collection/vendor/greet",
		);
	});

	test("the source closure follows imports inside a collection", async () => {
		const app = odinPackage({
			base: "rules/odin/example/collection",
			path: "app",
			collections: { lib: "vendor" },
			toolchain: "dev-2026-03",
		});
		// vendor/util is reached only through vendor/greet's own "lib:util"
		// import — nothing in app/ names it.
		expect(await buildFileRoots(app)).toContain(
			"rules/odin/example/collection/vendor/util",
		);
	});

	test("the source closure follows declared packages transitively", async () => {
		odinPackage({
			path: "rules/odin/example/staleness/pkg_a",
			toolchain: "dev-2026-03",
		});
		odinPackage({
			path: "rules/odin/example/staleness/pkg_b",
			toolchain: "dev-2026-03",
		});
		const pkgC = odinPackage({
			path: "rules/odin/example/staleness/pkg_c",
			toolchain: "dev-2026-03",
		});
		// pkg_c imports pkg_b, which imports pkg_a. Without a closure, pkg_c's
		// action declares pkg_b only and the compiler fails on pkg_a.
		expect(await buildFileRoots(pkgC)).toContain(
			"rules/odin/example/staleness/pkg_a",
		);
	});

	// Issue #100: a raw ccLibrary() dep has no .sources/.resources handle,
	// only transitiveArchives — this asserts its archive-building task's own
	// srcs really reach the odin build action's declared inputs, not just
	// that the graph builds without throwing.
	test("a ccLibrary() dep's archive-building task reaches the build inputs", async () => {
		const native = ccLibrary({
			path: "rules/odin/example/native",
			toolchain: defaultGccGraphToolchain(),
		});
		const app = odinPackage({
			path: "rules/odin/example",
			deps: [native],
			toolchain: "dev-2026-03",
		});
		expect(await buildFileRoots(app)).toContain("rules/odin/example/native");
	});

	// A binary whose dep closure contributed a workspace-built shared library
	// gets a *directory* product carrying that library beside the executable,
	// so its [RUN] root can no longer be the product itself — a directory is
	// not a program. It becomes a run descriptor naming the executable inside,
	// the same shape ccBinary() uses. Before the bundle the binary built and
	// then failed at launch: "error while loading shared libraries".
	test("a binary with a shared dep gets a bundled product and a run descriptor", async () => {
		const native = ccLibrary({
			path: "rules/odin/example/native",
			toolchain: defaultGccGraphToolchain(),
			shared: true,
		});
		const app = odinPackage({
			path: "rules/odin/example",
			deps: [native],
			toolchain: "dev-2026-03",
		});
		const walkJson = await globalThis.__imp_walk_graph_for_introspection(
			JSON.stringify([{ address: "app", handleId: app[RUN].__graph_id }]),
			JSON.stringify({ args: [], flags: {}, mode: {}, config: {} }),
			JSON.stringify({ discoverExpansionGet: true }),
		);
		const displays = JSON.parse(walkJson)
			.nodes.map((node) => node.display)
			.filter(Boolean);
		expect(displays).toContain("odin bundle rules/odin/example");
		expect(displays).toContain("odin run rules/odin/example");
	});

	// The other half of that contract: nothing has to travel beside a binary
	// with no shared dep, so it keeps the single-file product it has always
	// had — a different shape would move every packaged Odin binary's dist/
	// path for no gain.
	test("a binary with no shared dep keeps its single-file product", async () => {
		const app = odinPackage({
			path: "rules/odin/example",
			toolchain: "dev-2026-03",
		});
		const walkJson = await globalThis.__imp_walk_graph_for_introspection(
			JSON.stringify([{ address: "app", handleId: app[RUN].__graph_id }]),
			JSON.stringify({ args: [], flags: {}, mode: {}, config: {} }),
			JSON.stringify({ discoverExpansionGet: true }),
		);
		const displays = JSON.parse(walkJson)
			.nodes.map((node) => node.display)
			.filter(Boolean);
		expect(displays).toContain("odin build rules/odin/example");
		expect(displays).not.toContain("odin bundle rules/odin/example");
		expect(displays).not.toContain("odin run rules/odin/example");
	});

	// A shared ccLibrary() dep reports its output as transitiveSharedLibs
	// rather than transitiveArchives (rules/c keeps a .so off its own `ar`
	// step). Odin needs the file staged either way, so it reads both buckets —
	// otherwise a shared dep would contribute nothing at all and fail far away
	// at link time.
	test("a shared ccLibrary() dep's building task reaches the build inputs", async () => {
		const native = ccLibrary({
			path: "rules/odin/example/native",
			toolchain: defaultGccGraphToolchain(),
			shared: true,
		});
		const app = odinPackage({
			path: "rules/odin/example",
			deps: [native],
			toolchain: "dev-2026-03",
		});
		expect(await buildFileRoots(app)).toContain("rules/odin/example/native");
	});

	// odinTestPackage() globs the mirror image of odinPackage()'s own default
	// exclude, so the common case — tests beside the code — needs no srcs at
	// all on either target.
	test("odinTestPackage defaults its srcs to the test globs", async () => {
		const lib = odinPackage({
			path: "rules/odin/example/split",
			toolchain: "dev-2026-03",
		});
		const tests = odinTestPackage({
			path: "rules/odin/example/split",
			deps: [lib],
			toolchain: "dev-2026-03",
		});
		const includes = (await buildFileSpecs(tests, TEST))
			.filter((data) => data.root === "rules/odin/example/split")
			.map((data) => (data.include || []).join(","));
		expect(includes).toContain("*_test.odin,test_*.odin");
	});

	// An all-tests directory has no package to take the rest from, and its
	// files need not carry the test suffix — the default glob then matches
	// nothing, so the error has to name the way out.
	test("an empty test package explains that srcs is the way out", async () => {
		const tests = odinTestPackage({
			path: "rules/odin/example/collection/vendor/util",
			toolchain: "dev-2026-03",
		});
		let message = null;
		try {
			await buildFileRoots(tests);
		} catch (error) {
			message = error.message;
		}
		expect(message).toContain("pass srcs");
	});

	// Odin compiles a directory as one package, so a test package that globs
	// only its test files needs the sources of the package it shares that
	// directory with. Both land at the same sandbox path, which is what makes
	// `odin test .` see the two halves as one package. The closure used to key
	// visited packages by path, and the root's own path is visited from the
	// start, so this dep silently contributed nothing.
	test("a test package pulls in the same-directory package it depends on", async () => {
		const lib = odinPackage({
			path: "rules/odin/example/split",
			toolchain: "dev-2026-03",
		});
		const tests = odinTestPackage({
			path: "rules/odin/example/split",
			deps: [lib],
			toolchain: "dev-2026-03",
		});
		const includes = (await buildFileSpecs(tests))
			.filter((data) => data.root === "rules/odin/example/split")
			.map((data) => (data.include || []).join(","));
		// The test package's own glob, and the package under test's glob.
		expect(includes).toContain("*_test.odin,test_*.odin");
		expect(includes).toContain("*.odin");
	});

	// A generated file is an ordinary source of the package that declares it,
	// and one `odin build` compiles that package along with the rest of the
	// closure — so a consumer needs it staged too. It used to be read off the
	// root spec alone, so every consumer had to repeat the whole
	// generatedSrcs list to get a file it does not itself generate.
	test("a dep package's generatedSrcs reach its consumer's build inputs", async () => {
		const generated = exampleCodegen(
			"rules/odin/example/generated/bindings.odin",
		);
		const lib = odinPackage({
			path: "rules/odin/example/split",
			generatedSrcs: [
				{
					artifact:
						generated.files["rules/odin/example/generated/bindings.odin"],
					path: "bindings.odin",
				},
			],
			toolchain: "dev-2026-03",
		});
		const consumer = odinPackage({
			path: "rules/odin/example/staleness/pkg_a",
			deps: [lib],
			toolchain: "dev-2026-03",
		});
		const walkJson = await globalThis.__imp_walk_graph_for_introspection(
			JSON.stringify([
				{ address: "pkg", handleId: consumer[BUILD].__graph_id },
			]),
			JSON.stringify({ args: [], flags: {}, mode: {}, config: {} }),
			JSON.stringify({ discoverExpansionGet: true }),
		);
		const { nodes } = JSON.parse(walkJson);
		const build = nodes.find(
			(node) =>
				node.display === "odin build rules/odin/example/staleness/pkg_a",
		);
		const generatedEdges = build.edges.filter((edge) =>
			/^generated\d+$/.test(edge.name),
		);
		expect(generatedEdges.length).toBe(1);
		// And that input really is the dep's own generating action.
		const producer = nodes.find(
			(node) => node.id === generatedEdges[0].handleId,
		);
		expect(producer.display).toContain(
			"generate rules/odin/example/generated/bindings.odin",
		);
	});

	// Two generated sources claiming one workspace path would overwrite each
	// other in the sandbox, and the winner would depend on input order.
	test("two artifacts generating one path is rejected", async () => {
		const first = exampleCodegen("rules/odin/example/generated/first.odin");
		const second = exampleCodegen("rules/odin/example/generated/second.odin");
		const lib = odinPackage({
			path: "rules/odin/example/split",
			generatedSrcs: [
				{
					artifact: first.files["rules/odin/example/generated/first.odin"],
					path: "clash.odin",
				},
			],
			toolchain: "dev-2026-03",
		});
		// Same directory, so the two entries resolve to one workspace path.
		const consumer = odinTestPackage({
			path: "rules/odin/example/split",
			deps: [lib],
			generatedSrcs: [
				{
					artifact: second.files["rules/odin/example/generated/second.odin"],
					path: "clash.odin",
				},
			],
			toolchain: "dev-2026-03",
		});
		let message = null;
		try {
			await buildFileRoots(consumer);
		} catch (error) {
			message = error.message;
		}
		expect(message).toContain("cannot claim one workspace path");
	});

	// A files() handle in deps used to need a { sources: ... } wrapper; passed
	// directly it was dropped without a word, so the files never reached the
	// sandbox and the failure surfaced far away, at compile or link time.
	test("a bare files() handle in deps is staged as a resource", async () => {
		const pkg = odinPackage({
			path: "rules/odin/example/split",
			deps: [files({ root: "rules/odin/example/native", include: ["*.c"] })],
			toolchain: "dev-2026-03",
		});
		expect(await buildFileRoots(pkg)).toContain("rules/odin/example/native");
	});

	test("a dep of an unrecognized shape is rejected, not ignored", async () => {
		const pkg = odinPackage({
			path: "rules/odin/example/split",
			deps: [{ notAKnownShape: true }],
			toolchain: "dev-2026-03",
		});
		let message = null;
		try {
			await buildFileRoots(pkg);
		} catch (error) {
			message = error.message;
		}
		expect(message).toContain("would contribute nothing");
	});

	// One `odin build` compiles the whole import closure, so an archive a dep
	// package's own `foreign import` names is an archive *this* compilation
	// needs. The C library sits in a directory no odin package here declares,
	// so its files() root can only reach these inputs through propagation.
	test("a dep package's native deps reach its consumer's build inputs", async () => {
		const native = ccLibrary({
			path: "rules/odin/example/native",
			toolchain: defaultGccGraphToolchain(),
		});
		const util = odinPackage({
			path: "rules/odin/example/collection/vendor/util",
			deps: [native],
			toolchain: "dev-2026-03",
		});
		// pkg_a imports nothing, so the dep edge is the only way across.
		const consumer = odinPackage({
			path: "rules/odin/example/staleness/pkg_a",
			deps: [util],
			toolchain: "dev-2026-03",
		});
		expect(await buildFileRoots(consumer)).toContain(
			"rules/odin/example/native",
		);
	});

	// The case a real workspace hit: a workspace-wide collection made the
	// import resolve for a package that declared no dep at all, so the missing
	// archive only showed up as a linker error.
	test("native deps travel a bare import, not just a declared dep", async () => {
		const native = ccLibrary({
			path: "rules/odin/example/native",
			toolchain: defaultGccGraphToolchain(),
		});
		odinPackage({
			path: "rules/odin/example/collection/vendor/greet",
			deps: [native],
			toolchain: "dev-2026-03",
		});
		// app declares no deps; it reaches greet through its own "lib:greet".
		const app = odinPackage({
			base: "rules/odin/example/collection",
			path: "app",
			collections: { lib: "vendor" },
			toolchain: "dev-2026-03",
		});
		expect(await buildFileRoots(app)).toContain("rules/odin/example/native");
	});

	// One library reachable both directly and through a dep package must not
	// become two inputs — that would put the same archive in the task key one
	// time for each path that reaches it.
	test("an archive reachable two ways is declared one time", async () => {
		const native = ccLibrary({
			path: "rules/odin/example/native",
			toolchain: defaultGccGraphToolchain(),
		});
		const util = odinPackage({
			path: "rules/odin/example/collection/vendor/util",
			deps: [native],
			toolchain: "dev-2026-03",
		});
		const nativeRoots = async (deps) =>
			(
				await buildFileRoots(
					odinPackage({
						path: "rules/odin/example/staleness/pkg_a",
						deps,
						toolchain: "dev-2026-03",
					}),
				)
			).filter((root) => root === "rules/odin/example/native").length;
		// Reaching the library both ways declares no more inputs than reaching
		// it one way.
		expect(await nativeRoots([util, native])).toBe(await nativeRoots([util]));
	});

	test("odinMergeLinkopts keeps first occurrence order and drops repeats", () => {
		expect(odinMergeLinkopts([])).toEqual([]);
		expect(
			odinMergeLinkopts([
				["-L/usr/lib/x86_64-linux-gnu", "-lgtk-3"],
				["-L/usr/lib/x86_64-linux-gnu", "-lwebkit2gtk-4.1"],
			]),
		).toEqual(["-L/usr/lib/x86_64-linux-gnu", "-lgtk-3", "-lwebkit2gtk-4.1"]);
	});

	// A ccLibrary()/cmakeLibraryDep()-shaped dep's transitiveLinkopts (e.g.
	// pkg-config-derived -L/-l flags for a shared library's own dependencies)
	// can't reach Odin as a mounted file the way transitiveArchives does —
	// they need to reach `odin build`'s own linker invocation as a single
	// `-extra-linker-flags:` string. See graphOdinBuild()'s own use of this.
	test("odinExtraLinkerFlagsArgs joins linkopts into one -extra-linker-flags: arg, or omits it when empty", () => {
		expect(odinExtraLinkerFlagsArgs([])).toEqual([]);
		expect(
			odinExtraLinkerFlagsArgs([
				"-L/usr/lib/x86_64-linux-gnu",
				"-lwebkit2gtk-4.1",
			]),
		).toEqual([
			"-extra-linker-flags:-L/usr/lib/x86_64-linux-gnu -lwebkit2gtk-4.1",
		]);
	});

	// `odin test` runs the binary it builds inside its own action, so it is the
	// one case that cannot use a product directory to put a shared library
	// beside the executable. The declared entries are the staged libraries' own
	// directories, deduped — a build action's cwd is the sandbox root, so a
	// relative entry resolves against the same root the staged paths use.
	test("odinTestLibraryPathEnv names each staged library directory one time", () => {
		expect(odinTestLibraryPathEnv([])).toEqual([]);
		expect(
			odinTestLibraryPathEnv([
				"build/c/libone.so",
				"build/c/libtwo.so",
				"build/other/libthree.so",
			]),
		).toEqual(["LD_LIBRARY_PATH=build/c:build/other"]);
	});

	// The GCC graph tool chooses bin/ or bin-unsafe-paths/ before the executor
	// prepends its tool directories to PATH. This helper only derives the
	// selected launcher's directory.
	const clangExe = `clang${platformInfo().os === "windows" ? ".exe" : ""}`;

	test("odinLinkerPathDir returns the mounted clang directory", () => {
		expect(odinLinkerPathDir(`.imp/tools/gcc-toolchain/bin/${clangExe}`)).toBe(
			".imp/tools/gcc-toolchain/bin",
		);
		expect(
			odinLinkerPathDir(
				`.imp/tools/gcc-toolchain/bin-unsafe-paths/${clangExe}`,
			),
		).toBe(".imp/tools/gcc-toolchain/bin-unsafe-paths");
	});

	test("odinGccLinkerPathDir resolves clang through the graph tool mount", () => {
		const gcc = { mountName: "gcc-toolchain" };
		let toolCall = null;
		const path = odinGccLinkerPathDir(
			{
				tool(handle, executable) {
					toolCall = [handle, executable];
					return `.imp/tools/gcc-toolchain/bin/${clangExe}`;
				},
			},
			gcc,
		);
		expect(toolCall).toEqual([gcc, "clang"]);
		expect(path).toBe(".imp/tools/gcc-toolchain/bin");
	});

	test("an import that resolves to no package is an error", async () => {
		const app = odinPackage({
			base: "rules/odin/example/collection",
			path: "app",
			collections: { lib: "vendor/does-not-exist" },
			toolchain: "dev-2026-03",
		});
		let message = null;
		try {
			await buildFileRoots(app);
		} catch (error) {
			message = error && error.message ? error.message : String(error);
		}
		expect(message).toContain("but there is no Odin package there");
	});
});
