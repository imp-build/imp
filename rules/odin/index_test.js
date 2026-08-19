import { BUILD } from "//rules/workflows/build";
import { LINT } from "//rules/workflows/lint";
import { PACKAGE } from "//rules/workflows/package";
import { RUN } from "//rules/workflows/run";
import { TEST } from "//rules/workflows/test";
import { ccLibrary } from "//rules/c";
import { defaultGccGraphToolchain } from "//rules/c/gcc";
import { defaultMoldGraphToolchain } from "//rules/c/mold";
import { describe, expect, test } from "//rules/imp/test";
import {
	odinExtraLinkerFlagsArgs,
	odinGccLinkerPathDir,
	odinGen,
	odinLinkerPathDir,
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

	test("generators produce a CAS artifact graph", () => {
		const generated = odinGen({
			srcs: ["*.json"],
			out: "generated/bindings.odin",
			cmd: ["echo"],
		});
		expect(generated.generated.__imp_graph_handle).toBe(true);
		expect(generated[BUILD].__imp_graph_handle).toBe(true);
	});

	// Issue #96: odinPackage() accepts a generated source artifact (e.g.
	// odinGen()'s own output) alongside its ordinary workspace srcs.
	test("odinGen() exposes the real workspace path its artifact lands at", () => {
		const generated = odinGen({
			base: "rules/odin/example",
			srcs: ["*.json"],
			out: "generated/bindings.odin",
			cmd: ["echo"],
		});
		expect(generated.path).toBe("rules/odin/example/generated/bindings.odin");
	});

	test("odinPackage(generatedSrcs) builds a valid graph without throwing", () => {
		const generated = odinGen({
			base: "rules/odin/example",
			srcs: ["*.json"],
			out: "generated/bindings.odin",
			cmd: ["echo"],
		});
		const pkg = odinPackage({
			path: "rules/odin/example",
			generatedSrcs: [
				{ artifact: generated.generated, path: "generated/bindings.odin" },
			],
			toolchain: "dev-2026-03",
		});
		expect(pkg[BUILD].__imp_graph_handle).toBe(true);
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
	async function buildFileRoots(pkg) {
		const walkJson = await globalThis.__imp_walk_graph_for_introspection(
			JSON.stringify([{ address: "pkg", handleId: pkg[BUILD].__graph_id }]),
			JSON.stringify({ args: [], flags: {}, mode: {}, config: {} }),
			JSON.stringify({ discoverExpansionGet: true }),
		);
		return JSON.parse(walkJson)
			.nodes.filter((node) => node.kind === "files")
			.map((node) => node.data && node.data.root);
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

	// The GCC graph tool chooses bin/ or bin-unsafe-paths/ before the executor
	// prepends its tool directories to PATH. This helper only derives the
	// selected launcher's directory.
	test("odinLinkerPathDir returns the mounted clang directory", () => {
		expect(odinLinkerPathDir(".imp/tools/gcc-toolchain/bin/clang")).toBe(
			".imp/tools/gcc-toolchain/bin",
		);
		expect(
			odinLinkerPathDir(".imp/tools/gcc-toolchain/bin-unsafe-paths/clang"),
		).toBe(".imp/tools/gcc-toolchain/bin-unsafe-paths");
	});

	test("odinGccLinkerPathDir resolves clang through the graph tool mount", () => {
		const gcc = { mountName: "gcc-toolchain" };
		let toolCall = null;
		const path = odinGccLinkerPathDir(
			{
				tool(handle, executable) {
					toolCall = [handle, executable];
					return ".imp/tools/gcc-toolchain/bin/clang";
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
