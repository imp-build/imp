import {
	describe,
	expect,
	test,
	withFakeMergeDigests,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { getMemoTrace } from "imp:core";
import { ccBuild, ccBinary, ccLibrary, has_c_main_entrypoint } from "//rules/c";
import {
	__resetGccToolchainStateForTest,
	gccToolchain,
	installGccToolchain,
} from "//rules/c/gcc";

async function withGccHost(fn) {
	return withFakeToolchainHost(async (host) => {
		__resetGccToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetGccToolchainStateForTest();
		}
	});
}

async function withOptMode(value, fn) {
	const original = globalThis.__host_configuration;
	globalThis.__host_configuration = (namespace) =>
		namespace === "imp.mode"
			? JSON.stringify({ opt: value })
			: original(namespace);
	try {
		return await fn();
	} finally {
		globalThis.__host_configuration = original;
	}
}

describe("C/C++ rules", () => {
	test("ccLibrary declares a raw library label", () => {
		const lib = ccLibrary({ path: "rules/c/cmake/example", srcs: ["hello.c"] });

		expect(lib.__imp_label).toBe(true);
		expect(lib.data.type).toBe("library");
		expect(lib.data.backend).toBe("raw");
		expect(lib.data.path).toBe("rules/c/cmake/example");
	});

	test("ccBinary declares a raw binary label", () => {
		const bin = ccBinary({ path: "rules/c/cmake/example", srcs: ["main.c"] });

		expect(bin.__imp_label).toBe(true);
		expect(bin.data.type).toBe("binary");
		expect(bin.data.backend).toBe("raw");
	});

	test("has_c_main_entrypoint ignores comments and strings", () => {
		const source = [
			'const char *s = "int main(void)";',
			"/* int main(void) { return 1; } */",
			"int helper(void) { return 0; }",
		].join("\n");

		expect(has_c_main_entrypoint(source)).toBe(false);
	});

	test("has_c_main_entrypoint detects a real main declaration", () => {
		expect(
			has_c_main_entrypoint(
				"int main(int argc, char **argv) { return argc; }\n",
			),
		).toBe(true);
	});

	test("raw ccLibrary build compiles and archives with a declared C/C++ toolchain", async () => {
		await withGccHost(async (host) => {
			await withFakeMergeDigests(async () => {
				installGccToolchain("2025.08-1", "/tmp/gcc-2025.08-1");
				const gcc = gccToolchain("2025.08-1", {
					default: true,
					unverified: true,
				});
				const lib = ccLibrary({
					path: "rules/c/cmake/example",
					srcs: ["hello.c"],
					toolchain: gcc,
					output: "build/c/testlib.a",
				});

				const result = await ccBuild(lib);

				expect(result.outputPath).toBe("build/c/testlib.a");
				expect(host.runs.length).toBe(2);
				expect(host.runs[0].display).toContain("cc compile");
				expect(host.runs[0].argv).toContain("-O0");
				expect(host.runs[0].argv).toContain("-g");
				expect(host.runs[1].display).toContain("cc archive");
				const { trace } = getMemoTrace();
				expect(
					trace.some(
						(t) =>
							t.event === "effect" &&
							t.kind === "run" &&
							t.display.includes("cc compile"),
					),
				).toBe(true);
			});
		});
	});

	test("raw C/C++ builds use release optimization flags for opt=release", async () => {
		await withGccHost(async (host) => {
			await withFakeMergeDigests(async () => {
				installGccToolchain("2025.08-1", "/tmp/gcc-2025.08-1");
				const gcc = gccToolchain("2025.08-1", {
					default: true,
					unverified: true,
				});
				const lib = ccLibrary({
					path: "rules/c/cmake/example",
					srcs: ["hello.c"],
					toolchain: gcc,
					output: "build/c/release-testlib.a",
				});

				await withOptMode("release", () => ccBuild(lib));

				expect(host.runs[0].argv).toContain("-O2");
				expect(host.runs[0].argv).toContain("-DNDEBUG");
				expect(host.runs[0].argv).not.toContain("-g");
			});
		});
	});
});
