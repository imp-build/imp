import {
    describe,
    expect,
    test,
} from "//rules/imp/test";
import {
    odinCollection,
    odinPackage,
    odinTestPackage,
    odinToolchain,
    own_sources,
    sources,
    imports,
    odinPackageAnalysis,
    inferred_deps,
    effective_deps,
    collection_flags,
    collection_dirs,
    resources as odinResources,
    generateBuild,
    odinGenerateBuild,
    tool,
    odinBuild,
    odinTest,
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
        attrs: { path: "rules/odin/example", toolchainVersion: "dev-2026-04" },
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

test("odinPackageAnalysis(pkg) reports imports, collections, and main entrypoint", async () => {
    const pkg = odinPackage({ path: "rules/odin/example", toolchain: "dev-2026-04" });
    const analysis = await odinPackageAnalysis(pkg);
    expect(analysis.sourceFiles).toContain("rules/odin/example/main.odin");
    expect(analysis.packagePath).toBe("rules/odin/example");
    expect(analysis.imports).toContain("core:fmt");
    expect(analysis.collections).toContain("core");
    expect(analysis.hasMainEntrypoint).toBe(true);
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
        const app = odinPackage({ srcs: ["rules/odin/index.js"], toolchain: "dev-2026-04", output: "build/odin/target", deps: [fonts] });
        await odinBuild(app);
        const { trace } = getMemoTrace();
        const runEffect = trace.find(t => t.event === "effect" && t.kind === "run" && t.display === "odin build rules/odin");
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

test("odinTest product is exported as a function", () => {
    expect(typeof odinTest).toBe("function");
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
    // Workspace config round-trips through serde_json, whose objects sort keys,
    // so config-derived collections come out alphabetically (lib before root).
    expect(flags).toEqual(["-collection:lib=library", "-collection:root=."]);
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

test("collection_dirs(pkg) returns non-root collection directories once", async () => {
    configure("odin", null);
    configure("odin", {
        collections: {
            root: ".",
            lib: "library",
            libAlias: { path: "library" },
        },
    });
    const pkg = odinPackage({ srcs: ["**/*.odin"], toolchain: "dev-2026-04" });
    const dirs = await collection_dirs(pkg);
    expect(dirs).toEqual(["library"]);
});

test("odinBuild materializes collection directories before invoking Odin", async () => {
    resetMemoState();
    configure("odin", null);
    configure("odin", { collections: { root: ".", lib: "library" } });
    setIntrospectMode(true);
    try {
        const app = odinPackage({ srcs: ["rules/odin/index.js"], toolchain: "dev-2026-04", output: "build/odin/target" });
        await odinBuild(app);
        const { trace } = getMemoTrace();
        const runEffect = trace.find(t => t.event === "effect" && t.kind === "run" && t.display === "odin build rules/odin");
        expect(runEffect.argv[6]).toBe("1");
        expect(runEffect.argv[7]).toBe("library");
        // Config-derived collection flags are alphabetical (lib before root).
        expect(runEffect.argv[8]).toBe("-collection:lib=library");
        expect(runEffect.argv).toContain("-collection:root=.");
        expect(runEffect.inputs.some(input => input.kind === "directory")).toBe(false);
    } finally {
        setIntrospectMode(false);
        configure("odin", null);
    }
});

test("odinBuild uses library build mode when package has no main entrypoint", async () => {
    resetMemoState();
    configure("odin", null);
    setIntrospectMode(true);
    try {
        const lib = odinPackage({ srcs: ["rules/odin/index.js"], toolchain: "dev-2026-04", output: "build/odin/target" });
        await odinBuild(lib);
        const { trace } = getMemoTrace();
        const runEffect = trace.find(t => t.event === "effect" && t.kind === "run" && t.display === "odin build rules/odin");
        expect(runEffect.argv).toContain("-build-mode:lib");
        expect(runEffect.outputs).toEqual([{ kind: "file", path: "build/odin/target.a" }]);
    } finally {
        setIntrospectMode(false);
        configure("odin", null);
    }
});

test("odinBuild rejects packages with no source files after excludes", async () => {
    resetMemoState();
    configure("odin", null);
    const pkg = odinPackage({ path: "rules/odin", srcs: ["missing*.odin"], toolchain: "dev-2026-04" });
    let message = "";
    try {
        await odinBuild(pkg);
    } catch (error) {
        message = error && error.message ? error.message : String(error);
    }
    expect(message).toContain("has no Odin source files");
    expect(message).toContain("exclude: []");
});

test("odinBuild uses the single source directory when it differs from target path", async () => {
    resetMemoState();
    configure("odin", null);
    setIntrospectMode(true);
    try {
        const pkg = odinPackage({ path: "rules/odin", srcs: ["example/*.odin"], toolchain: "dev-2026-04", output: "build/odin/target" });
        await odinBuild(pkg);
        const { trace } = getMemoTrace();
        const runEffect = trace.find(t => t.event === "effect" && t.kind === "run" && t.display === "odin build rules/odin/example");
        expect(runEffect.argv).toContain("rules/odin/example");
        expect(runEffect.inputs.some(input => input.path === "rules/odin/example/main.odin")).toBe(true);
    } finally {
        setIntrospectMode(false);
        configure("odin", null);
    }
});

test("odinBuild does not use library build mode when package has a main entrypoint", async () => {
    resetMemoState();
    configure("odin", null);
    setIntrospectMode(true);
    try {
        const app = odinPackage({ path: "rules/odin/example", toolchain: "dev-2026-04", output: "build/odin/target" });
        await odinBuild(app);
        const { trace } = getMemoTrace();
        const runEffect = trace.find(t => t.event === "effect" && t.kind === "run" && t.display === "odin build rules/odin/example");
        expect(runEffect.argv).not.toContain("-build-mode:lib");
        expect(runEffect.outputs).toEqual([{ kind: "file", path: "build/odin/target" }]);
    } finally {
        setIntrospectMode(false);
        configure("odin", null);
    }
});

test("odinTestPackage declares an Odin test target", () => {
    const pkg = odinTestPackage({ path: "rules/odin/example", toolchain: "dev-2026-04" });
    expect(pkg.kind).toBe("odin-test-package");
    expect(pkg.attrs.path).toBe("rules/odin/example");
    expect(pkg.attrs.exclude).toBe(undefined);
});

test("odinTest runs odin test with package sources", async () => {
    resetMemoState();
    configure("odin", null);
    setIntrospectMode(true);
    try {
        const pkg = odinTestPackage({ path: "rules/odin/example", toolchain: "dev-2026-04" });
        await odinTest(pkg);
        const { trace } = getMemoTrace();
        const runEffect = trace.find(t => t.event === "effect" && t.kind === "run" && t.display === "odin test rules/odin/example");
        expect(runEffect.argv).toContain("rules/odin/example");
        expect(runEffect.argv[2]).toContain("odin test");
        expect(runEffect.inputs.some(input => input.path === "rules/odin/example/main.odin")).toBe(true);
        expect(runEffect.impure).toBe(true);
    } finally {
        setIntrospectMode(false);
        configure("odin", null);
    }
});

});
