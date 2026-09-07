import { BUILD } from "//rules/workflows/build";
import { PACKAGE } from "//rules/workflows/package";
import { RUN } from "//rules/workflows/run";
import { TEST } from "//rules/workflows/test";
import { files, tool } from "imp:core";
import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { ccBinary, ccLibrary, ccTest } from "//rules/c";
import { codegen } from "//rules/imp/codegen";
import { nativeTool } from "//rules/imp/native-tool";
import {
	__resetGccToolchainStateForTest,
	gccToolchain,
	gccToolchainRecord,
} from "//rules/c/gcc";
import { __resetZigToolchainStateForTest } from "//rules/c/zig";

function withCcHost(fn) {
	const run = async (host) => {
		__resetGccToolchainStateForTest();
		gccToolchain("2025.08-1", { default: true, unverified: true });
		try {
			return await fn(host);
		} finally {
			__resetGccToolchainStateForTest();
		}
	};
	return withFakeToolchainHost(run);
}

// A fully fake gcc toolchain, sidestepping gccGraphToolchain()'s real
// download+install task chain — see rules/rust/index_test.js's
// fakeGccGraphToolchain() for the same technique and rationale.
// gccToolchainRecord() builds the same cc-toolchain provider contract
// (kind/taskInputs/commands/...) gccGraphToolchain() itself does, just
// around this fake tool/version instead of a real installed one.
function fakeGccGraphToolchain(version = "2025.08-1") {
	const binRoot = files({ root: "rules/c/gcc", include: ["**/*"] });
	return gccToolchainRecord(tool(binRoot, { binDirs: ["bin"] }), version);
}

async function resolveHandles(handles) {
	const roots = handles.map((handle, index) => ({
		address: `root${index}`,
		handleId: handle.__graph_id,
	}));
	return globalThis.__imp_execute_graph_handles(
		JSON.stringify(roots),
		JSON.stringify({}),
	);
}

// The fake host's mocked __host_run() returns only {stdout, stderr,
// exitCode} — no graphOutputs — so an exec.action() call never has real
// outputs under this mock. That's harmless for a task's own declared
// output.file()/output.artifact() (caught downstream as "must be an action
// artifact", same as rules/rust/index_test.js's own
// resolveIgnoringArtifactValidation()). ccTask() also calls exec.path() on a
// dependency library's archive() output (to link against it) — on an empty
// mock output that rejects immediately as "expect a resolved task input".
// Both are the same underlying mock limitation, so both are tolerated here.
async function resolveIgnoringArtifactValidation(handles) {
	try {
		await resolveHandles(handles);
	} catch (error) {
		const message = String(error.message || error);
		if (
			!message.includes("must be an action artifact") &&
			!message.includes("expect a resolved task input")
		) {
			throw error;
		}
	}
}

