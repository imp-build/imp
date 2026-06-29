import {
    target,
    glob,
    memo,
    product,
    run,
    sourcesField,
    targetAddress,
    registerBuildRule,
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

export const bundle = product("asset", "bundle", async function bundle(handle) {
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

export function asset({ srcs }) {
    return target({ kind: "asset", attrs: { sources: srcs } });
}

export const resources = memo(async function resources(handle) {
    return glob({
        root: declared_path(handle, handle.attrs.path || "."),
        include: handle.attrs.srcs || [],
        exclude: handle.attrs.exclude || [],
    });
});

export function resourcePackage({ srcs, exclude = [], path = "." }) {
    if (!Array.isArray(srcs) || srcs.length === 0) {
        throw new Error("resourcePackage({ srcs }) requires one or more source glob patterns");
    }
    return target({
        kind: "resource-package",
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
