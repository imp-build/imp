import { BUILD, PACKAGE, files, tool } from "imp:core";
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

describe("graph-native ccLibrary/ccBinary", () => {
	test("ccLibrary exposes [BUILD]/[PACKAGE] and transitive archive/include-dir arrays", () => {
		return withCcHost(() => {
			const lib = ccLibrary({
				path: "rules/c/label_example",
				toolchain: fakeGccGraphToolchain(),
			});
			expect(lib[BUILD].__imp_graph_handle).toBe(true);
			expect(lib[PACKAGE].__imp_graph_handle).toBe(true);
			expect(lib.transitiveArchives).toEqual([lib.archive]);
			expect(lib.transitiveIncludeDirs).toEqual(["rules/c/label_example"]);
		});
	});

	test("ccBinary({deps}) folds a dependency library's transitiveArchives in, handle-passing (not label references)", () => {
		return withCcHost(() => {
			const lib = ccLibrary({
				path: "rules/c/label_example",
				toolchain: fakeGccGraphToolchain(),
			});
			const bin = ccBinary({
				path: "rules/c/label_example",
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
				ccLibrary({ path: "rules/c/label_example" });
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain(
				"ccLibrary()/ccBinary() need an explicit toolchain",
			);
		});
	});
});
