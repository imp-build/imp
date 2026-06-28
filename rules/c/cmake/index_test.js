import {
    describe,
    expect,
    test,
} from "//rules/imp/test";
import {
    cmakeLib,
    cmakeToolchain,
} from "//rules/c/cmake";

describe("CMake rules", () => {
test("keeps system cmake fallback without a toolchain", () => {
    const lib = cmakeLib({ entrypoint: "build/default", deps: [] });

    expect(lib.attrs.toolchain ?? null).toBe(null);
    expect(lib.attrs.toolchainTarget ?? null).toBe(null);
    expect(lib.attrs.deps ? lib.attrs.deps.length : 0).toBe(0);
});

test("adds an explicit CMake toolchain target dependency", () => {
    const toolchain = cmakeToolchain("3.31.0");
    const lib = cmakeLib({ entrypoint: "build/explicit", toolchain, deps: [] });

    expect(lib.attrs.toolchain).toBe("3.31.0");
    expect(lib.attrs.toolchainTarget).toBe(toolchain);
    expect(lib.attrs.deps.length).toBe(1);
});

test("keeps explicit string versions dependency-free", () => {
    const lib = cmakeLib({ entrypoint: "build/string", toolchain: "3.32.0", deps: [] });

    expect(lib.attrs.toolchain).toBe("3.32.0");
    expect(lib.attrs.toolchainTarget ?? null).toBe(null);
    expect(lib.attrs.deps ? lib.attrs.deps.length : 0).toBe(0);
});

test("uses the default CMake toolchain target", () => {
    const toolchain = cmakeToolchain("3.30.5", { default: true });
    const lib = cmakeLib({ entrypoint: "build/default-tool", deps: [] });

    expect(lib.attrs.toolchain).toBe("3.30.5");
    expect(lib.attrs.toolchainTarget).toBe(toolchain);
    expect(lib.attrs.deps.length).toBe(1);
});
});
