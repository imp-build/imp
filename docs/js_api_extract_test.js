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
    sectionSegments,
    categoryForEntry,
    isUserApiEntry,
    modulePageSegments,
    renderLanguagePage,
    renderRuleCapabilities,
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

test("parses and renders configuration fields", () => {
    const doc = parseDocBlock([
        "Odin configuration.",
        "@configField {map<string,string>} collections Collection name to path.",
        "@category configuration",
    ]);
    expect(doc.configFields).toEqual([
        { type: "map<string,string>", name: "collections", description: "Collection name to path." },
    ]);
    const pages = extractUserApiReference([{
        sourcePath: "rules/odin/index.js",
        sourceText: `/**\n * Odin configuration.\n * @configField {map<string,string>} collections Collection name to path.\n * @category configuration\n */\nexport const odinConfigSchema = {};`,
    }]);
    expect(pages[0].markdown).toContain("**Configuration options**");
    expect(pages[0].markdown).toContain("| collections | map<string,string> | Collection name to path. |");
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

test("derives full doc-tree section segments from a directory, preserving nesting", () => {
    expect(sectionSegments("src")).toEqual(["core"]);
    expect(sectionSegments("rules")).toEqual(["rules"]);
    expect(sectionSegments("rules/odin")).toEqual(["odin"]);
    expect(sectionSegments("rules/c/zig")).toEqual(["c", "zig"]);
    expect(sectionSegments("rules/imp/test")).toEqual(["imp", "test"]);
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

    const md = renderLanguagePage("Odin", byCategory, {
        odin: {
            collections: {
                __impField: "map",
                key: { __impField: "string" },
                value: { __impField: "string" },
                default: {},
            },
        },
    });
    expect(md).toContain('title = "Odin"');
    expect(md).toContain("## Configuration");
    expect(md).toContain("## Targets");
    expect(md).toContain("### odinToolchain");
    expect(md).toContain("### odinPackage");
    expect(md).toContain("Declare an Odin package.");
    expect(md).toContain("| collections | map<string, string> | `{}` | no |");
    expect(md).toContain("export const odinConfig = {");
    expect(md).toContain("    collections: {},");
    expect(md).not.toContain("### odin configuration schema");
    expect(md.indexOf("## Configuration") < md.indexOf("## Targets")).toBeTruthy();
});

test("renders capabilities by goal and directory-derived tool", () => {
    const md = renderRuleCapabilities("rust", {
        rust: {
            build: {
                rust: { targetKinds: ["cargo-package"], modules: ["//rules/rust"] },
            },
            lint: {
                clippy: { targetKinds: ["cargo-package"], modules: ["//rules/rust/clippy"] },
            },
        },
    });
    expect(md).toContain("## Available goals");
    expect(md).toContain("| `imp build` | Rust | `cargo-package` |");
    expect(md).toContain("| `imp lint` | [Clippy](./clippy/) | `cargo-package` |");
});

test("places the generated capability table at a guide marker", () => {
    const md = renderLanguagePage(
        "Rust",
        new Map(),
        {},
        "Opening guidance.\n\n<!-- capabilities -->\n\n## Details\n\nMore guidance.",
        "## Available goals\n\n| Goal | Tool |",
    );
    expect(md.indexOf("Opening guidance.") < md.indexOf("## Available goals")).toBeTruthy();
    expect(md.indexOf("## Available goals") < md.indexOf("## Details")).toBeTruthy();
    expect(md).not.toContain("<!-- capabilities -->");
});

test("modulePageSegments mirrors the source directory nesting", () => {
    expect(modulePageSegments("src/imp_core.js")).toEqual(["core", "imp_core"]);
    expect(modulePageSegments("rules/odin/toolchain.js")).toEqual(["odin", "toolchain"]);
    expect(modulePageSegments("rules/c/cmake/toolchain.js")).toEqual(["c", "cmake", "toolchain"]);
});

test("extractCodeReference emits one page per source module, nested to mirror its directory", () => {
    const pages = extractCodeReference([
        {
            sourcePath: "rules/odin/toolchain.js",
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

    const byPath = new Map(pages.map(p => [p.path, p.markdown]));
    expect(byPath.has("odin/toolchain.md")).toBe(true);
    const page = byPath.get("odin/toolchain.md");
    expect(page).toContain('title = "rules/odin/toolchain.js"');
    expect(page).toContain("### odinPackage");
    expect(page).toContain("### odinBuild");
    expect(page).toContain("_Undocumented._");
    expect(page).toContain("### OdinPackage");
});

test("extractCodeReference folds an index.js module into its own directory's page instead of a colliding index.md", () => {
    const soleFile = extractCodeReference([
        { sourcePath: "rules/oci/index.js", sourceText: "export function ociImage(opts) {}" },
    ]);
    expect(soleFile.length).toBe(1);
    expect(soleFile[0].path).toBe("oci/_index.md");
    expect(soleFile[0].markdown).toContain("### ociImage");

    const withSiblings = extractCodeReference([
        { sourcePath: "rules/c/index.js", sourceText: "export function cLibrary(opts) {}" },
        { sourcePath: "rules/c/gcc/toolchain.js", sourceText: "export function gccToolchain() {}" },
    ]);
    const byPath = new Map(withSiblings.map(p => [p.path, p.markdown]));
    expect(byPath.has("c/index.md")).toBe(false);
    expect(byPath.has("c/_index.md")).toBe(true);
    expect(byPath.get("c/_index.md")).toContain("### cLibrary");
    expect(byPath.has("c/gcc/toolchain.md")).toBe(true);
});

test("extractCodeReference emits a branch _index.md when a directory has more than one module", () => {
    const pages = extractCodeReference([
        {
            sourcePath: "rules/c/cmake/toolchain.js",
            sourceText: "export function cmakeToolchain() {}",
        },
        {
            sourcePath: "rules/c/mold/toolchain.js",
            sourceText: "export function moldToolchain() {}",
        },
    ]);
    const byPath = new Map(pages.map(p => [p.path, p.markdown]));

    expect(byPath.has("c/cmake/toolchain.md")).toBe(true);
    expect(byPath.has("c/mold/toolchain.md")).toBe(true);
    expect(byPath.has("c/_index.md")).toBe(true);
    expect(byPath.get("c/_index.md")).toContain('title = "C"');
    expect(byPath.get("c/_index.md")).toContain('template = "section.html"');
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

    expect(byPath.has("odin/_index.md")).toBe(true);
    const odin = byPath.get("odin/_index.md");
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

test("extractUserApiReference creates guide-only tool pages and includes group capabilities", () => {
    const pages = extractUserApiReference([], {}, {
        rust: {
            lint: {
                clippy: { targetKinds: ["cargo-package"], modules: ["//rules/rust/clippy"] },
            },
        },
    }, [
        {
            sourcePath: "rules/rust/DOC.md",
            sourceText: "Rust guide.\n\n<!-- capabilities -->\n\n## Setup\n",
        },
        {
            sourcePath: "rules/rust/clippy/DOC.md",
            sourceText: "Clippy guide.",
        },
    ]);
    const byPath = new Map(pages.map(p => [p.path, p.markdown]));
    expect(byPath.has("rust/_index.md")).toBe(true);
    expect(byPath.get("rust/_index.md")).toContain("Rust guide.");
    expect(byPath.get("rust/_index.md")).toContain("[Clippy](./clippy/)");
    expect(byPath.has("rust/clippy.md")).toBe(true);
    expect(byPath.get("rust/clippy.md")).toContain("Clippy guide.");
});

test("extractUserApiReference nests subdirectories as subcategories instead of folding them into their parent", () => {
    const files = [
        {
            sourcePath: "rules/c/cmake/toolchain.js",
            sourceText: [
                "/**",
                " * Declare a CMake toolchain.",
                " * @category configuration",
                " */",
                "export function cmakeToolchain(version) {}",
            ].join("\n"),
        },
        {
            sourcePath: "rules/c/mold/toolchain.js",
            sourceText: [
                "/**",
                " * Declare a Mold linker toolchain.",
                " * @category configuration",
                " */",
                "export function moldToolchain(version) {}",
            ].join("\n"),
        },
    ];

    const pages = extractUserApiReference(files);
    const byPath = new Map(pages.map(p => [p.path, p.markdown]));

    expect(byPath.has("c/cmake.md")).toBe(true);
    expect(byPath.has("c/mold.md")).toBe(true);
    expect(byPath.get("c/cmake.md")).toContain("### cmakeToolchain");
    expect(byPath.get("c/cmake.md")).not.toContain("### moldToolchain");
    expect(byPath.get("c/mold.md")).toContain("### moldToolchain");
    expect(byPath.has("c.md")).toBe(false);
    expect(byPath.has("c/_index.md")).toBe(true);
});

test("extractUserApiReference tags every top-level section with a weight and core/languages group, core first", () => {
    const files = [
        { sourcePath: "rules/imp/native_tool.js", sourceText: "/** @category configuration */\nexport function impTool() {}" },
        { sourcePath: "rules/workflows/fmt.js", sourceText: "/** @category target */\nexport function fmtWorkflow() {}" },
        { sourcePath: "rules/odin/index.js", sourceText: "/** @category target */\nexport function odinPackage() {}" },
        { sourcePath: "rules/c/index.js", sourceText: "/** @category target */\nexport function cLibrary() {}" },
    ];

    const pages = extractUserApiReference(files);
    const byPath = new Map(pages.map(p => [p.path, p.markdown]));

    // imp and workflows are top-level with only one directory each, so
    // they'd normally stay flat pages - forced into sections here so every
    // top-level entry is uniformly weight/group-taggable.
    expect(byPath.has("workflows/_index.md")).toBe(true);
    expect(byPath.has("imp/_index.md")).toBe(true);

    const weightOf = path => Number(byPath.get(path).match(/weight = (\d+)/)[1]);
    const groupOf = path => byPath.get(path).match(/group = "(\w+)"/)[1];

    expect(groupOf("workflows/_index.md")).toBe("core");
    expect(groupOf("imp/_index.md")).toBe("core");
    expect(groupOf("odin/_index.md")).toBe("languages");
    expect(groupOf("c/_index.md")).toBe("languages");

    // Workflows comes right after Core in TOP_LEVEL_CORE_ORDER; Core itself
    // isn't present here, so Workflows gets weight 0.
    expect(weightOf("workflows/_index.md") < weightOf("imp/_index.md")).toBeTruthy();
    expect(weightOf("imp/_index.md") < weightOf("c/_index.md")).toBeTruthy();
    expect(weightOf("imp/_index.md") < weightOf("odin/_index.md")).toBeTruthy();
});

test("extractApiReference is the exhaustive code-reference compatibility wrapper", () => {
    const pages = extractApiReference([
        {
            sourcePath: "rules/asset.js",
            sourceText: "export function asset(opts) {}",
        },
    ]);
    const byPath = new Map(pages.map(p => [p.path, p.markdown]));

    expect(byPath.has("rules/asset.md")).toBe(true);
    expect(byPath.get("rules/asset.md")).toContain("### asset");
});
});
