// Pure-JS extraction of JSDoc comments from the imp JS DSL surface
// (src/imp_core.js + rules/**/*.js), turned into Zola-ingestible Markdown
// pages. No host bridge is used here — read_file() is called by the caller
// (docs/BUILD.js's docsApiReference product) so this module stays a plain,
// easily unit-testable string-in/string-out parser.

const EXPORT_FUNCTION_RE = /^export function (\w+)\s*\(([^)]*)\)/;
const EXPORT_BINDING_RE = /^export const (\w+)\s*=\s*(?:memo|product)\(/;
const PARAM_TAG_RE = /^@param\s+(?:\{([^}]*)\}\s+)?(\S+)\s*(.*)$/;
const RETURNS_TAG_RE = /^@returns?\s+(?:\{([^}]*)\})?\s*(.*)$/;

function stripCommentMarker(line) {
    return line.replace(/^\*\s?/, "");
}

/**
 * Parse the free-text summary, @param, and @returns lines out of a JSDoc
 * block's content lines (already stripped of the surrounding /** * / and
 * leading `*` markers).
 *
 * @param {string[]} lines
 * @returns {{ summary: string, params: {type: string, name: string, description: string}[], returns: {type: string, description: string}|null }}
 */
export function parseDocBlock(lines) {
    const summaryLines = [];
    const params = [];
    let returns = null;

    for (const raw of lines) {
        const line = raw.trim();
        if (line === "") continue;

        const paramMatch = line.match(PARAM_TAG_RE);
        if (paramMatch) {
            params.push({ type: paramMatch[1] || "", name: paramMatch[2], description: paramMatch[3] || "" });
            continue;
        }

        const returnsMatch = line.match(RETURNS_TAG_RE);
        if (returnsMatch) {
            returns = { type: returnsMatch[1] || "", description: returnsMatch[2] || "" };
            continue;
        }

        if (line.startsWith("@")) continue;

        summaryLines.push(line);
    }

    return { summary: summaryLines.join(" "), params, returns };
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
 * Turn a source directory (e.g. "rules/c/zig", "rules", "src") into a flat
 * output slug used both as the generated page's filename and as a stable
 * title, e.g. "rules-c-zig", "rules", "core". "src" is special-cased to
 * "core" since it holds only imp_core.js today.
 *
 * @param {string} dirPath
 * @returns {string}
 */
export function outputSlugForDirectory(dirPath) {
    if (dirPath === "src") return "core";
    return dirPath.replace(/\//g, "-");
}

/**
 * Turn a source path's filename into a capitalized heading, e.g.
 * "rules/odin/toolchain.js" -> "Toolchain", "rules/imp/native_tool.js" ->
 * "Native Tool".
 *
 * @param {string} sourcePath
 * @returns {string}
 */
export function fileHeading(sourcePath) {
    const base = sourcePath.slice(sourcePath.lastIndexOf("/") + 1).replace(/\.js$/, "");
    return base
        .split(/[_-]+/)
        .filter(Boolean)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

function renderSection({ heading, entries }) {
    const lines = [`## ${heading}`, "", ...entries.map(renderEntry)];
    return lines.join("\n");
}

/**
 * Render a Markdown reference page (with Zola TOML frontmatter) for a
 * directory's files, one `##` heading per file, one `###` heading per
 * documented export beneath it. Files with zero documentable exports are
 * omitted; if every file in the directory has none, returns null so callers
 * can skip emitting an empty page.
 *
 * @param {{ title: string, sections: {heading: string, entries: object[]}[] }} opts
 * @returns {string|null}
 */
export function renderDirectoryPage({ title, sections }) {
    const nonEmpty = sections.filter(s => s.entries.length > 0);
    if (nonEmpty.length === 0) return null;

    const frontmatter = `+++\ntitle = "${title}"\n+++\n`;
    const body = nonEmpty.map(renderSection).join("\n\n");
    return `${frontmatter}\n${body}`;
}

/**
 * Parse and render the Markdown reference page for one directory's files.
 *
 * @param {string} dirPath
 * @param {{ sourcePath: string, sourceText: string }[]} files
 * @returns {{ slug: string, markdown: string|null, entryCount: number }}
 */
export function extractDirectoryDoc(dirPath, files) {
    const sections = files.map(({ sourcePath, sourceText }) => ({
        heading: fileHeading(sourcePath),
        entries: parseModule(sourceText),
    }));
    const slug = outputSlugForDirectory(dirPath);
    const markdown = renderDirectoryPage({ title: slug, sections });
    const entryCount = sections.reduce((n, s) => n + s.entries.length, 0);
    return { slug, markdown, entryCount };
}
