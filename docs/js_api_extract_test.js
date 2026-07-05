import {
    describe,
    expect,
    test,
} from "//rules/imp/test";
import {
    parseDocBlock,
    parseModule,
    directoryForSourcePath,
    outputSlugForDirectory,
    fileHeading,
    renderDirectoryPage,
    extractDirectoryDoc,
} from "//docs/js_api_extract";

describe("js_api_extract", () => {

test("parses a @param/@returns doc block", () => {
    const doc = parseDocBlock([
        "Wrap a thing.",
        "",
        "@param {string} name The thing's name.",
        "@returns {object} The wrapped thing.",
    ]);
    expect(doc.summary).toBe("Wrap a thing.");
    expect(doc.params.length).toBe(1);
    expect(doc.params[0].name).toBe("name");
    expect(doc.params[0].type).toBe("string");
    expect(doc.params[0].description).toBe("The thing's name.");
    expect(doc.returns.type).toBe("object");
    expect(doc.returns.description).toBe("The wrapped thing.");
});

test("parses a @returns tag with a type but no trailing description", () => {
    const doc = parseDocBlock(["@returns {function}"]);
    expect(doc.returns.type).toBe("function");
    expect(doc.returns.description).toBe("");
});

test("attaches the nearest preceding doc comment to export function", () => {
    const src = [
        "/**",
        " * Add two numbers.",
        " *",
        " * @param {number} a First operand.",
        " * @param {number} b Second operand.",
        " * @returns {number} The sum.",
        " */",
        "export function add(a, b) {",
        "    return a + b;",
        "}",
    ].join("\n");

    const entries = parseModule(src);
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe("add");
    expect(entries[0].kind).toBe("function");
    expect(entries[0].params).toBe("a, b");
    expect(entries[0].doc.summary).toBe("Add two numbers.");
    expect(entries[0].doc.params.length).toBe(2);
    expect(entries[0].doc.returns.description).toBe("The sum.");
});

test("tolerates blank lines between a doc comment and its export", () => {
    const src = [
        "/**",
        " * Documented after blank lines.",
        " */",
        "",
        "",
        "export function later() {}",
    ].join("\n");

    const entries = parseModule(src);
    expect(entries.length).toBe(1);
    expect(entries[0].doc.summary).toBe("Documented after blank lines.");
});

test("does not attach a doc comment across an intervening code line", () => {
    const src = [
        "/**",
        " * This belongs to helper, not exported.",
        " */",
        "function helper() {}",
        "",
        "export function exported() {}",
    ].join("\n");

    const entries = parseModule(src);
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe("exported");
    expect(entries[0].doc).toBe(null);
});

test("reproduces the historical memo()/product() misattachment bug and its fix", () => {
    // Before the fix, memo()'s doc comment sat directly above product()'s own
    // comment, leaving memo() undocumented. This is the corrected ordering:
    // each function's own doc comment sits directly above it.
    const src = [
        "/**",
        " * Register a product.",
        " * @param {string} kind Target kind.",
        " * @returns {function}",
        " */",
        "export function product(kind, name, fn) {",
        "    return memo(fn);",
        "}",
        "",
        "/**",
        " * Memoize an async function.",
        " * @param {function} fn Function to memoize.",
        " * @returns {function}",
        " */",
        "export function memo(fn) {",
        "    return fn;",
        "}",
    ].join("\n");

    const entries = parseModule(src);
    expect(entries.length).toBe(2);
    expect(entries[0].name).toBe("product");
    expect(entries[0].doc.summary).toBe("Register a product.");
    expect(entries[1].name).toBe("memo");
    expect(entries[1].doc.summary).toBe("Memoize an async function.");
});

test("captures export const bindings assigned to product()/memo()", () => {
    const src = [
        "/**",
        " * Build the thing.",
        " * @returns {Promise<object>}",
        " */",
        'export const bundle = product("asset", "build", async function bundle(handle) {',
        "    return run({});",
        "});",
    ].join("\n");

    const entries = parseModule(src);
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe("bundle");
    expect(entries[0].kind).toBe("binding");
    expect(entries[0].doc.summary).toBe("Build the thing.");
});

test("leaves undocumented exports with a null doc", () => {
    const entries = parseModule("export function bare(x) {\n    return x;\n}");
    expect(entries.length).toBe(1);
    expect(entries[0].doc).toBe(null);
});

test("derives the directory a source path lives in", () => {
    expect(directoryForSourcePath("src/imp_core.js")).toBe("src");
    expect(directoryForSourcePath("rules/c/zig/toolchain.js")).toBe("rules/c/zig");
    expect(directoryForSourcePath("rules/asset.js")).toBe("rules");
});

test("derives output slugs from directories", () => {
    expect(outputSlugForDirectory("src")).toBe("core");
    expect(outputSlugForDirectory("rules/c/zig")).toBe("rules-c-zig");
    expect(outputSlugForDirectory("rules")).toBe("rules");
});

test("derives capitalized headings from filenames", () => {
    expect(fileHeading("rules/odin/toolchain.js")).toBe("Toolchain");
    expect(fileHeading("rules/imp/native_tool.js")).toBe("Native Tool");
    expect(fileHeading("rules/c/cmake/index.js")).toBe("Index");
});

test("renders a Markdown page with one heading per file", () => {
    const md = renderDirectoryPage({
        title: "rules-asset",
        sections: [
            {
                heading: "Asset",
                entries: [
                    {
                        name: "asset",
                        params: "{ srcs }",
                        kind: "function",
                        doc: { summary: "Declare an asset.", params: [{ type: "string[]", name: "srcs", description: "Globs." }], returns: null },
                    },
                ],
            },
            {
                heading: "Gen",
                entries: [],
            },
        ],
    });
    expect(md.startsWith('+++\ntitle = "rules-asset"\n+++\n')).toBe(true);
    expect(md).toContain("## Asset");
    expect(md).toContain("### asset");
    expect(md).toContain("Declare an asset.");
    expect(md).toContain("| srcs | string[] | Globs. |");
    // Files with zero documentable entries are omitted entirely.
    expect(md).not.toContain("## Gen");
});

test("returns null for a page where every file has zero documentable entries", () => {
    expect(renderDirectoryPage({ title: "empty", sections: [{ heading: "Build", entries: [] }] })).toBe(null);
});

test("extractDirectoryDoc combines parsing and rendering across a directory's files", () => {
    const files = [
        {
            sourcePath: "rules/odin/index.js",
            sourceText: [
                "/**",
                " * A documented function.",
                " * @returns {void}",
                " */",
                "export function documented() {}",
            ].join("\n"),
        },
        {
            sourcePath: "rules/odin/toolchain.js",
            sourceText: "export function odinBin(version) {}",
        },
    ];

    const result = extractDirectoryDoc("rules/odin", files);
    expect(result.slug).toBe("rules-odin");
    expect(result.entryCount).toBe(2);
    expect(result.markdown).toContain("## Index");
    expect(result.markdown).toContain("### documented");
    expect(result.markdown).toContain("## Toolchain");
    expect(result.markdown).toContain("### odinBin");
});
});
