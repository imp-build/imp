import {
    describe,
    expect,
    test,
} from "//rules/imp/test";
import {
    odinCollection,
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

test("declares collections as namespace mappings", () => {
    const collection = odinCollection({ name: "lib", path: "library" });

    expect(collection.name).toBe("lib");
    expect(collection.path).toBe("library");
    expect(collection.flag).toBe("-collection:lib=library");
});

test("packages depend on collection config without collection membership", () => {
    const root = odinCollection({ name: "root", path: "." });
    const lib = odinCollection({ name: "lib", path: "library" });
    const pkg = odinPackage({
        srcs: ["*.odin"],
        toolchain: "dev-2026-04",
        collections: [root, lib],
    });

    expect(pkg.collectionCount).toBe(2);
    expect(pkg.collectionFlags).toEqual([
        "-collection:root=.",
        "-collection:lib=library",
    ]);
    expect(pkg.dependencyCount).toBe(2);
});
});
