// Pure-JS extraction of JSDoc comments from the imp JS DSL surface
// (src/imp_core.js + rules/**/*.js), turned into Zola-ingestible Markdown
// pages. No host bridge is used here — read_file() is called by the caller
// (docs/BUILD.js's docsApiReference product) so this module stays a plain,
// easily unit-testable string-in/string-out parser.

const EXPORT_FUNCTION_RE = /^export function (\w+)\s*\(([^)]*)\)/;
const EXPORT_BINDING_RE = /^export const (\w+)\s*=\s*(?:memo|product)\(/;
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

// Sidebar/page grouping below "language". Order here is display order.
// Entries with no explicit @category tag default to "api": they're
// exported, so they're presumably meant to be used by other code. Whether a
// given export is genuinely needed is a source-level question (should it be
// exported at all?), not something this extractor infers.
const CATEGORY_LABELS = {
    configuration: "Configuration",
    target: "Targets",
    api: "API",
};
const CATEGORY_ORDER = ["configuration", "target", "api"];

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
 * Scan a JS source file's text and extract one entry per documentable
 * export: `export function name(...)` declarations and `export const name =
 * product(...)`/`memo(...)` bindings. Each entry carries the nearest
 * preceding contiguous JSDoc block as its doc comment, if any — blank
 * lines don't break contiguity, but any other intervening code line does
 * (so a comment can't accidentally attach to a later, unrelated export).
 *
 * @param {string} sourceText
 * @returns {{ name: string, params: string, kind: "function"|"binding", doc: object|null }[]}
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

        const fnMatch = trimmed.match(EXPORT_FUNCTION_RE);
        if (fnMatch) {
            entries.push({
                name: fnMatch[1],
                params: fnMatch[2],
                kind: "function",
                doc: pendingDocLines ? parseDocBlock(pendingDocLines) : null,
            });
            pendingDocLines = null;
            continue;
        }

        const bindMatch = trimmed.match(EXPORT_BINDING_RE);
        if (bindMatch) {
            entries.push({
                name: bindMatch[1],
                params: "",
                kind: "binding",
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
    lines.push(entry.kind === "function" ? `${entry.name}(${entry.params})` : entry.name);
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
 * Render one category page's Markdown body (no frontmatter): one `###`
 * heading per documented export.
 *
 * @param {object[]} entries
 * @returns {string}
 */
function renderEntries(entries) {
    return entries.map(renderEntry).join("\n\n");
}

/**
 * Render a category page (e.g. "Odin" x "Targets") with Zola TOML
 * frontmatter, ordered by CATEGORY_ORDER via a numeric weight.
 *
 * @param {{ language: string, category: string, entries: object[] }} opts
 * @returns {string}
 */
export function renderCategoryPage({ language, category, entries }) {
    const weight = (CATEGORY_ORDER.indexOf(category) + 1) * 10;
    const frontmatter = `+++\ntitle = "${CATEGORY_LABELS[category]}"\nweight = ${weight}\n\n[extra]\nlanguage = "${language}"\n+++\n`;
    return `${frontmatter}\n${renderEntries(entries)}`;
}

/**
 * Render a language's section landing page (e.g. "Odin"): a bare heading:
 * Zola's section.html template lists this section's category pages
 * (Configuration/Targets/API, weight-sorted) when visited directly.
 *
 * @param {string} language
 * @returns {string}
 */
export function renderLanguageIndexPage(language) {
    return `+++\ntitle = "${language}"\nsort_by = "weight"\ntemplate = "section.html"\n\n[extra]\nlanguage = "${language}"\n+++\n`;
}

/**
 * Parse every scanned source file into API reference pages grouped by
 * sidebar language (directory-derived) and then by category
 * (Configuration/Targets/API — see categoryForEntry). Emits one
 * `<language>/_index.md` landing page plus one `<language>/<category>.md`
 * page per non-empty category.
 *
 * @param {{ sourcePath: string, sourceText: string }[]} files
 * @returns {{ path: string, markdown: string }[]}
 */
export function extractApiReference(files) {
    const byLanguage = new Map();
    for (const { sourcePath, sourceText } of files) {
        const language = languageForDirectory(directoryForSourcePath(sourcePath));
        if (!byLanguage.has(language)) byLanguage.set(language, new Map());
        const byCategory = byLanguage.get(language);
        for (const entry of parseModule(sourceText)) {
            const category = categoryForEntry(entry);
            if (!byCategory.has(category)) byCategory.set(category, []);
            byCategory.get(category).push(entry);
        }
    }

    const pages = [];
    for (const language of [...byLanguage.keys()].sort()) {
        const byCategory = byLanguage.get(language);
        const slug = languageSlug(language);
        let any = false;
        for (const category of CATEGORY_ORDER) {
            const entries = byCategory.get(category);
            if (!entries || entries.length === 0) continue;
            any = true;
            pages.push({ path: `${slug}/${category}.md`, markdown: renderCategoryPage({ language, category, entries }) });
        }
        if (any) pages.push({ path: `${slug}/_index.md`, markdown: renderLanguageIndexPage(language) });
    }
    return pages;
}
