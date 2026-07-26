import { describe, expect, test } from "//rules/imp/test";
import {
	CmakeLib,
	cmakeLib,
	cmakeToolchain,
	defaultCmakeToolchain,
} from "//rules/c/cmake";
import { defaultZigToolchain, zigToolchain } from "//rules/c/zig/toolchain";

describe("CMake rules", () => {
	test("uses imported CMake and Zig defaults without configuration", () => {
		const lib = cmakeLib({ src: "build/default", deps: [] });
		const cmake = defaultCmakeToolchain();
		const zig = defaultZigToolchain();

		expect(lib.attrs.toolchain).toBe(cmake.attrs.version);
		expect(lib.attrs.toolchainTarget).toBe(cmake);
		expect(lib.attrs.compiler).toBe(zig.attrs.version);
		expect(lib.attrs.compilerTarget).toBe(zig);
		expect(lib.attrs.deps.length).toBe(2);
	});

	test("adds an explicit CMake toolchain target dependency", () => {
		const toolchain = cmakeToolchain("3.31.0");
		const lib = cmakeLib({ src: "build/explicit", toolchain, deps: [] });

		expect(lib.attrs.toolchain).toBe("3.31.0");
		expect(lib.attrs.toolchainTarget).toBe(toolchain);
		expect(lib.attrs.deps.length).toBe(2);
	});

	test("keeps explicit CMake string versions detached from the default target", () => {
		const lib = cmakeLib({
			src: "build/string",
			toolchain: "3.32.0",
			deps: [],
		});

		expect(lib.attrs.toolchain).toBe("3.32.0");
		expect(lib.attrs.toolchainTarget ?? null).toBe(null);
		expect(lib.attrs.deps.length).toBe(1);
	});

	test("expanded CMake cc targets are selected by output artifacts", () => {
		const lib = new CmakeLib({
			kind: "cc_library",
			outputs: ["libhf.a"],
			outputsInBuildDir: true,
			deps: [],
		});

		expect(lib.kind).toBe("cc_library");
		expect(lib.attrs.backend).toBe("cmake");
		expect(lib.attrs.outputs).toEqual(["libhf.a"]);
		expect(lib.attrs.outputsInBuildDir).toBe(true);
	});

	test("uses the imported Zig compiler default", () => {
		const lib = cmakeLib({ src: "build/no-compiler", deps: [] });
		const compiler = defaultZigToolchain();

		expect(lib.attrs.compiler).toBe(compiler.attrs.version);
		expect(lib.attrs.compilerTarget).toBe(compiler);
		expect(lib.attrs.deps.length).toBe(2);
	});

	test("adds an explicit Zig compiler target dependency", () => {
		const compiler = zigToolchain("0.16.0");
		const lib = cmakeLib({
			src: "build/explicit-compiler",
			compiler,
			deps: [],
		});

		expect(lib.attrs.compiler).toBe("0.16.0");
		expect(lib.attrs.compilerTarget).toBe(compiler);
		expect(lib.attrs.deps.length).toBe(2);
	});

	test("keeps explicit compiler string versions detached from the default target", () => {
		const lib = cmakeLib({
			src: "build/compiler-string",
			compiler: "0.16.1",
			deps: [],
		});

		expect(lib.attrs.compiler).toBe("0.16.1");
		expect(lib.attrs.compilerTarget ?? null).toBe(null);
		expect(lib.attrs.deps.length).toBe(1);
	});

	test("uses the default CMake toolchain target", () => {
		const toolchain = cmakeToolchain("3.30.5", { default: true });
		const lib = cmakeLib({ src: "build/default-tool", deps: [] });

		expect(lib.attrs.toolchain).toBe("3.30.5");
		expect(lib.attrs.toolchainTarget).toBe(toolchain);
		expect(lib.attrs.deps.length).toBe(2);
	});

	test("uses the default Zig compiler target", () => {
		const compiler = zigToolchain("0.16.2", { default: true });
		const lib = cmakeLib({ src: "build/default-compiler", deps: [] });

		expect(lib.attrs.compiler).toBe("0.16.2");
		expect(lib.attrs.compilerTarget).toBe(compiler);
		expect(lib.attrs.deps.length).toBe(2);
	});

	test("wires both a CMake toolchain and a Zig compiler together", () => {
		const toolchain = cmakeToolchain("3.31.1");
		const compiler = zigToolchain("0.16.3");
		const lib = cmakeLib({ src: "build/both", toolchain, compiler, deps: [] });

		expect(lib.attrs.toolchain).toBe("3.31.1");
		expect(lib.attrs.compiler).toBe("0.16.3");
		expect(lib.attrs.deps.length).toBe(2);
	});

	test("omits ctestArgs by default", () => {
		const lib = cmakeLib({ src: "build/no-ctest-args", deps: [] });

		expect(lib.attrs.ctestArgs ?? null).toBe(null);
	});

	test("plumbs ctestArgs through to attrs", () => {
		const lib = cmakeLib({
			src: "build/ctest-args",
			ctestArgs: ["-R", "some_test", "-V"],
			deps: [],
		});

		expect(lib.attrs.ctestArgs).toEqual(["-R", "some_test", "-V"]);
	});
});
