import { describe, expect, test } from "//rules/imp/test";
import {
	cmakeLib,
	cmakeToolchain,
	defaultCmakeToolchain,
} from "//rules/c/cmake";
import { defaultZigToolchain, zigToolchain } from "//rules/c/zig";

describe("CMake rules", () => {
	test("uses imported CMake and Zig defaults without configuration", () => {
		const lib = cmakeLib({ src: "build/default", deps: [] });
		const cmake = defaultCmakeToolchain();
		const zig = defaultZigToolchain();

		expect(lib.data.toolchain).toBe(cmake.attrs.version);
		expect(lib.data.toolchainTarget).toBe(cmake);
		expect(lib.data.compiler).toBe(zig.attrs.version);
		expect(lib.data.compilerTarget).toBe(zig);
		expect(lib.data.deps.length).toBe(0);
	});

	test("adds an explicit CMake toolchain target dependency", () => {
		const toolchain = cmakeToolchain("3.31.0");
		const lib = cmakeLib({ src: "build/explicit", toolchain, deps: [] });

		expect(lib.data.toolchain).toBe("3.31.0");
		expect(lib.data.toolchainTarget).toBe(toolchain);
		expect(lib.data.deps.length).toBe(0);
	});

	test("keeps explicit CMake string versions detached from the default target", () => {
		const lib = cmakeLib({
			src: "build/string",
			toolchain: "3.32.0",
			deps: [],
		});

		expect(lib.data.toolchain).toBe("3.32.0");
		expect(lib.data.toolchainTarget ?? null).toBe(null);
		expect(lib.data.deps.length).toBe(0);
	});

	test("CMake project labels preserve declared output artifacts", () => {
		const lib = cmakeLib({
			outputs: ["libhf.a"],
			deps: [],
		});

		expect(lib.__imp_label).toBe(true);
		expect(lib.data.type).toBe("project");
		expect(lib.data.backend).toBe("cmake");
		expect(lib.data.outputs).toEqual(["libhf.a"]);
	});

	test("uses the imported Zig compiler default", () => {
		const lib = cmakeLib({ src: "build/no-compiler", deps: [] });
		const compiler = defaultZigToolchain();

		expect(lib.data.compiler).toBe(compiler.attrs.version);
		expect(lib.data.compilerTarget).toBe(compiler);
		expect(lib.data.deps.length).toBe(0);
	});

	test("adds an explicit Zig compiler target dependency", () => {
		const compiler = zigToolchain("0.16.0");
		const lib = cmakeLib({
			src: "build/explicit-compiler",
			compiler,
			deps: [],
		});

		expect(lib.data.compiler).toBe("0.16.0");
		expect(lib.data.compilerTarget).toBe(compiler);
		expect(lib.data.deps.length).toBe(0);
	});

	test("keeps explicit compiler string versions detached from the default target", () => {
		const lib = cmakeLib({
			src: "build/compiler-string",
			compiler: "0.16.1",
			deps: [],
		});

		expect(lib.data.compiler).toBe("0.16.1");
		expect(lib.data.compilerTarget ?? null).toBe(null);
		expect(lib.data.deps.length).toBe(0);
	});

	test("uses the default CMake toolchain target", () => {
		const toolchain = cmakeToolchain("3.30.5", { default: true });
		const lib = cmakeLib({ src: "build/default-tool", deps: [] });

		expect(lib.data.toolchain).toBe("3.30.5");
		expect(lib.data.toolchainTarget).toBe(toolchain);
		expect(lib.data.deps.length).toBe(0);
	});

	test("uses the default Zig compiler target", () => {
		const compiler = zigToolchain("0.16.2", { default: true });
		const lib = cmakeLib({ src: "build/default-compiler", deps: [] });

		expect(lib.data.compiler).toBe("0.16.2");
		expect(lib.data.compilerTarget).toBe(compiler);
		expect(lib.data.deps.length).toBe(0);
	});

	test("wires both a CMake toolchain and a Zig compiler together", () => {
		const toolchain = cmakeToolchain("3.31.1");
		const compiler = zigToolchain("0.16.3");
		const lib = cmakeLib({ src: "build/both", toolchain, compiler, deps: [] });

		expect(lib.data.toolchain).toBe("3.31.1");
		expect(lib.data.compiler).toBe("0.16.3");
		expect(lib.data.deps.length).toBe(0);
	});

	test("omits ctestArgs by default", () => {
		const lib = cmakeLib({ src: "build/no-ctest-args", deps: [] });

		expect(lib.data.ctestArgs ?? null).toBe(null);
	});

	test("plumbs ctestArgs through to label data", () => {
		const lib = cmakeLib({
			src: "build/ctest-args",
			ctestArgs: ["-R", "some_test", "-V"],
			deps: [],
		});

		expect(lib.data.ctestArgs).toEqual(["-R", "some_test", "-V"]);
	});
});
