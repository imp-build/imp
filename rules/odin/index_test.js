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
    imports,
    inferred_deps,
    effective_deps,
    collection_flags,
    resources as odinResources,
    generateBuild,
    odinGenerateBuild,
    tool,
    odinBuild,
} from "//rules/odin";
import {
    resourcePackage,
} from "//rules/asset";
import {
    target,
    hydrateTarget,
    gatherTransitiveClosure,
    glob,
    paths,
    resetMemoState,
    getMemoTrace,
    setIntrospectMode,
    configure,
} from "imp:core";

describe("Odin rules", () => {
test("uses the default Odin toolchain target", () => {
    const toolchain = odinToolchain("dev-2026-03", { default: true });
    const pkg = odinPackage({ srcs: ["**/*.odin"] });

    expect(pkg.attrs.toolchain).toBe(toolchain);
    expect(pkg.attrs.toolchain.attrs.version).toBe("dev-2026-03");
});

test("keeps explicit string versions free of toolchain target deps", () => {
    const pkg = odinPackage({ srcs: ["**/*.odin"], toolchain: "dev-2026-04" });

    expect(pkg.attrs.toolchainVersion).toBe("dev-2026-04");
    expect(pkg.attrs.toolchain).toBe(undefined);
});

test("declares collections as namespace mappings", () => {
    const collection = odinCollection({ name: "lib", path: "library" });

    expect(collection.attrs.name).toBe("lib");
    expect(collection.attrs.path).toBe("library");
});

test("packages depend on collection config without collection membership", () => {
    const root = odinCollection({ name: "root", path: "." });
    const lib = odinCollection({ name: "lib", path: "library" });
    const pkg = odinPackage({
        srcs: ["**/*.odin"],
        toolchain: "dev-2026-04",
        collections: [root, lib],
    });

    expect((pkg.attrs.collections || []).length).toBe(2);
});

test("hydrateTarget returns kind, attrs, and dep handles", () => {
    const pkg = odinPackage({ srcs: ["rules/odin/index.js"], toolchain: "dev-2026-04" });
    const hydrated = hydrateTarget(pkg);

    expect(hydrated.kind).toBe("odin-package");
    expect(Array.isArray(hydrated.attrs.srcs)).toBeTruthy();
    expect(Array.isArray(hydrated.deps)).toBeTruthy();
});

test("gatherTransitiveClosure finds all odin-package targets", () => {
    const lib = odinPackage({ srcs: ["rules/odin/index.js"], toolchain: "dev-2026-04" });
    const app = odinPackage({ srcs: ["rules/odin/index_test.js"], toolchain: "dev-2026-04", deps: [lib] });
    const closure = gatherTransitiveClosure(app, "odin-package");

    expect(closure.length).toBe(2);
});

test("own_sources(pkg) returns a FileSet descriptor", async () => {
    const pkg = odinPackage({ srcs: ["**/*.odin"], toolchain: "dev-2026-04" });
    const fs = await own_sources(pkg);
    expect(fs.__fileset).toBe(true);
    expect(fs.kind).toBe("glob");
});

test("own_sources defaults missing srcs for odin-package targets", async () => {
    const pkg = target({
        kind: "odin-package",
        attrs: { path: "example", toolchainVersion: "dev-2026-04" },
    });
    const result = paths(await own_sources(pkg));
    expect(result).toContain("rules/odin/example/main.odin");
});

test("odinPackage treats empty srcs as the default package sources", async () => {
    const pkg = odinPackage({ path: "rules/odin/example", srcs: [], toolchain: "dev-2026-04" });
    const result = paths(await own_sources(pkg));
    expect(result).toContain("rules/odin/example/main.odin");
});

test("sources(pkg) with no deps returns a FileSet", async () => {
    const pkg = odinPackage({ srcs: ["**/*.odin"], toolchain: "dev-2026-04" });
    const fs = await sources(pkg);
    expect(fs.__fileset).toBe(true);
});

test("imports(pkg) scans Odin import declarations", async () => {
    const pkg = odinPackage({ path: "rules/odin/example", toolchain: "dev-2026-04" });
    const result = await imports(pkg);
    expect(result).toContain("core:fmt");
});

test("sources(app) with a dep includes transitive files", async () => {
    const lib = odinPackage({ srcs: ["rules/odin/index.js"], toolchain: "dev-2026-04" });
    const app = odinPackage({ srcs: ["rules/odin/index_test.js"], toolchain: "dev-2026-04", deps: [lib] });
    const result = paths(await sources(app));
    expect(result).toContain("rules/odin/index.js");
    expect(result).toContain("rules/odin/index_test.js");
});

test("resources(app) with a resource dep includes resource files", async () => {
    const fonts = resourcePackage({ path: "rules/odin", srcs: ["toolchain.js"] });
    const app = odinPackage({ srcs: ["rules/odin/index.js"], toolchain: "dev-2026-04", deps: [fonts] });
    const result = paths(await odinResources(app));
    expect(result).toContain("rules/odin/toolchain.js");
});

test("sources(app) does not include resource package files", async () => {
    const fonts = resourcePackage({ path: "rules/odin", srcs: ["toolchain.js"] });
    const app = odinPackage({ srcs: ["rules/odin/index.js"], toolchain: "dev-2026-04", deps: [fonts] });
    const result = paths(await sources(app));
    expect(result).not.toContain("rules/odin/toolchain.js");
});

test("resources(app) includes resource deps from transitive Odin deps", async () => {
    const fonts = resourcePackage({ path: "rules/odin", srcs: ["toolchain.js"] });
    const lib = odinPackage({ srcs: ["rules/odin/index.js"], toolchain: "dev-2026-04", deps: [fonts] });
    const app = odinPackage({ srcs: ["rules/odin/index_test.js"], toolchain: "dev-2026-04", deps: [lib] });
    const result = paths(await odinResources(app));
    expect(result).toContain("rules/odin/toolchain.js");
});

test("odinBuild declares resource package files as sandbox inputs", async () => {
    resetMemoState();
    setIntrospectMode(true);
    try {
        const fonts = resourcePackage({ path: "rules/odin", srcs: ["toolchain.js"] });
        const app = odinPackage({ srcs: ["rules/odin/index.js"], toolchain: "dev-2026-04", deps: [fonts] });
        await odinBuild(app);
        const { trace } = getMemoTrace();
        const runEffect = trace.find(t => t.event === "effect" && t.kind === "run" && t.display === "odin build .");
        expect(runEffect.inputs.some(input => input.path === "rules/odin/toolchain.js")).toBe(true);
    } finally {
        setIntrospectMode(false);
    }
});

test("repeated sources() calls are memoized", async () => {
    resetMemoState();
    const pkg = odinPackage({ srcs: ["**/*.odin"], toolchain: "dev-2026-04" });
    const a = await sources(pkg);
    const b = await sources(pkg);
    expect(a).toBe(b);
});

test("tool is exported as a function", () => {
    expect(typeof tool).toBe("function");
});

test("odinBuild product is exported as a function", () => {
    expect(typeof odinBuild).toBe("function");
});

test("dependency inference helpers are exported as functions", () => {
    expect(typeof inferred_deps).toBe("function");
    expect(typeof effective_deps).toBe("function");
});

test("generateBuild product is exported as a function", () => {
    expect(typeof generateBuild).toBe("function");
});

test("odinGenerateBuild declares a generator target", () => {
    const generator = odinGenerateBuild({ root: "src" });
    expect(generator.kind).toBe("odin-build-generator");
    expect(generator.attrs.root).toBe("src");
});

test("collection_flags(pkg) returns flags for all collection deps", async () => {
    configure("odin", null);
    const root = odinCollection({ name: "root", path: "." });
    const lib = odinCollection({ name: "lib", path: "library" });
    const pkg = odinPackage({ srcs: ["**/*.odin"], toolchain: "dev-2026-04", collections: [root, lib] });
    const flags = await collection_flags(pkg);
    expect(flags).toEqual(["-collection:root=.", "-collection:lib=library"]);
});

test("collection_flags(pkg) reads workspace Odin collection config", async () => {
    configure("odin", null);
    configure("odin", {
        collections: {
            root: ".",
            lib: "library",
        },
    });
    const pkg = odinPackage({ srcs: ["**/*.odin"], toolchain: "dev-2026-04" });
    const flags = await collection_flags(pkg);
    expect(flags).toEqual(["-collection:root=.", "-collection:lib=library"]);
});

test("package collections extend workspace Odin collection config", async () => {
    configure("odin", null);
    configure("odin", { collections: { lib: "library" } });
    const pkg = odinPackage({
        srcs: ["**/*.odin"],
        toolchain: "dev-2026-04",
        collections: { vendor: "vendor/odin" },
    });
    const flags = await collection_flags(pkg);
    expect(flags).toEqual(["-collection:lib=library", "-collection:vendor=vendor/odin"]);
});

});
