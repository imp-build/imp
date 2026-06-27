import {
    describe,
    expect,
    test,
} from "//rules/imp/test";
import {
    odinPackage,
    odinToolchain,
} from "//rules/odin";

describe("Odin rules", () => {
test("uses the default Odin toolchain target", () => {
    const toolchain = odinToolchain("dev-2026-03", { default: true });
    const pkg = odinPackage({ srcs: ["*.odin"] });

    expect(pkg.toolchainVersion).toBe("dev-2026-03");
    expect(pkg.toolchainTarget).toBe(toolchain);
    expect(pkg.dependencyCount).toBe(1);
});

test("keeps explicit string versions dependency-free", () => {
    const pkg = odinPackage({ srcs: ["*.odin"], toolchain: "dev-2026-04" });

    expect(pkg.toolchainVersion).toBe("dev-2026-04");
    expect(pkg.toolchainTarget).toBe(null);
    expect(pkg.dependencyCount).toBe(0);
});
});
