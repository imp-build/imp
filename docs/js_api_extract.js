// Pure-JS extraction of JSDoc comments from the imp JS DSL surface
// (src/imp_core.js + rules/**/*.js), turned into Zola-ingestible Markdown
// pages. No host bridge is used here: read_file() is called by the caller
// (docs/BUILD.js's api_reference_build product) so this module stays a plain,
// easily unit-testable string-in/string-out parser.

const EXPORT_FUNCTION_RE = /^export function (\w+)\s*\(([^)]*)\)/;
const EXPORT_CLASS_RE = /^export class (\w+)\b/;
const EXPORT_CONST_RE = /^export const (\w+)\s*=/;
const PARAM_TAG_RE = /^@param\b\s*(.*)$/;
const RETURNS_TAG_RE = /^@returns?\b\s*(.*)$/;
const CATEGORY_TAG_RE = /^@category\s+(\S+)/;

/**
 * Split a `{Type}` prefix off the remainder of a @param/@returns tag,
 * respecting brace nesting so object-literal types like
 * `{{ os: string, arch: string }}` aren't cut off at their first `}`.
 * Returns `{ type: null, rest: text }` unchanged if there's no leading `{`
 * or the braces never balance.
 *
 * @param {string} text
 * @returns {{ type: string|null, rest: string }}
 */
function splitLeadingBraceType(text) {
    if (!text.startsWith("{")) return { type: null, rest: text };
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") {
            depth--;
            if (depth === 0) {
                return { type: text.slice(1, i), rest: text.slice(i + 1).trimStart() };
            }
        }
    }
    return { type: null, rest: text };
}

const CATEGORY_LABELS = {
    configuration: "Configuration",
    target: "Targets",
    api: "API",
};
const CATEGORY_ORDER = ["configuration", "target", "api"];
const USER_API_CATEGORIES = ["configuration", "target"];

function stripCommentMarker(line) {
    return line.replace(/^\*\s?/, "");
}

/**
 * Parse the free-text summary, @param, and @returns lines out of a JSDoc
 * block's content lines (already stripped of the surrounding /** * / and
 * leading `*` markers).
 *
 * @param {string[]} lines
 * @returns {{ summary: string, params: {type: string, name: string, description: string}[], returns: {type: string, description: string}|null, category: string|null }}
 */
export function parseDocBlock(lines) {
    const summaryLines = [];
    const params = [];
    let returns = null;
    let category = null;

    for (const raw of lines) {
        const line = raw.trim();
        if (line === "") continue;

        const paramMatch = line.match(PARAM_TAG_RE);
        if (paramMatch) {
            const { type, rest } = splitLeadingBraceType(paramMatch[1]);
            const spaceIdx = rest.indexOf(" ");
            const name = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
            const description = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1).trim();
            params.push({ type: type || "", name, description });
            continue;
        }

        const returnsMatch = line.match(RETURNS_TAG_RE);
        if (returnsMatch) {
            const { type, rest } = splitLeadingBraceType(returnsMatch[1]);
            returns = { type: type || "", description: rest.trim() };
            continue;
        }

        const categoryMatch = line.match(CATEGORY_TAG_RE);
        if (categoryMatch) {
            category = categoryMatch[1];
            continue;
        }

        if (line.startsWith("@")) continue;

        summaryLines.push(line);
    }

    return { summary: summaryLines.join(" "), params, returns, category };
}

/**
 * Scan a JS source file's text and extract one entry per local export:
 * `export function`, `export class`, and `export const` declarations. Each
 * entry carries the nearest preceding contiguous JSDoc block as its doc
 * comment, if any: blank lines don't break contiguity, but any other
 * intervening code line does (so a comment can't accidentally attach to a
 * later, unrelated export).
 *
 * @param {string} sourceText
 * @returns {{ name: string, params: string, kind: "function"|"class"|"const", doc: object|null }[]}
 */
