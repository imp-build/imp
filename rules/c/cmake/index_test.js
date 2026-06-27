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

    expect(lib.toolchainVersion).toBe(null);
    expect(lib.toolchainTarget).toBe(null);
    expect(lib.dependencyCount).toBe(0);
});

test("adds an explicit CMake toolchain target dependency", () => {
    const toolchain = cmakeToolchain("3.31.0");
    const lib = cmakeLib({ entrypoint: "build/explicit", toolchain, deps: [] });

    expect(lib.toolchainVersion).toBe("3.31.0");
    expect(lib.toolchainTarget).toBe(toolchain);
    expect(lib.dependencyCount).toBe(1);
});

test("keeps explicit string versions dependency-free", () => {
    const lib = cmakeLib({ entrypoint: "build/string", toolchain: "3.32.0", deps: [] });

    expect(lib.toolchainVersion).toBe("3.32.0");
    expect(lib.toolchainTarget).toBe(null);
    expect(lib.dependencyCount).toBe(0);
});

test("uses the default CMake toolchain target", () => {
    const toolchain = cmakeToolchain("3.30.5", { default: true });
    const lib = cmakeLib({ entrypoint: "build/default-tool", deps: [] });

    expect(lib.toolchainVersion).toBe("3.30.5");
    expect(lib.toolchainTarget).toBe(toolchain);
    expect(lib.dependencyCount).toBe(1);
});
});
