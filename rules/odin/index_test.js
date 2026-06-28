import {
    describe,
    expect,
    test,
} from "//rules/imp/test";
import {
    odinCollection,
    odinPackage,
    odinToolchain,
    own_sources,
    sources,
} from "//rules/odin";
import {
    hydrateTarget,
    gatherTransitiveClosure,
    glob,
    paths,
    workspaceSourceEntries,
    casTreeStore,
    casTreeGet,
    casTreeMerge,
    resetMemoState,
} from "imp:core";

describe("Odin rules", () => {
test("uses the default Odin toolchain target", () => {
    const toolchain = odinToolchain("dev-2026-03", { default: true });
    const pkg = odinPackage({ srcs: [".*\\.odin$"] });

    expect(pkg.toolchainVersion).toBe("dev-2026-03");
    expect(pkg.toolchainTarget).toBe(toolchain);
    expect(pkg.dependencyCount).toBe(1);
});

test("keeps explicit string versions free of toolchain target deps", () => {
    const pkg = odinPackage({ srcs: [".*\\.odin$"], toolchain: "dev-2026-04" });

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
        srcs: [".*\\.odin$"],
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

test("hydrateTarget returns kind, fields, and dep handles", () => {
    const pkg = odinPackage({ srcs: ["^rules/odin/index\\.js$"], toolchain: "dev-2026-04" });
    const hydrated = hydrateTarget(pkg);

    expect(hydrated.kind).toBe("odin-package");
    expect(typeof hydrated.fields.srcs).toBe("string");
    expect(Array.isArray(hydrated.deps)).toBeTruthy();
});

test("gatherTransitiveClosure finds all odin-package targets", () => {
    const lib = odinPackage({ srcs: ["^rules/odin/index\\.js$"], toolchain: "dev-2026-04" });
    const app = odinPackage({ srcs: ["^rules/odin/index_test\\.js$"], toolchain: "dev-2026-04", deps: [lib] });
    const closure = gatherTransitiveClosure(app, "odin-package");

    expect(closure.length).toBe(2);
});

test("own_sources(pkg) returns a FileSet descriptor", async () => {
    const pkg = odinPackage({ srcs: [".*\\.odin$"], toolchain: "dev-2026-04" });
    const fs = await own_sources(pkg);
    expect(fs.__fileset).toBe(true);
    expect(fs.kind).toBe("glob");
});

test("sources(pkg) with no deps returns a FileSet", async () => {
    const pkg = odinPackage({ srcs: [".*\\.odin$"], toolchain: "dev-2026-04" });
    const fs = await sources(pkg);
    expect(fs.__fileset).toBe(true);
});

test("sources(app) with a dep includes transitive files", async () => {
    const lib = odinPackage({ srcs: ["^rules/odin/index\\.js$"], toolchain: "dev-2026-04" });
    const app = odinPackage({ srcs: ["^rules/odin/index_test\\.js$"], toolchain: "dev-2026-04", deps: [lib] });
    const result = paths(await sources(app));
    expect(result).toContain("rules/odin/index.js");
    expect(result).toContain("rules/odin/index_test.js");
});

test("repeated sources() calls are memoized", async () => {
    resetMemoState();
    const pkg = odinPackage({ srcs: [".*\\.odin$"], toolchain: "dev-2026-04" });
    const a = await sources(pkg);
    const b = await sources(pkg);
    expect(a).toBe(b);
});

test("casTreeStore round-trips through casTreeGet", () => {
    const entries = workspaceSourceEntries({ include: ["^rules/odin/index\\.js$"] });
    const digest = casTreeStore(entries);
    const result = casTreeGet(digest);

    expect(result.length).toBe(1);
    expect(result[0].path).toBe("rules/odin/index.js");
    expect(typeof result[0].digest).toBe("string");
});

test("casTreeMerge combines disjoint trees", () => {
    const a = casTreeStore(workspaceSourceEntries({ include: ["^rules/odin/index\\.js$"] }));
    const b = casTreeStore(workspaceSourceEntries({ include: ["^rules/odin/index_test\\.js$"] }));
    const merged = casTreeMerge(a, b);
    const entries = casTreeGet(merged);

    expect(entries.length).toBe(2);
    expect(entries[0].path).toBe("rules/odin/index.js");
    expect(entries[1].path).toBe("rules/odin/index_test.js");
});
});