export function parseModule(sourceText) {
    const lines = sourceText.split("\n");
    const entries = [];

    let inComment = false;
    let commentBuffer = null;
    let pendingDocLines = null;

    for (const rawLine of lines) {
        const trimmed = rawLine.trim();

        if (inComment) {
            if (trimmed.endsWith("*/")) {
                inComment = false;
                const content = stripCommentMarker(trimmed.slice(0, -2).trim());
                if (content) commentBuffer.push(content);
                pendingDocLines = commentBuffer;
                commentBuffer = null;
            } else {
                commentBuffer.push(stripCommentMarker(trimmed));
            }
            continue;
        }

        if (trimmed.startsWith("/**")) {
            if (trimmed.endsWith("*/") && trimmed.length > 4) {
                // Single-line /** ... */ block.
                const inner = trimmed.slice(3, -2).trim();
                pendingDocLines = inner ? [inner] : [];
            } else {
                inComment = true;
                commentBuffer = [];
                const rest = trimmed.slice(3);
                if (rest.trim()) commentBuffer.push(stripCommentMarker(rest.trim()));
            }
            continue;
        }

        if (trimmed === "") {
            continue;
        }

        const classMatch = trimmed.match(EXPORT_CLASS_RE);
        if (classMatch) {
            if (classMatch[1].startsWith("__")) {
                pendingDocLines = null;
                continue;
            }
            entries.push({
                name: classMatch[1],
                params: "",
                kind: "class",
                doc: pendingDocLines ? parseDocBlock(pendingDocLines) : null,
            });
            pendingDocLines = null;
            continue;
        }

        const fnMatch = trimmed.match(EXPORT_FUNCTION_RE);
        if (fnMatch) {
            if (fnMatch[1].startsWith("__")) {
                pendingDocLines = null;
                continue;
            }
            entries.push({
                name: fnMatch[1],
                params: fnMatch[2],
                kind: "function",
                doc: pendingDocLines ? parseDocBlock(pendingDocLines) : null,
            });
            pendingDocLines = null;
            continue;
        }

        const constMatch = trimmed.match(EXPORT_CONST_RE);
        if (constMatch) {
            if (constMatch[1].startsWith("__")) {
                pendingDocLines = null;
                continue;
            }
            entries.push({
                name: constMatch[1],
                params: "",
                kind: "const",
                doc: pendingDocLines ? parseDocBlock(pendingDocLines) : null,
            });
            pendingDocLines = null;
            continue;
        }

        // Any other non-blank line invalidates a pending doc comment: it's
        // no longer contiguous with a documentable declaration.
        pendingDocLines = null;
    }

    return entries;
}

function renderEntry(entry) {
    const lines = [];
    lines.push(`### ${entry.name}`);
    lines.push("");
    lines.push("```js");
    if (entry.kind === "function") {
        lines.push(`${entry.name}(${entry.params})`);
    } else if (entry.kind === "class") {
        lines.push(`class ${entry.name}`);
    } else {
        lines.push(`const ${entry.name}`);
    }
    lines.push("```");
    lines.push("");

    if (entry.doc) {
        if (entry.doc.summary) {
            lines.push(entry.doc.summary);
            lines.push("");
        }
        if (entry.doc.params.length > 0) {
            lines.push("| Parameter | Type | Description |");
            lines.push("| --- | --- | --- |");
            for (const p of entry.doc.params) {
                lines.push(`| ${p.name} | ${p.type} | ${p.description} |`);
            }
            lines.push("");
        }
        if (entry.doc.returns) {
            const type = entry.doc.returns.type ? `\`${entry.doc.returns.type}\` ` : "";
            lines.push(`**Returns:** ${type}${entry.doc.returns.description}`.trim());
            lines.push("");
        }
    } else {
        lines.push("_Undocumented._");
        lines.push("");
    }

    return lines.join("\n");
}

/**
 * Return the directory a source path lives in, e.g.
 * "rules/c/zig/toolchain.js" -> "rules/c/zig", "rules/asset.js" -> "rules".
 *
 * @param {string} sourcePath
 * @returns {string}
 */
export function directoryForSourcePath(sourcePath) {
    const idx = sourcePath.lastIndexOf("/");
    return idx === -1 ? "." : sourcePath.slice(0, idx);
}

/**
 * Derive the sidebar "language" a source directory belongs to, e.g.
 * "rules/c/zig" -> "C", "rules/odin" -> "Odin", "rules/imp/test" ->
 * "Imp", "rules" -> "Rules", "src" -> "Core". This is directory-derived,
 * not content-derived: everything under one top-level rules/ subdirectory
 * (or its own nested subdirectories) shares one language group, regardless
 * of what that code actually does.
 *
 * @param {string} dirPath
 * @returns {string}
 */
export function languageForDirectory(dirPath) {
    if (dirPath === "src") return "Core";
    if (dirPath === "rules") return "Rules";
    const rest = dirPath.startsWith("rules/") ? dirPath.slice("rules/".length) : dirPath;
    const first = rest.split("/")[0];
    return first.charAt(0).toUpperCase() + first.slice(1);
}

/**
 * Turn a language name into its output-path/slug form, e.g. "C" -> "c",
 * "Imp" -> "imp".
 *
 * @param {string} language
 * @returns {string}
 */
export function languageSlug(language) {
    return language.toLowerCase();
}

