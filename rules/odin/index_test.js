import {
    describe,
    expect,
    test,
} from "//rules/imp/test";
import {
    merge,
    odinCollection,
    odinPackage,
    odinToolchain,
    readSources,
} from "//rules/odin";
import { hydrateTarget, gatherTransitiveClosure, casTreeStore, casTreeGet, casTreeMerge } from "imp:core";

describe("Odin rules", () => {
test("uses the default Odin toolchain target", () => {
    const toolchain = odinToolchain("dev-2026-03", { default: true });
    const pkg = odinPackage({ srcs: [".*\\.odin$"] });

    expect(pkg.toolchainVersion).toBe("dev-2026-03");
    expect(pkg.toolchainTarget).toBe(toolchain);
    expect(pkg.dependencyCount).toBe(2);
});

test("keeps explicit string versions free of toolchain target deps", () => {
    const pkg = odinPackage({ srcs: [".*\\.odin$"], toolchain: "dev-2026-04" });

    expect(pkg.toolchainVersion).toBe("dev-2026-04");
    expect(pkg.toolchainTarget).toBe(null);
    expect(pkg.dependencyCount).toBe(1);
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
    expect(pkg.dependencyCount).toBe(3);
});

test("readSources captures matching files into a manifest", () => {
    const sources = readSources({
        include: ["^rules/odin/index\\.js$"],
    });
    const manifest = JSON.parse(sources.sourceManifestValue);

    expect(sources.files).toEqual(["rules/odin/index.js"]);
    expect(manifest.files).toEqual(["rules/odin/index.js"]);
    expect(manifest.cas[0].path).toBe("rules/odin/index.js");
    expect(typeof manifest.cas[0].digest).toBe("string");
    expect(manifest.cas[0].bytes > 0).toBeTruthy();
    expect(sources.sourceManifest).toContain(".imp/sources/");
});

test("merge combines disjoint source artifacts into one", () => {
    const a = readSources({ include: ["^rules/odin/index\\.js$"] });
    const b = readSources({ include: ["^rules/odin/index_test\\.js$"] });
    const merged = merge(a, b);
    const manifest = JSON.parse(merged.sourceManifestValue);

    expect(merged.files).toEqual(["rules/odin/index.js", "rules/odin/index_test.js"]);
    expect(manifest.merged).toEqual([a.sourceManifest, b.sourceManifest]);
    expect(manifest.cas.length).toBe(2);
    expect(merged.sourceManifest).toContain(".imp/sources/");
});

test("merge sorts paths lexicographically regardless of input order", () => {
    const a = readSources({ include: ["^rules/odin/index_test\\.js$"] });
    const b = readSources({ include: ["^rules/odin/index\\.js$"] });
    const merged = merge(a, b);

    expect(merged.files).toEqual(["rules/odin/index.js", "rules/odin/index_test.js"]);
});

test("merge deduplicates identical paths silently", () => {
    const a = readSources({ include: ["^rules/odin/index\\.js$"] });
    const b = readSources({ include: ["^rules/odin/index\\.js$"] });
    const merged = merge(a, b);

    expect(merged.files).toEqual(["rules/odin/index.js"]);
    expect(merged.cas.length).toBe(1);
});

test("merge throws on same path with different content", () => {
    const a = readSources({ include: ["^rules/odin/index\\.js$"] });
    const b = { cas: [{ path: "rules/odin/index.js", digest: "deadbeef", bytes: 1 }], files: ["rules/odin/index.js"], sourceManifest: "fake", sourceManifestValue: "{}" };

    expect(() => merge(a, b)).toThrow("conflicting content for path 'rules/odin/index.js'");
});

test("hydrateTarget returns kind, fields, and dep handles", () => {
    const sources = readSources({ include: ["^rules/odin/index\\.js$"] });
    const pkg = odinPackage({ sources, toolchain: "dev-2026-04" });
    const hydrated = hydrateTarget(pkg);

    expect(hydrated.kind).toBe("odin-package");
    expect(typeof hydrated.fields.sourceManifest).toBe("string");
    expect(Array.isArray(hydrated.deps)).toBeTruthy();
    expect(hydrated.deps.length > 0).toBeTruthy();
});

test("gatherTransitiveClosure finds all odin-package targets", () => {
    const lib = odinPackage({ srcs: ["^rules/odin/index\\.js$"], toolchain: "dev-2026-04" });
    const app = odinPackage({ srcs: ["^rules/odin/index_test\\.js$"], toolchain: "dev-2026-04", deps: [lib] });
    const closure = gatherTransitiveClosure(app, "odin-package");

    expect(closure.length).toBe(2);
});

test("odinPackage merges transitive sources from deps at build time", () => {
    const lib = odinPackage({ srcs: ["^rules/odin/index\\.js$"], toolchain: "dev-2026-04" });
    const app = odinPackage({ srcs: ["^rules/odin/index_test\\.js$"], toolchain: "dev-2026-04", deps: [lib] });

    expect(app.transitiveSources.files).toEqual([
        "rules/odin/index.js",
        "rules/odin/index_test.js",
    ]);
});

test("casTreeStore round-trips through casTreeGet", () => {
    const sources = readSources({ include: ["^rules/odin/index\\.js$"] });
    const digest = casTreeStore(sources.cas);
    const entries = casTreeGet(digest);

    expect(entries.length).toBe(1);
    expect(entries[0].path).toBe("rules/odin/index.js");
    expect(typeof entries[0].digest).toBe("string");
});

test("casTreeMerge combines disjoint trees", () => {
    const a = casTreeStore(readSources({ include: ["^rules/odin/index\\.js$"] }).cas);
    const b = casTreeStore(readSources({ include: ["^rules/odin/index_test\\.js$"] }).cas);
    const merged = casTreeMerge(a, b);
    const entries = casTreeGet(merged);

    expect(entries.length).toBe(2);
    expect(entries[0].path).toBe("rules/odin/index.js");
    expect(entries[1].path).toBe("rules/odin/index_test.js");
});
});
