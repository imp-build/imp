import { BUILD } from "//rules/workflows/build";
import { PACKAGE } from "//rules/workflows/package";
import { files, tool } from "imp:core";
import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { ccBinary, ccLibrary } from "//rules/c";
import { __resetGccToolchainStateForTest, gccToolchain } from "//rules/c/gcc";
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
function fakeGccGraphToolchain(version = "2025.08-1") {
	const binRoot = files({ root: "rules/c/gcc", include: ["**/*"] });
	return { tool: tool(binRoot, { binDirs: ["bin"] }), version };
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
			expect(lib.transitiveIncludeDirs).toEqual(["rules/c/testdata/mixed_sources"]);
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