describe("graph-native ccLibrary/ccBinary", () => {
	test("ccLibrary exposes [BUILD]/[PACKAGE] and transitive archive/include-dir arrays", () => {
		return withCcHost(() => {
			const lib = ccLibrary({
				path: "rules/c/testdata/mixed_sources",
				toolchain: fakeGccGraphToolchain(),
			});
			expect(lib[BUILD].__imp_graph_handle).toBe(true);
			expect(lib[PACKAGE].__imp_graph_handle).toBe(true);
			expect(lib.transitiveArchives).toEqual([lib.archive]);
			expect(lib.transitiveIncludeDirs).toEqual([
				"rules/c/testdata/mixed_sources",
			]);
			expect(lib.transitiveHdrs.length).toBe(1);
			expect(lib.transitiveHdrs[0].__imp_graph_handle).toBe(true);
		});
	});

	test("ccLibrary({shared}) reports its output as a shared library, never as an archive", () => {
		return withCcHost(() => {
			const staticLib = ccLibrary({
				path: "rules/c/testdata/mixed_sources",
				toolchain: fakeGccGraphToolchain(),
			});
			// A static library owns the archive bucket and leaves the shared
			// one empty; a shared library does exactly the reverse. Before the
			// two buckets existed, a shared library's own output appeared in
			// neither and no consumer could reach it.
			expect(staticLib.transitiveArchives).toEqual([staticLib.archive]);
			expect(staticLib.transitiveSharedLibs).toEqual([]);

			const sharedLib = ccLibrary({
				path: "rules/c/testdata/mixed_sources",
				toolchain: fakeGccGraphToolchain(),
				shared: true,
			});
			expect(sharedLib.transitiveArchives).toEqual([]);
			expect(sharedLib.transitiveSharedLibs).toEqual([sharedLib.archive]);
		});
	});

	test("ccLibrary({shared}) builds a lib-prefixed filename and records it as the soname", () => {
		return withCcHost(async (host) => {
			const sharedLib = ccLibrary({
				path: "rules/c/testdata/mixed_sources",
				toolchain: fakeGccGraphToolchain(),
				shared: true,
			});
			await resolveIgnoringArtifactValidation([sharedLib[BUILD]]);
			const linkRun = host.runs.find((run) =>
				run.display.startsWith("cc shared-link "),
			);
			const expected = "librules_c_testdata_mixed_sources.so";
			expect(linkRun.display).toContain(`build/c/${expected}`);
			// Without -Wl,-soname the consumer's DT_NEEDED records the
			// link-line path (measured: `build/c/<name>.so`), and a DT_NEEDED
			// holding a slash makes the loader skip its search paths.
			expect(linkRun.argv.join(" ")).toContain(`-Wl,-soname,${expected}`);
		});
	});

	test("a static library and a binary get no soname and keep their names", () => {
		return withCcHost(async (host) => {
			const lib = ccLibrary({
				path: "rules/c/testdata/mixed_sources",
				toolchain: fakeGccGraphToolchain(),
			});
			const bin = ccBinary({
				path: "rules/c/testdata/mixed_sources",
				deps: [lib],
				toolchain: fakeGccGraphToolchain(),
			});
			await resolveIgnoringArtifactValidation([bin[BUILD]]);
			for (const run of host.runs) {
				expect(run.argv.join(" ")).not.toContain("-Wl,-soname");
			}
			const archiveRun = host.runs.find((run) =>
				run.display.startsWith("cc archive "),
			);
			expect(archiveRun.display).toContain(
				"build/c/rules_c_testdata_mixed_sources.a",
			);
		});
	});

	test("both transitive buckets flow through a dependent library, each keeping its own kind", () => {
		return withCcHost(() => {
			const staticDep = ccLibrary({
				path: "rules/c/testdata/mixed_sources",
				toolchain: fakeGccGraphToolchain(),
			});
			const sharedDep = ccLibrary({
				path: "rules/c/testdata/mixed_sources",
				toolchain: fakeGccGraphToolchain(),
				shared: true,
			});
			const lib = ccLibrary({
				path: "rules/c/testdata/mixed_sources",
				toolchain: fakeGccGraphToolchain(),
				deps: [staticDep, sharedDep],
			});
			expect(lib.transitiveArchives).toEqual([lib.archive, staticDep.archive]);
			expect(lib.transitiveSharedLibs).toEqual([sharedDep.archive]);
		});
	});

	test("a dep predating transitiveSharedLibs still builds", () => {
		return withCcHost(() => {
			// Same tolerance transitiveHdrs/transitiveLinkopts already give a
			// hand-rolled dep object: a missing bucket contributes nothing
			// rather than throwing.
			const dep = {
				transitiveArchives: [],
				transitiveIncludeDirs: [],
			};
			const lib = ccLibrary({
				path: "rules/c/testdata/mixed_sources",
				toolchain: fakeGccGraphToolchain(),
				deps: [dep],
			});
			expect(lib.transitiveSharedLibs).toEqual([]);
		});
	});

	test("ccBinary({deps}) folds a dependency library's transitiveArchives in, handle-passing (not label references)", () => {
		return withCcHost(() => {
			const lib = ccLibrary({
				path: "rules/c/testdata/mixed_sources",
				toolchain: fakeGccGraphToolchain(),
			});
			const bin = ccBinary({
				path: "rules/c/testdata/mixed_sources",
				deps: [lib],
				toolchain: fakeGccGraphToolchain(),
			});
			expect(bin[BUILD].__imp_graph_handle).toBe(true);
			// ccBinary() itself has no archive/transitiveArchives of its own
			// (it's a final link output, not a library other targets can link
			// against) — only ccLibrary() results expose that contract.
			expect(bin.transitiveArchives).toBe(undefined);
		});
	});

	test("ccBinary({deps}) mounts a dependency library's headers into its own compile sandbox, not just -I flags (#114)", () => {
		return withCcHost(async (host) => {
			const standaloneBin = ccBinary({
				path: "rules/c/testdata/dep_consumer",
				srcs: ["main.c"],
				toolchain: fakeGccGraphToolchain(),
			});
			await resolveIgnoringArtifactValidation([standaloneBin[BUILD]]);
			const baselineInputCount = host.runs.find((run) =>
				run.display.startsWith("cc compile "),
			).inputs.length;

			const runsBeforeDeps = host.runs.length;
			const lib = ccLibrary({
				path: "rules/c/testdata/dep_lib",
				toolchain: fakeGccGraphToolchain(),
			});
			const bin = ccBinary({
				path: "rules/c/testdata/dep_consumer",
				deps: [lib],
				toolchain: fakeGccGraphToolchain(),
			});
			await resolveIgnoringArtifactValidation([bin[BUILD]]);
			// Resolving bin[BUILD] also builds its dep (dep_lib's own lib.c), so
			// filter down to the consumer's own compile of main.c specifically,
			// among only the runs from this second resolve.
			const compileRuns = host.runs
				.slice(runsBeforeDeps)
				.filter(
					(run) =>
						run.display.startsWith("cc compile ") &&
						run.display.includes("dep_consumer"),
				);
			expect(compileRuns.length).toBe(1);
			// The dependency's header fileset must add exactly one more mounted
			// digest input versus the same target with no deps.
			expect(compileRuns[0].inputs.length).toBe(baselineInputCount + 1);
		});
	});

	test("ccLibrary compiles each source in its own exec.action(), not one script for all sources (#84)", () => {
		return withCcHost(async (host) => {
			const lib = ccLibrary({
				path: "rules/c/testdata/mixed_sources",
				toolchain: fakeGccGraphToolchain(),
			});
			await resolveIgnoringArtifactValidation([lib[BUILD]]);
			const compileRuns = host.runs.filter((run) =>
				run.display.startsWith("cc compile "),
			);
			// rules/c/testdata/mixed_sources has two sources (main.c,
			// message.cc) — each needs its own action, not one script
			// compiling both. A single shared script is what overflows argv
			// on hundreds of sources (issue #84).
			// Each compile action's own script only compiles its one source —
			// not a script listing every source, which is what would overflow
			// argv on a target with hundreds of them (issue #84).
			for (const run of compileRuns) {
				expect(run.argv[2].split(" -c ").length).toBe(2);
			}
			expect(compileRuns.length).toBe(2);
			// The archive step itself can't be exercised here: the fake
			// host's __host_run() never populates graphOutputs (see
			// resolveIgnoringArtifactValidation above), so the compile
			// actions' own outputs are never real — covered instead by real
			// imp build/imp test runs.
		});
	});

	test("ccLibrary's archive action materializes object paths via a chunked response file, not inline in its script (#84 follow-up)", () => {
		return withCcHost(async (host) => {
			const lib = ccLibrary({
				path: "rules/c/testdata/mixed_sources",
				toolchain: fakeGccGraphToolchain(),
			});
			await resolveIgnoringArtifactValidation([lib[BUILD]]);
			const archiveRun = host.runs.find((run) =>
				run.display.startsWith("cc archive "),
			);
			// argv[2] (the sh -c script) must stay a small, fixed script
			// regardless of how many objects there are — the object list
			// itself must show up only in the chunked argv elements that
			// follow, written to a response file at runtime and referenced
			// via `@rspfile`, never inlined into the script text (that
			// inlining is exactly what overflowed on Windows once a target
			// had enough objects — see rspfileArgv() in rules/c/index.js).
			expect(archiveRun.argv[2]).not.toContain(".o");
			expect(archiveRun.argv[2]).toContain("@");
			const content = archiveRun.argv.slice(5).join("");
			expect(content).toContain(".o");
		});
	});

	test("ccLibrary compile actions each declare exactly one output, at the real per-source object path", () => {
		return withCcHost(async (host) => {
			const lib = ccLibrary({
				path: "rules/c/testdata/mixed_sources",
				toolchain: fakeGccGraphToolchain(),
			});
			await resolveIgnoringArtifactValidation([lib[BUILD]]);
			const compileRuns = host.runs.filter((run) =>
				run.display.startsWith("cc compile "),
			);
			expect(compileRuns.length).toBe(2);
			// A fixed output name ("object") reused across every compile
			// action is only safe because produced artifacts nest under
			// their real captured path, not their output-slot name (see
			// normalize_graph_artifact() in crates/imp-engine/src/spike.rs)
			// — so each action's single declared output path must still be
			// the source-specific object path, not something shared.
			const paths = compileRuns.map((run) => run.outputs[0].path);
			expect(new Set(paths).size).toBe(2);
			for (const run of compileRuns) {
				expect(run.outputs.length).toBe(1);
			}
		});
	});

	test("unsafeSystemPaths selects the -unsafe-paths compiler alias, plain ar otherwise", () => {
		return withCcHost(async (host) => {
			const lib = ccLibrary({
				path: "rules/c/testdata/mixed_sources",
				toolchain: fakeGccGraphToolchain(),
				unsafeSystemPaths: true,
			});
			await resolveIgnoringArtifactValidation([lib[BUILD]]);
			const compileRuns = host.runs.filter((run) =>
				run.display.startsWith("cc compile "),
			);
			expect(compileRuns.length).toBe(2);
			for (const run of compileRuns) {
				expect(
					run.argv[2].includes("clang-unsafe-paths") ||
						run.argv[2].includes("c++-unsafe-paths"),
				).toBe(true);
			}
			const archiveRun = host.runs.find((run) =>
				run.display.startsWith("cc archive "),
			);
			// ar is a real binutils binary, not wrapped — unaffected by the flag.
			expect(archiveRun.argv[2].includes("unsafe-paths")).toBe(false);
		});
	});

	test("a dep's transitiveLinkopts reach ccBinary's own link step, not the archive step", () => {
		return withCcHost(async (host) => {
			const lib = ccLibrary({
				path: "rules/c/testdata/mixed_sources",
				toolchain: fakeGccGraphToolchain(),
			});
			const depWithLinkopts = {
				...lib,
				transitiveLinkopts: ["-L/usr/lib/x86_64-linux-gnu", "-lwebkit2gtk-4.1"],
			};
			const bin = ccBinary({
				path: "rules/c/testdata/mixed_sources",
				deps: [depWithLinkopts],
				toolchain: fakeGccGraphToolchain(),
			});
			await resolveIgnoringArtifactValidation([bin[BUILD]]);
			const linkRun = host.runs.find((run) =>
				run.display.startsWith("cc link "),
			);
			// The object/archive/linkopt list is materialized via a chunked
			// response file (see rspfileArgv() in rules/c/index.js), not
			// inlined into the script at argv[2] — so it shows up further
			// along argv instead.
			const linkContent = linkRun.argv.join("");
			expect(linkContent).toContain("-lwebkit2gtk-4.1");
			expect(linkContent).toContain("-L/usr/lib/x86_64-linux-gnu");
			const archiveRuns = host.runs.filter((run) =>
				run.display.startsWith("cc archive "),
			);
			for (const run of archiveRuns) {
				expect(run.argv.join("")).not.toContain("webkitgtk");
			}
		});
	});

	test("a dep's shared library reaches the link step and is mounted, but never the archive step", () => {
		return withCcHost(async (host) => {
			const sharedDep = ccLibrary({
				path: "rules/c/testdata/mixed_sources",
				toolchain: fakeGccGraphToolchain(),
				shared: true,
			});
			const bin = ccBinary({
				path: "rules/c/testdata/mixed_sources",
				deps: [sharedDep],
				toolchain: fakeGccGraphToolchain(),
			});
			await resolveIgnoringArtifactValidation([bin[BUILD]]);
			const sharedName = "mixed_sources.so";
			const linkRun = host.runs.find((run) =>
				run.display.startsWith("cc link "),
			);
			// Same response-file indirection as the transitiveLinkopts test
			// above — the path shows up further along argv, not at argv[2].
			expect(linkRun.argv.join("")).toContain(sharedName);
			// The `ar` step takes objects only. This is the failure the two
			// buckets exist to prevent: an `ar` invocation handed a .so.
			const archiveRuns = host.runs.filter((run) =>
				run.display.startsWith("cc archive "),
			);
			for (const run of archiveRuns) {
				expect(run.argv.join("")).not.toContain(sharedName);
			}
		});
	});

	test("a binary with a shared dep bundles it beside the executable and links with an $ORIGIN rpath", () => {
		return withCcHost(async (host) => {
			const sharedDep = ccLibrary({
				path: "rules/c/testdata/mixed_sources",
				toolchain: fakeGccGraphToolchain(),
				shared: true,
			});
			const bin = ccBinary({
				path: "rules/c/testdata/mixed_sources",
				deps: [sharedDep],
				toolchain: fakeGccGraphToolchain(),
			});
			await resolveIgnoringArtifactValidation([bin[BUILD]]);
			const linkRun = host.runs.find((run) =>
				run.display.startsWith("cc link "),
			);
			const script = linkRun.argv.join(" ");
			// The executable is linked *inside* the product directory, and the
			// shared library is copied in beside it. Both halves are required:
			// the rpath alone points at a directory holding no library.
			expect(linkRun.display).toContain(
				"build/c/rules_c_testdata_mixed_sources.d/rules_c_testdata_mixed_sources",
			);
			expect(script).toContain("-Wl,-rpath,$ORIGIN");
			expect(script).toContain(
				"cp 'build/c/librules_c_testdata_mixed_sources.so' 'build/c/rules_c_testdata_mixed_sources.d/'",
			);
		});
	});

	test("a binary with no shared dep keeps its single-file product and gets no rpath", () => {
		return withCcHost(async (host) => {
			const staticDep = ccLibrary({
				path: "rules/c/testdata/mixed_sources",
				toolchain: fakeGccGraphToolchain(),
			});
			const bin = ccBinary({
				path: "rules/c/testdata/mixed_sources",
				deps: [staticDep],
				toolchain: fakeGccGraphToolchain(),
			});
			await resolveIgnoringArtifactValidation([bin[BUILD]]);
			const linkRun = host.runs.find((run) =>
				run.display.startsWith("cc link "),
			);
			expect(linkRun.display).toBe(
				"cc link build/c/rules_c_testdata_mixed_sources",
			);
			const script = linkRun.argv.join(" ");
			expect(script).not.toContain("-Wl,-rpath");
			expect(script).not.toContain("cp ");
		});
	});

	test("ccTest() exposes a [TEST] root and ccBinary() a [RUN] root", () => {
		return withCcHost(() => {
			const bin = ccBinary({
				path: "rules/c/testdata/mixed_sources",
				toolchain: fakeGccGraphToolchain(),
			});
			const suite = ccTest({
				path: "rules/c/testdata/mixed_sources",
				toolchain: fakeGccGraphToolchain(),
			});
			expect(bin[RUN]).toBeTruthy();
			expect(suite[TEST]).toBeTruthy();
			expect(suite[RUN]).toBeTruthy();
			// A test target is not a packaging product — nothing publishes it.
			expect(suite[PACKAGE]).toBe(undefined);
		});
	});

	test("ccLibrary() forwards a dep's transitiveLinkopts, not its own linkopts", () => {
		return withCcHost(() => {
			const dep = {
				transitiveArchives: [],
				transitiveIncludeDirs: [],
				transitiveLinkopts: ["-lfoo"],
			};
			const lib = ccLibrary({
				path: "rules/c/testdata/mixed_sources",
				toolchain: fakeGccGraphToolchain(),
				deps: [dep],
			});
			expect(lib.transitiveLinkopts).toEqual(["-lfoo"]);
		});
	});

	test("throws without an explicit toolchain or a declared gcc/zig default", () => {
		return withFakeToolchainHost(() => {
			// Both rules/c/gcc and rules/c/zig auto-declare a default toolchain
			// as a module-load side effect (mirroring rustToolchain()'s own
			// convention) — clear both so resolveToolchain() genuinely has
			// nothing to fall back to.
			__resetGccToolchainStateForTest();
			__resetZigToolchainStateForTest();
			let message = null;
			try {
				ccLibrary({ path: "rules/c/testdata/mixed_sources" });
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain(
				"ccLibrary()/ccBinary() need an explicit toolchain",
			);
		});
	});
});

describe("ccLibrary/ccBinary generatedSrcs", () => {
	function cCodegen(outputPath) {
		return codegen({
			tools: { sh: nativeTool("sh") },
			outputPaths: [outputPath],
			argv: (exec, { sh }) => [exec.tool(sh, "sh"), "-c", "true"],
		});
	}

	test("a codegen() .c result reaches the build task as a generated input", async () => {
		await withCcHost(async () => {
			const generated = cCodegen(
				"rules/c/testdata/mixed_sources/generated/extra.c",
			);
			const lib = ccLibrary({
				path: "rules/c/testdata/mixed_sources",
				generatedSrcs: [generated],
				toolchain: fakeGccGraphToolchain(),
			});
			const walkJson = await globalThis.__imp_walk_graph_for_introspection(
				JSON.stringify([{ address: "lib", handleId: lib[BUILD].__graph_id }]),
				JSON.stringify({ args: [], flags: {}, mode: {}, config: {} }),
				JSON.stringify({}),
			);
			const { nodes } = JSON.parse(walkJson);
			const build = nodes.find(
				(node) => node.display === "cc archive rules/c/testdata/mixed_sources",
			);
			const generatedEdges = build.edges.filter((edge) =>
				/^generated\d+$/.test(edge.name),
			);
			expect(generatedEdges.length).toBe(1);
			// And it is the generator's own action, not a workspace file.
			const producer = nodes.find(
				(node) => node.id === generatedEdges[0].handleId,
			);
			expect(producer.display).toContain(
				"generate rules/c/testdata/mixed_sources/generated/extra.c",
			);
		});
	});

	test("a codegen() .h result is accepted (staged, not compiled)", () => {
		return withCcHost(() => {
			const generated = cCodegen(
				"rules/c/testdata/mixed_sources/generated/api.h",
			);
			expect(() =>
				ccLibrary({
					path: "rules/c/testdata/mixed_sources",
					generatedSrcs: [generated],
					toolchain: fakeGccGraphToolchain(),
				}),
			).not.toThrow();
		});
	});

	test("rejects a generated path that is neither a C source nor a header", () => {
		return withCcHost(() => {
			const generated = cCodegen(
				"rules/c/testdata/mixed_sources/generated/notes.txt",
			);
			expect(() =>
				ccLibrary({
					path: "rules/c/testdata/mixed_sources",
					generatedSrcs: [generated],
					toolchain: fakeGccGraphToolchain(),
				}),
			).toThrow("neither a C/C++ source nor a header");
		});
	});
});
