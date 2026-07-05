import {
    describe,
    expect,
    test,
} from "//rules/imp/test";
import {
    parseDocBlock,
    parseModule,
    directoryForSourcePath,
    languageForDirectory,
    languageSlug,
    categoryForEntry,
    renderCategoryPage,
    renderLanguageIndexPage,
    extractApiReference,
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

test("parses a @category tag", () => {
    const doc = parseDocBlock(["Declare a thing.", "@category target"]);
    expect(doc.category).toBe("target");
});

test("leaves category null when no @category tag is present", () => {
    const doc = parseDocBlock(["Declare a thing."]);
    expect(doc.category).toBe(null);
});

test("derives sidebar languages from directories", () => {
    expect(languageForDirectory("src")).toBe("Core");
    expect(languageForDirectory("rules")).toBe("Rules");
    expect(languageForDirectory("rules/odin")).toBe("Odin");
    expect(languageForDirectory("rules/c/zig")).toBe("C");
    expect(languageForDirectory("rules/imp/test")).toBe("Imp");
});

test("derives language slugs", () => {
    expect(languageSlug("C")).toBe("c");
    expect(languageSlug("Imp")).toBe("imp");
});

test("categorizes entries from their @category tag, overriding the default", () => {
    expect(categoryForEntry({ doc: { category: "target" } })).toBe("target");
    expect(categoryForEntry({ doc: { category: "configuration" } })).toBe("configuration");
    expect(categoryForEntry({ doc: { category: "bogus" } })).toBe("api");
});

test("untagged entries default to api, since they're exported", () => {
    expect(categoryForEntry({ doc: null })).toBe("api");
    expect(categoryForEntry({ doc: { category: null } })).toBe("api");
});

test("renders a category page with Zola frontmatter and a weight", () => {
    const md = renderCategoryPage({
        language: "Odin",
        category: "target",
        entries: [
            {
                name: "odinPackage",
                params: "opts",
                kind: "function",
                doc: { summary: "Declare an Odin package.", params: [], returns: null },
            },
        ],
    });
    expect(md).toContain('title = "Targets"');
    expect(md).toContain("weight = 20");
    expect(md).toContain('language = "Odin"');
    expect(md).toContain("### odinPackage");
    expect(md).toContain("Declare an Odin package.");
});

test("renders a language index page pointing at section.html", () => {
    const md = renderLanguageIndexPage("Odin");
    expect(md).toContain('title = "Odin"');
    expect(md).toContain('sort_by = "weight"');
    expect(md).toContain('template = "section.html"');
    expect(md).toContain('language = "Odin"');
});

test("extractApiReference groups entries by language then category across files", () => {
    const files = [
        {
            sourcePath: "rules/odin/index.js",
            sourceText: [
                "/**",
                " * Declare an Odin package.",
                " * @category target",
                " */",
                "export function odinPackage(opts) {}",
                "",
                "/**",
                " * Build the package.",
                " */",
                'export const odinBuild = product("odin-package", "build", async function odinBuild(handle) {});',
            ].join("\n"),
        },
        {
            sourcePath: "rules/odin/toolchain.js",
            sourceText: [
                "/**",
                " * Declare an Odin toolchain.",
                " * @category configuration",
                " */",
                "export function odinToolchain(version) {}",
            ].join("\n"),
        },
        {
            sourcePath: "rules/asset.js",
            sourceText: "export function asset(opts) {}",
        },
    ];

    const pages = extractApiReference(files);
    const byPath = new Map(pages.map(p => [p.path, p.markdown]));

    expect(byPath.has("odin/_index.md")).toBe(true);
    expect(byPath.get("odin/target.md")).toContain("### odinPackage");
    expect(byPath.get("odin/api.md")).toContain("### odinBuild");
    expect(byPath.get("odin/configuration.md")).toContain("### odinToolchain");

    expect(byPath.has("rules/_index.md")).toBe(true);
    // Untagged entries default to the "api" category.
    expect(byPath.get("rules/api.md")).toContain("### asset");
    expect(byPath.has("rules/target.md")).toBe(false);
});
});
