// Auto-generates a cargoPackage() declaration for every unowned Cargo.toml
// in the workspace, for the `imp generate-build` goal. Mirrors
// rules/odin/index.js's generateBuild ("odin-build-generator"), but Cargo
// gives us an authoritative package name straight from the manifest, so
// there's no dependency-inference machinery to port over: a directory with
// a Cargo.toml just becomes one `cargoPackage({ bin: <name> })`, named after
// that package rather than after its directory.

import {
    Target,
    allUnowned,
    product,
    read_file,
    registerBuildRule,
    workspaceTargets,
} from "imp:core";

import { declared_path } from "//rules/rust";

registerBuildRule({
    rule: "cargoPackage",
    importFrom: "//rules/rust",
});

// "**/vendor/**" matters here beyond the usual convention: `cargo vendor`
// writes a full Cargo.toml for every vendored dependency, none of which are
// real, independently-buildable crates of this workspace.
const DEFAULT_GENERATE_BUILD_EXCLUDES = [
    "**/.*/**",
    "**/build/**",
    "**/coverage/**",
    "**/dist/**",
    "**/obj/**",
    "**/target/**",
    "**/vendor/**",
];

function dirname(path) {
    const index = path.lastIndexOf("/");
    return index < 0 ? "." : path.slice(0, index);
}

function normalize_workspace_path(path) {
    const parts = [];
    for (const part of path.split("/")) {
        if (part === "" || part === ".") continue;
        parts.push(part);
    }
    return parts.length === 0 ? "." : parts.join("/");
}

function sanitize_identifier(raw) {
    let name = raw.replace(/[^A-Za-z0-9_$]/g, "_");
    if (name.length === 0) name = "root";
    if (!/^[A-Za-z_$]/.test(name)) name = `_${name}`;
    return name;
}

function build_file_for_dir(dir) {
    return dir === "." ? "BUILD.js" : `${dir}/BUILD.js`;
}

function append_build_target(result, file, target) {
    if (!result[file]) result[file] = [];
    result[file].push(target);
}

// Cargo.toml is TOML, but the workspace has no TOML parser anywhere (CMake's
// rule shells out to real `cmake` instead of parsing CMakeLists.txt) — this
// hand-scans just far enough to pull `[package].name` out, stopping at the
// next `[...]` section header so a `name` field belonging to `[dependencies]`
// or a `[[bin]]` table is never mistaken for the package's own name.
export function parse_cargo_package_name(text) {
    let inPackageSection = false;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith("[")) {
            inPackageSection = line === "[package]";
            continue;
        }
        if (!inPackageSection) continue;
        const match = /^name\s*=\s*"([^"]+)"/.exec(line);
        if (match) return match[1];
    }
    return null;
}

export const generateBuild = product("cargo-build-generator", "generate-build",
    async function generateBuild(handle) {
        const manifests = allUnowned({
            root: handle.attrs.root || ".",
            include: ["**/Cargo.toml"],
            exclude: handle.attrs.exclude || DEFAULT_GENERATE_BUILD_EXCLUDES,
        });

        const existingPaths = new Set(
            workspaceTargets("cargo-package").map(({ handle: h }) =>
                normalize_workspace_path(declared_path(h, h.attrs.path || "."))),
        );

        const result = {};
        for (const manifestPath of manifests) {
            const dir = dirname(manifestPath);
            if (existingPaths.has(normalize_workspace_path(dir))) continue;

            const name = parse_cargo_package_name(read_file(manifestPath));
            if (!name) continue;

            append_build_target(result, build_file_for_dir(dir), {
                name: sanitize_identifier(name),
                rule: "cargoPackage",
                props: { bin: name },
            });
        }
        return result;
    }
);

export class CargoGenerateBuild extends Target {
    static kind = "cargo-build-generator";
    constructor({ root = ".", exclude = DEFAULT_GENERATE_BUILD_EXCLUDES } = {}) {
        super({
            kind: CargoGenerateBuild.kind,
            attrs: { root, exclude },
        });
    }
}

export function cargoGenerateBuild({ root = ".", exclude = DEFAULT_GENERATE_BUILD_EXCLUDES } = {}) {
    return new CargoGenerateBuild({ root, exclude });
}
