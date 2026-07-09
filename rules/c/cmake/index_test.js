import {
    describe,
    expect,
    test,
} from "//rules/imp/test";
import {
    CmakeLib,
    cmakeLib,
    cmakeToolchain,
} from "//rules/c/cmake";
import { zigToolchain } from "//rules/c/zig/toolchain";

describe("CMake rules", () => {
test("keeps system cmake fallback without a toolchain", () => {
    const lib = cmakeLib({ src: "build/default", deps: [] });

    expect(lib.attrs.toolchain ?? null).toBe(null);
    expect(lib.attrs.toolchainTarget ?? null).toBe(null);
    expect(lib.attrs.deps ? lib.attrs.deps.length : 0).toBe(0);
});

test("adds an explicit CMake toolchain target dependency", () => {
    const toolchain = cmakeToolchain("3.31.0");
    const lib = cmakeLib({ src: "build/explicit", toolchain, deps: [] });

    expect(lib.attrs.toolchain).toBe("3.31.0");
    expect(lib.attrs.toolchainTarget).toBe(toolchain);
    expect(lib.attrs.deps.length).toBe(1);
});

test("keeps explicit string versions dependency-free", () => {
    const lib = cmakeLib({ src: "build/string", toolchain: "3.32.0", deps: [] });

    expect(lib.attrs.toolchain).toBe("3.32.0");
    expect(lib.attrs.toolchainTarget ?? null).toBe(null);
    expect(lib.attrs.deps ? lib.attrs.deps.length : 0).toBe(0);
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

// The following compiler-only tests run before "uses the default CMake
// toolchain target" below, so the module-level default CMake toolchain
// singleton hasn't been set yet — they'd otherwise pick up an extra
// toolchain dependency, since the default toolchain (once set) is global
// and persists across every test in this process.
test("keeps no compiler set without one declared", () => {
    const lib = cmakeLib({ src: "build/no-compiler", deps: [] });

    expect(lib.attrs.compiler ?? null).toBe(null);
    expect(lib.attrs.compilerTarget ?? null).toBe(null);
    expect(lib.attrs.deps ? lib.attrs.deps.length : 0).toBe(0);
});

test("adds an explicit Zig compiler target dependency", () => {
    const compiler = zigToolchain("0.16.0");
    const lib = cmakeLib({ src: "build/explicit-compiler", compiler, deps: [] });

    expect(lib.attrs.compiler).toBe("0.16.0");
    expect(lib.attrs.compilerTarget).toBe(compiler);
    expect(lib.attrs.deps.length).toBe(1);
});

test("keeps explicit compiler string versions dependency-free", () => {
    const lib = cmakeLib({ src: "build/compiler-string", compiler: "0.16.1", deps: [] });

    expect(lib.attrs.compiler).toBe("0.16.1");
    expect(lib.attrs.compilerTarget ?? null).toBe(null);
    expect(lib.attrs.deps ? lib.attrs.deps.length : 0).toBe(0);
});

test("uses the default CMake toolchain target", () => {
    const toolchain = cmakeToolchain("3.30.5", { default: true });
    const lib = cmakeLib({ src: "build/default-tool", deps: [] });

    expect(lib.attrs.toolchain).toBe("3.30.5");
    expect(lib.attrs.toolchainTarget).toBe(toolchain);
    expect(lib.attrs.deps.length).toBe(1);
});

// Runs after the default CMake toolchain is set above, so this cmakeLib()
// call picks up both defaults (CMake toolchain + Zig compiler) — 2 deps.
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
    const lib = cmakeLib({ src: "build/ctest-args", ctestArgs: ["-R", "some_test", "-V"], deps: [] });

    expect(lib.attrs.ctestArgs).toEqual(["-R", "some_test", "-V"]);
});
});
