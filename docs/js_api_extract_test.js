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
    isUserApiEntry,
    modulePagePath,
    renderLanguagePage,
    extractApiReference,
    extractCodeReference,
    extractUserApiReference,
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

test("parses a @param with a nested-brace object-literal type", () => {
    const doc = parseDocBlock(["@param {{ os: string, arch: string }} plat"]);
    expect(doc.params.length).toBe(1);
    expect(doc.params[0].type).toBe("{ os: string, arch: string }");
    expect(doc.params[0].name).toBe("plat");
    expect(doc.params[0].description).toBe("");
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
    expect(entries[0].kind).toBe("const");
    expect(entries[0].doc.summary).toBe("Build the thing.");
});

test("captures exported classes and ordinary const bindings for code docs", () => {
    const entries = parseModule([
        "/** A target class. */",
        "export class Thing extends Target {",
        "}",
        "",
        "/** A constant. */",
        "export const VALUE = 1;",
    ].join("\n"));

    expect(entries.length).toBe(2);
    expect(entries[0].name).toBe("Thing");
    expect(entries[0].kind).toBe("class");
    expect(entries[0].doc.summary).toBe("A target class.");
    expect(entries[1].name).toBe("VALUE");
    expect(entries[1].kind).toBe("const");
    expect(entries[1].doc.summary).toBe("A constant.");
});

test("leaves undocumented exports with a null doc", () => {
    const entries = parseModule("export function bare(x) {\n    return x;\n}");
    expect(entries.length).toBe(1);
    expect(entries[0].doc).toBe(null);
});

test("skips internal double-underscore exports", () => {
    const entries = parseModule([
        "/** Test-only reset hook. */",
        "export function __resetForTest() {}",
        "",
        "export function publicApi() {}",
    ].join("\n"));
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe("publicApi");
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

test("user API entries are explicitly target or configuration tagged", () => {
    expect(isUserApiEntry({ doc: { category: "target" } })).toBe(true);
    expect(isUserApiEntry({ doc: { category: "configuration" } })).toBe(true);
    expect(isUserApiEntry({ doc: { category: "api" } })).toBe(false);
    expect(isUserApiEntry({ doc: null })).toBe(false);
});

test("renders a language page with frontmatter and category headings in CATEGORY_ORDER", () => {
    const byCategory = new Map([
        ["target", [
            {
                name: "odinPackage",
                params: "opts",
                kind: "function",
                doc: { summary: "Declare an Odin package.", params: [], returns: null },
            },
        ]],
        ["configuration", [
            { name: "odinToolchain", params: "version", kind: "function", doc: null },
        ]],
    ]);

    const md = renderLanguagePage("Odin", byCategory);
    expect(md).toContain('title = "Odin"');
    expect(md).toContain("## Configuration");
    expect(md).toContain("## Targets");
    expect(md).toContain("### odinToolchain");
    expect(md).toContain("### odinPackage");
    expect(md).toContain("Declare an Odin package.");
    expect(md.indexOf("## Configuration") < md.indexOf("## Targets")).toBeTruthy();
});

test("modulePagePath creates flat deterministic page paths", () => {
    expect(modulePagePath("src/imp_core.js")).toBe("src-imp-core.md");
    expect(modulePagePath("rules/odin/toolchain.js")).toBe("rules-odin-toolchain.md");
});

test("extractCodeReference emits one page per source module with every export", () => {
    const pages = extractCodeReference([
        {
            sourcePath: "rules/odin/index.js",
            sourceText: [
                "/**",
                " * Declare an Odin package.",
                " * @category target",
                " */",
                "export function odinPackage(opts) {}",
                "",
                'export const odinBuild = product("odin-package", "build", async function odinBuild(handle) {});',
                "",
                "export class OdinPackage extends Target {}",
            ].join("\n"),
        },
    ]);

    expect(pages.length).toBe(1);
    expect(pages[0].path).toBe("rules-odin-index.md");
    expect(pages[0].markdown).toContain('title = "rules/odin/index.js"');
    expect(pages[0].markdown).toContain("### odinPackage");
    expect(pages[0].markdown).toContain("### odinBuild");
    expect(pages[0].markdown).toContain("_Undocumented._");
    expect(pages[0].markdown).toContain("### OdinPackage");
});

test("extractUserApiReference emits curated language pages for target/configuration entries only", () => {
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

    const pages = extractUserApiReference(files);
    const byPath = new Map(pages.map(p => [p.path, p.markdown]));

    expect(byPath.has("odin.md")).toBe(true);
    const odin = byPath.get("odin.md");
    expect(odin).toContain("## Configuration");
    expect(odin).toContain("### odinToolchain");
    expect(odin).toContain("## Targets");
    expect(odin).toContain("### odinPackage");
    expect(odin).not.toContain("## API");
    expect(odin).not.toContain("### odinBuild");
    // Configuration comes before Targets, which comes before API.
    expect(odin.indexOf("## Configuration") < odin.indexOf("## Targets")).toBeTruthy();

    expect(byPath.has("rules.md")).toBe(false);
});

test("extractApiReference is the exhaustive code-reference compatibility wrapper", () => {
    const pages = extractApiReference([
        {
            sourcePath: "rules/asset.js",
            sourceText: "export function asset(opts) {}",
        },
    ]);

    expect(pages.length).toBe(1);
    expect(pages[0].path).toBe("rules-asset.md");
    expect(pages[0].markdown).toContain("### asset");
});
});
