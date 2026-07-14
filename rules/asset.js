import {
    Target,
    glob,
    memo,
    product,
    run,
    sourcesField,
    targetAddress,
    registerBuildRule,
    BUILD,
} from "imp:core";

registerBuildRule({
    rule: "resourcePackage",
    importFrom: "//rules/asset",
});

function normalize_workspace_path(path) {
    const parts = [];
    for (const part of path.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") {
            throw new Error(`resourcePackage paths must stay within the workspace: ${path}`);
        }
        parts.push(part);
    }
    return parts.length === 0 ? "." : parts.join("/");
}

function declaring_directory(handle) {
    const address = safe_target_address(handle);
    if (!address || !address.startsWith("//")) return ".";
    const scope = address.slice(2).split(":")[0];
    return scope.length === 0 ? "." : scope;
}

function safe_target_address(handle) {
    if (!handle || handle.__imp !== true) return null;
    try {
        return targetAddress(handle);
    } catch (_) {
        return null;
    }
}

function declared_path(handle, path = ".") {
    const base = declaring_directory(handle);
    const local = path || ".";
    if (base === ".") return normalize_workspace_path(local);
    if (local === ".") return base;
    return normalize_workspace_path(`${base}/${local}`);
}

// ---------------------------------------------------------------------------
// Memo/product functions for asset targets
// ---------------------------------------------------------------------------

export const sources = memo(async function sources(handle) {
    return glob({ root: ".", include: handle.attrs.sources || [] });
});

export class Asset extends Target {
    static kind = "asset";
    constructor({ srcs }) {
        super({ kind: Asset.kind, attrs: { sources: srcs } });
    }
}

export const bundle = product(Asset, BUILD, async function bundle(handle) {
    const srcs = await sources(handle);
    return run({
        argv: ["sh", "-c", "true"],
        inputs: [srcs],
        display: `bundle ${handle.label.name}`,
        impure: true,
    });
});

// ---------------------------------------------------------------------------
// Target constructors
// ---------------------------------------------------------------------------

/**
 * Declare an asset target bundling a set of source glob patterns.
 *
 * @category target
 * @param {object} opts
 * @param {string[]} opts.srcs Source glob patterns, relative to the declaring BUILD.js.
 * @returns {object} The declared target.
 */
export function asset({ srcs }) {
    return new Asset({ srcs });
}

export const resources = memo(async function resources(handle) {
    return glob({
        root: declared_path(handle, handle.attrs.path || "."),
        include: handle.attrs.srcs || [],
        exclude: handle.attrs.exclude || [],
    });
});

export class ResourcePackage extends Target {
    static kind = "resource-package";
    constructor({ srcs, exclude = [], path = "." }) {
        if (!Array.isArray(srcs) || srcs.length === 0) {
            throw new Error("resourcePackage({ srcs }) requires one or more source glob patterns");
        }
        super({
            kind: ResourcePackage.kind,
            attrs: {
                path,
                srcs,
                ...(exclude.length ? { exclude } : {}),
            },
            sources: sourcesField({
                root: path,
                include: srcs,
                exclude,
            }),
        });
    }
}

/**
 * Declare a resource-package target: a set of files staged at a given path,
 * for bundling into another target's sandbox (e.g. runtime data files).
 *
 * @category target
 * @param {object} opts
 * @param {string[]} opts.srcs Source glob patterns to include (required, non-empty).
 * @param {string[]} [opts.exclude] Glob patterns to exclude from `srcs`.
 * @param {string} [opts.path] Directory (relative to the declaring BUILD.js) the sources are staged under.
 * @returns {object} The declared target.
 */
export function resourcePackage({ srcs, exclude = [], path = "." }) {
    return new ResourcePackage({ srcs, exclude, path });
}