/**
 * Resolve an entry's sidebar category. An explicit JSDoc `@category` tag
 * always wins; otherwise an entry defaults to "api" since it's exported and
 * therefore presumably meant to be used by other code. (Whether a given
 * export genuinely needs to be exported is a source-level cleanup question,
 * not something this extractor tries to infer.)
 *
 * @param {{ doc: object|null }} entry
 * @returns {string}
 */
export function categoryForEntry(entry) {
    const tag = entry.doc && entry.doc.category;
    if (tag && CATEGORY_LABELS[tag]) return tag;
    return "api";
}

/**
 * Return true if an entry belongs in the curated user-facing API reference.
 *
 * @param {{ doc: object|null }} entry
 * @returns {boolean}
 */
export function isUserApiEntry(entry) {
    const tag = entry.doc && entry.doc.category;
    return USER_API_CATEGORIES.includes(tag);
}

function renderEntries(entries) {
    return entries.map(renderEntry).join("\n\n");
}

/**
 * Render every non-empty category as an `##` heading (in CATEGORY_ORDER),
 * each followed by its entries' `###` headings.
 *
 * @param {Map<string, object[]>} byCategory
 * @returns {string}
 */
function renderCategorySections(byCategory) {
    const sections = [];
    for (const category of CATEGORY_ORDER) {
        const entries = byCategory.get(category);
        if (!entries || entries.length === 0) continue;
        sections.push(`## ${CATEGORY_LABELS[category]}\n\n${renderEntries(entries)}`);
    }
    return sections.join("\n\n");
}

/**
 * Render a language's single reference page (e.g. "Odin"): Zola TOML
 * frontmatter plus every category's entries inlined as `##` sections
 * (Configuration/Targets/API, in that order) — what used to be separate
 * subpages are now just headings on this one page.
 *
 * @param {string} language
 * @param {Map<string, object[]>} byCategory
 * @returns {string}
 */
export function renderLanguagePage(language, byCategory) {
    const frontmatter = `+++\ntitle = "${language}"\n+++\n`;
    return `${frontmatter}\n${renderCategorySections(byCategory)}`;
}

/**
 * Turn a JS source path into a flat Zola page path. Keeping the source path in
 * the title preserves the module identity while the flat slug keeps the
 * existing section sidebar simple.
 *
 * @param {string} sourcePath
 * @returns {string}
 */
export function modulePagePath(sourcePath) {
    return `${sourcePath.replace(/\.js$/, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}.md`;
}

function renderModulePage(sourcePath, entries) {
    const frontmatter = `+++\ntitle = "${sourcePath}"\n+++\n`;
    return `${frontmatter}\n${renderEntries(entries)}`;
}

/**
 * Parse every scanned source file into exhaustive code-reference pages: one
 * page per module, including every local export and marking missing JSDoc.
 *
 * @param {{ sourcePath: string, sourceText: string }[]} files
 * @returns {{ path: string, markdown: string }[]}
 */
export function extractCodeReference(files) {
    const pages = [];
    for (const { sourcePath, sourceText } of files.slice().sort((a, b) => a.sourcePath.localeCompare(b.sourcePath))) {
        const entries = parseModule(sourceText);
        if (entries.length === 0) continue;
        pages.push({
            path: modulePagePath(sourcePath),
            markdown: renderModulePage(sourcePath, entries),
        });
    }
    return pages;
}

/**
 * Parse every scanned source file into one curated user API reference page per
 * sidebar language (directory-derived). Only entries tagged
 * `@category target` or `@category configuration` are included.
 *
 * @param {{ sourcePath: string, sourceText: string }[]} files
 * @returns {{ path: string, markdown: string }[]}
 */
export function extractUserApiReference(files) {
    const byLanguage = new Map();
    for (const { sourcePath, sourceText } of files) {
        for (const entry of parseModule(sourceText)) {
            if (!isUserApiEntry(entry)) continue;
            const language = languageForDirectory(directoryForSourcePath(sourcePath));
            if (!byLanguage.has(language)) byLanguage.set(language, new Map());
            const byCategory = byLanguage.get(language);
            const category = categoryForEntry(entry);
            if (!byCategory.has(category)) byCategory.set(category, []);
            byCategory.get(category).push(entry);
        }
    }

    const pages = [];
    for (const language of [...byLanguage.keys()].sort()) {
        const byCategory = byLanguage.get(language);
        const slug = languageSlug(language);
        pages.push({ path: `${slug}.md`, markdown: renderLanguagePage(language, byCategory) });
    }
    return pages;
}

/**
 * Backwards-compatible name for the exhaustive JS code reference.
 *
 * @param {{ sourcePath: string, sourceText: string }[]} files
 * @returns {{ path: string, markdown: string }[]}
 */
export function extractApiReference(files) {
    return extractCodeReference(files);
}
