import {
	allUnowned,
	target,
	glob,
	file_set,
	paths,
	read_file,
	memo,
	output,
	output_path,
	product,
	registerBuildRule,
	run,
	sourcesField,
	logDebug,
	configuration,
	hydrateTarget,
	targetAddress,
	targetRef,
	workspaceTargets,
} from "imp:core";

import {
    defaultOdinToolchain,
    odinTool,
    resolveOdinToolchainVersion,
} from "//rules/odin/toolchain";

import {
    resources as resource_package_sources,
} from "//rules/asset";

import {
    cmake_resources,
} from "//rules/c/cmake";

export {
    acquireOdinToolchain,
    createOdinToolchainApi,
    defaultOdinToolchain,
    defaultOdinToolchainVersion,
    odinArtifactName,
    odinBin,
    odinCacheKey,
    odinDownloadUrl,
    odinToolchain,
    odinTool,
    resolveOdinToolchainVersion,
} from "//rules/odin/toolchain";

registerBuildRule({
    rule: "odinPackage",
    importFrom: "//rules/odin",
});

registerBuildRule({
    rule: "odinTestPackage",
    importFrom: "//rules/odin",
});

// ---------------------------------------------------------------------------
// Memo functions — source discovery
// ---------------------------------------------------------------------------

function normalize_workspace_path(path) {
    const parts = [];
    for (const part of path.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") {
            throw new Error(`Odin paths must stay within the workspace: ${path}`);
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

export function declared_path(handle, path = ".") {
    const base = declaring_directory(handle);
    const local = path || ".";
    if (base === ".") return normalize_workspace_path(local);
    if (local === ".") return base;
    return normalize_workspace_path(`${base}/${local}`);
}

function package_srcs(attrs) {
    if (!attrs || attrs.srcs === undefined || attrs.srcs.length === 0) return ["*.odin"];
    return attrs.srcs;
}

function package_exclude(attrs) {
    if (!attrs || attrs.exclude === undefined) return [];
    return attrs.exclude;
}

function normalize_deps(deps) {
    return deps
        .map(d => d && d.__imp ? d : (d && d.target ? d.target : null))
        .filter(Boolean);
}

/**
 * Return a FileSet of the package's own source files.
 *
 * @param {object} handle Target handle returned by odinPackage().
 * @returns {Promise<object>} FileSet descriptor.
 */
function own_sources_value(handle) {
    return glob({
        root: declared_path(handle, handle.attrs.path || "."),
        include: package_srcs(handle.attrs),
        exclude: package_exclude(handle.attrs),
    });
}

export const own_sources = memo(async function own_sources(handle) {
    return own_sources_value(handle);
});

/**
 * Return a FileSet of the package's own sources plus all transitive odin-package dep sources.
 *
 * @param {object} handle Target handle returned by odinPackage().
 * @returns {Promise<object>} FileSet descriptor.
 */
export const sources = memo(async function sources(handle) {
    const sets = await collect_source_sets(handle, new Set());
    return sets.length === 1 ? sets[0] : file_set.union(...sets);
});

async function collect_source_sets(handle, seen) {
    const key = dep_key(handle);
    if (seen.has(key)) return [];
    seen.add(key);

    const sets = [own_sources_value(handle)];
    for (const dep of await effective_deps(handle)) {
        sets.push(...await collect_source_sets(dep, seen));
    }
    return sets;
}

/**
 * Return a FileSet of all resource-package dep files reachable from an Odin package.
 *
 * @param {object} handle Target handle returned by odinPackage().
 * @returns {Promise<object>} FileSet descriptor.
 */
export const resources = memo(async function resources(handle) {
    const sets = await collect_resource_sets(handle, new Set());
    if (sets.length === 0) return file_set.literal([]);
    return sets.length === 1 ? sets[0] : file_set.union(...sets);
});

async function collect_resource_sets(handle, seen) {
    const key = dep_key(handle);
    if (seen.has(key)) return [];
    seen.add(key);

    const sets = [];
    for (const dep of hydrateTarget(handle).deps.map(dep => dep.handle)) {
        if (!dep) continue;
        if (dep.kind === "resource-package") {
            sets.push(await resource_package_sources(dep));
        } else if (dep.kind === "cmake-lib") {
            sets.push(await cmake_resources(dep));
        }
    }
    for (const dep of await effective_deps(handle)) {
        sets.push(...await collect_resource_sets(dep, seen));
    }
    return sets;
}

function collection_entries_from_config(value, resolvePath) {
    if (value === null || value === undefined) return [];
    if (Array.isArray(value)) {
        return value.map(entry => {
            if (!entry || typeof entry.name !== "string" || typeof entry.path !== "string") {
                throw new Error("Odin collection entries must have string name and path fields");
            }
            return { name: entry.name, path: resolvePath(entry.path) };
        });
    }
    if (typeof value === "object") {
        return Object.entries(value).map(([name, spec]) => {
            const path = typeof spec === "string" ? spec : spec && spec.path;
            if (typeof path !== "string") {
                throw new Error(`Odin collection '${name}' must be a path string or { path } object`);
            }
            return { name, path: resolvePath(path) };
        });
    }
    throw new Error("Odin collections config must be an object or array");
}

function package_collection_entries(handle) {
    const collections = handle.attrs.collections || [];
    if (Array.isArray(collections) && collections.every(col => col && col.__imp === true)) {
        return collections.map(col => ({
            name: col.attrs.name,
            path: declared_path(col, col.attrs.path),
        }));
    }
    return collection_entries_from_config(collections, path => declared_path(handle, path));
}

function collection_map(handle = null) {
    const odinConfig = configuration("odin", {}) || {};
    const merged = new Map();
    for (const entry of collection_entries_from_config(odinConfig.collections || {}, normalize_workspace_path)) {
        merged.set(entry.name, entry.path);
    }
    if (handle) {
        for (const entry of package_collection_entries(handle)) {
            merged.set(entry.name, entry.path);
        }
    }
    return merged;
}

function has_collection_config(collections) {
    if (collections === null || collections === undefined) return false;
    if (Array.isArray(collections)) return collections.length > 0;
    if (typeof collections === "object") return Object.keys(collections).length > 0;
    return true;
}

/**
 * Return the `-collection:name=path` flags configured for an Odin package.
 *
 * @param {object} handle Target handle returned by odinPackage().
 * @returns {Promise<string[]>}
 */
export const collection_flags = memo(async function collection_flags(handle) {
    return Array.from(collection_map(handle), ([name, path]) => `-collection:${name}=${path}`);
});

export const collection_dirs = memo(async function collection_dirs(handle) {
    const seen = new Set();
    const dirs = [];
    for (const path of collection_map(handle).values()) {
        const normalized = normalize_workspace_path(path);
        if (normalized === "." || seen.has(normalized)) continue;
        seen.add(normalized);
        dirs.push(normalized);
    }
    return dirs;
});

function strip_odin_comments(input) {
    let out = "";
    let i = 0;
    let inString = false;
    let inRune = false;
    let inLineComment = false;
    let blockDepth = 0;

    while (i < input.length) {
        const ch = input[i];
        const next = input[i + 1];

        if (inLineComment) {
            if (ch === "\n") {
                inLineComment = false;
                out += "\n";
            } else {
                out += " ";
            }
            i++;
            continue;
        }

        if (blockDepth > 0) {
            if (ch === "/" && next === "*") {
                blockDepth++;
                out += "  ";
                i += 2;
            } else if (ch === "*" && next === "/") {
                blockDepth--;
                out += "  ";
                i += 2;
            } else {
                out += ch === "\n" ? "\n" : " ";
                i++;
            }
            continue;
        }

        if (!inString && !inRune && ch === "/" && next === "/") {
            inLineComment = true;
            out += "  ";
            i += 2;
            continue;
        }
        if (!inString && !inRune && ch === "/" && next === "*") {
            blockDepth = 1;
            out += "  ";
            i += 2;
            continue;
        }

        out += ch;

        if (ch === "\"" && !inRune && input[i - 1] !== "\\") {
            inString = !inString;
        } else if (ch === "'" && !inString && input[i - 1] !== "\\") {
            inRune = !inRune;
        }

        i++;
    }

    return out;
}

export class OdinPackageAnalysis {
    constructor({ sourceFiles = [], packagePath = ".", imports = [], collections = [], hasMainEntrypoint = false } = {}) {
        this.sourceFiles = sourceFiles;
        this.packagePath = packagePath;
        this.imports = imports;
        this.collections = collections;
        this.hasMainEntrypoint = hasMainEntrypoint;
    }
}

function scan_odin_source(content) {
    const text = strip_odin_comments(content);
    const imports = [];
    const single = /^\s*import(?:\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s+"([^"]+)"/gm;
    for (const match of text.matchAll(single)) {
        imports.push(match[1]);
    }

    const blocks = /^\s*import\s*\(([\s\S]*?)^\s*\)/gm;
    for (const block of text.matchAll(blocks)) {
        const entry = /^\s*(?:[A-Za-z_$][A-Za-z0-9_$]*\s+)?"([^"]+)"/gm;
        for (const match of block[1].matchAll(entry)) {
            imports.push(match[1]);
        }
    }

    const uniqueImports = Array.from(new Set(imports)).sort();
    const collections = Array.from(new Set(
        uniqueImports
            .map(imp => {
                const index = imp.indexOf(":");
                return index > 0 ? imp.slice(0, index) : null;
            })
            .filter(Boolean),
    )).sort();
    const hasMainEntrypoint = /^\s*main\s*::\s*proc\s*\(/m.test(text);
    return new OdinPackageAnalysis({
        imports: uniqueImports,
        collections,
        hasMainEntrypoint,
    });
}

function workspace_join(base, path) {
    const parts = [];
    for (const part of `${base || "."}/${path || "."}`.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") {
            if (parts.length === 0) throw new Error(`Odin path escapes the workspace: ${base}/${path}`);
            parts.pop();
            continue;
        }
        parts.push(part);
    }
    return parts.length === 0 ? "." : parts.join("/");
}

function resolved_import_path(importPath, collections) {
    const index = importPath.indexOf(":");
    if (index <= 0) return null;
    const collection = importPath.slice(0, index);
    const relative = importPath.slice(index + 1);
    if (!collections.has(collection)) return null;
    return workspace_join(collections.get(collection), relative);
}

function package_source_paths(pkg) {
    return paths(glob({
        root: pkg.path,
        include: pkg.srcs || ["*.odin"],
        exclude: pkg.exclude || [],
    }));
}

function analysis_for_package(pkg) {
    const sourceFiles = package_source_paths(pkg);
    const packagePath = infer_package_path(pkg, sourceFiles);
    const imports = new Set();
    const collections = new Set();
    let hasMainEntrypoint = false;
    for (const file of sourceFiles) {
        const analysis = scan_odin_source(read_file(file));
        for (const imp of analysis.imports) {
            imports.add(imp);
        }
        for (const collection of analysis.collections) {
            collections.add(collection);
        }
        hasMainEntrypoint = hasMainEntrypoint || analysis.hasMainEntrypoint;
    }
    return new OdinPackageAnalysis({
        sourceFiles,
        packagePath,
        imports: Array.from(imports).sort(),
        collections: Array.from(collections).sort(),
        hasMainEntrypoint,
    });
}

function infer_package_path(pkg, sourceFiles) {
    const declared = normalize_workspace_path(pkg.path || ".");
    if (sourceFiles.length === 0) return declared;

    const sourceDirs = Array.from(new Set(sourceFiles.map(dirname))).sort();
    if (sourceDirs.includes(declared)) return declared;
    if (sourceDirs.length === 1) return sourceDirs[0];

    throw new Error(
        `${pkg.address || "odinPackage"} source files are spread across multiple package directories under '${declared}': ${sourceDirs.join(", ")}. ` +
        "Set path to the directory passed to odin build, or split this into separate odinPackage targets.",
    );
}

function package_spec_from_handle(handle) {
    return {
        address: safe_target_address(handle),
        handle,
        path: declared_path(handle, handle.attrs.path || "."),
        srcs: package_srcs(handle.attrs),
        exclude: package_exclude(handle.attrs),
    };
}

function package_spec_from_workspace_target(target) {
    const handle = target.handle;
    const attrs = { ...target.attrs, ...handle.attrs };
    return {
        address: target.address,
        handle,
        path: declared_path(handle, handle.attrs.path || "."),
        srcs: package_srcs(attrs),
        exclude: package_exclude(attrs),
    };
}

function generated_address_for_dir(dir, name) {
    const module = dir === "." ? "//" : `//${dir}`;
    return `${module}:${name}`;
}

function generated_package_spec(dir) {
    const name = target_name_for_dir(dir);
    return {
        address: generated_address_for_dir(dir, name),
        handle: null,
        path: dir,
        srcs: ["*.odin"],
        exclude: ["*_test.odin", "test_*.odin"],
    };
}

function build_package_index(packages) {
    const index = new Map();
    for (const pkg of packages) {
        const path = normalize_workspace_path(pkg.path || ".");
        const entries = index.get(path) || [];
        if (entries.some(entry => entry.address === pkg.address)) {
            continue;
        }
        entries.push(pkg);
        index.set(path, entries);
    }
    return index;
}

export const imports = memo(async function imports(handle) {
    return (await odinPackageAnalysis(handle)).imports;
});

export const odinPackageAnalysis = memo(async function odinPackageAnalysis(handle) {
    return analysis_for_package(package_spec_from_handle(handle));
});

export const package_index = memo(async function package_index() {
    return build_package_index(
        workspaceTargets("odin-package").map(package_spec_from_workspace_target),
    );
});

function same_package(left, right) {
    if (!left || !right) return false;
    if (left.address && right.address && left.address === right.address) return true;
    if (left.handle && right.handle && left.handle.__id === right.handle.__id) return true;
    return normalize_workspace_path(left.path || ".") === normalize_workspace_path(right.path || ".");
}

function lookup_package(index, path, selfPkg = null) {
    const candidates = (index.get(normalize_workspace_path(path)) || [])
        .filter(pkg => !same_package(pkg, selfPkg));
    if (candidates.length > 1) {
        const labels = candidates.map(pkg => pkg.address).join(", ");
        throw new Error(`Odin import '${path}' resolves to multiple packages: ${labels}`);
    }
    return candidates[0] || null;
}

function infer_dep_entries(pkg, index, collections, analysis = analysis_for_package(pkg)) {
    const deps = new Map();
    for (const imp of analysis.imports) {
        let resolved;
        if (imp.includes(":")) {
            resolved = resolved_import_path(imp, collections);
        } else {
            resolved = workspace_join(analysis.packagePath, imp);
        }
        if (!resolved) continue;
        const dep = lookup_package(index, resolved, pkg);
        if (!dep) continue;
        deps.set(dep.address, dep);
    }
    return Array.from(deps.values()).sort((a, b) => a.address.localeCompare(b.address));
}

export const inferred_deps = memo(async function inferred_deps(handle) {
    const index = await package_index();
    const pkg = package_spec_from_handle(handle);
    const analysis = await odinPackageAnalysis(handle);
    return infer_dep_entries(pkg, index, collection_map(handle), analysis)
        .map(dep => dep.handle)
        .filter(Boolean);
});

function dep_key(handle) {
    const address = safe_target_address(handle);
    return address || `#${handle.__id}`;
}

export const effective_deps = memo(async function effective_deps(handle) {
    const deps = new Map();
    for (const dep of (handle.attrs.deps || []).filter(h => h && h.kind === "odin-package")) {
        deps.set(dep_key(dep), dep);
    }
    for (const dep of await inferred_deps(handle)) {
        deps.set(dep_key(dep), dep);
    }
    return Array.from(deps.values());
});

/**
 * Acquire the Odin toolchain and return a tool spec for sandbox use.
 *
 * @param {object} handle Target handle returned by odinToolchain().
 * @returns {Promise<object>} Tool spec.
 */
export const tool = memo(async function tool(handle) {
    return odinTool(handle.attrs.version);
});

export function default_output_path(handle) {
    return `build/odin/${handle.label.name}`;
}

export function odin_output_path(out, analysis) {
    return analysis.hasMainEntrypoint ? out : `${out}.a`;
}

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

function basename(path) {
    if (path === ".") return "root";
    const index = path.lastIndexOf("/");
    return index < 0 ? path : path.slice(index + 1);
}

function target_name_for_dir(dir) {
    let name = basename(dir).replace(/[^A-Za-z0-9_$]/g, "_");
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

function default_package_source_file(path) {
    const name = basename(path);
    return name.endsWith(".odin")
        && !name.endsWith("_test.odin")
        && !name.startsWith("test_");
}

function default_package_test_file(path) {
    const name = basename(path);
    return name.endsWith("_test.odin") || name.startsWith("test_");
}

function empty_package_error(handle, path) {
    const address = safe_target_address(handle) || "odinPackage";
    return `${address} has no Odin source files after applying srcs/exclude filters at '${path}'. ` +
        "odinPackage excludes *_test.odin and test_*.odin by default; use odinTestPackage for package tests, or pass exclude: [] for a package that intentionally builds test files.";
}

// ---------------------------------------------------------------------------
// Product functions
// ---------------------------------------------------------------------------

/**
 * Build an Odin package.
 *
 * @param {object} handle Target handle returned by odinPackage().
 * @returns {Promise<object>} Run result, plus `outputPath`: the built
 * binary/library's workspace-relative path.
 */
export const odinBuild = product("odin-package", "build",
    async function odinBuild(handle) {
        const toolchainHandle = handle.attrs.toolchain;
        const odinToolSpec = toolchainHandle
            ? await tool(toolchainHandle)
            : odinTool(resolveOdinToolchainVersion(handle.attrs.toolchainVersion));
        const srcs = await sources(handle);
        const genInputs = await collect_gen_sets(handle, new Set());
        const resourceInputs = await resources(handle);
        const flags = await collection_flags(handle);
        const collectionDirs = await collection_dirs(handle);
        const analysis = await odinPackageAnalysis(handle);
        if (analysis.sourceFiles.length === 0) {
            const packagePath = declared_path(handle, handle.attrs.path || ".");
            throw new Error(empty_package_error(handle, packagePath));
        }
        const modeFlags = analysis.hasMainEntrypoint ? [] : ["-build-mode:lib"];
        const path = analysis.packagePath;
        const out = handle.attrs.output || default_output_path(handle);
        const declaredOut = odin_output_path(out, analysis);
        const result = await run({
            argv: [
                "sh",
                "-c",
                "out=$1; pkg=$2; dir_count=$3; shift 3; mkdir -p \"$(dirname \"$out\")\"; while [ \"$dir_count\" -gt 0 ]; do mkdir -p \"$1\"; shift; dir_count=$((dir_count - 1)); done; odin build \"$pkg\" \"-out:$out\" \"$@\"",
                "odin-build",
                output_path(out),
                path,
                String(collectionDirs.length),
                ...collectionDirs,
                ...flags,
                ...modeFlags,
            ],
            tools: [odinToolSpec],
            inputs: [srcs, ...genInputs, resourceInputs],
            outputs: [output(declaredOut)],
            display: `odin build ${path}`,
        });
        return { ...result, outputPath: declaredOut };
    }
);

export const odinTest = product("odin-test-package", "test",
    async function odinTest(handle) {
        const toolchainHandle = handle.attrs.toolchain;
        const odinToolSpec = toolchainHandle
            ? await tool(toolchainHandle)
            : odinTool(resolveOdinToolchainVersion(handle.attrs.toolchainVersion));
        const srcs = await sources(handle);
        const genInputs = await collect_gen_sets(handle, new Set());
        const resourceInputs = await resources(handle);
        const flags = await collection_flags(handle);
        const collectionDirs = await collection_dirs(handle);
        const analysis = await odinPackageAnalysis(handle);
        if (analysis.sourceFiles.length === 0) {
            const packagePath = declared_path(handle, handle.attrs.path || ".");
            throw new Error(empty_package_error(handle, packagePath));
        }
        const path = analysis.packagePath;
        return run({
            argv: [
                "sh",
                "-c",
                "pkg=$1; dir_count=$2; shift 2; while [ \"$dir_count\" -gt 0 ]; do mkdir -p \"$1\"; shift; dir_count=$((dir_count - 1)); done; odin test \"$pkg\" \"$@\"",
                "odin-test",
                path,
                String(collectionDirs.length),
                ...collectionDirs,
                ...flags,
            ],
            tools: [odinToolSpec],
            inputs: [srcs, ...genInputs, resourceInputs],
            impure: true,
            display: `odin test ${path}`,
        });
    }
);

// ---------------------------------------------------------------------------
// Odin source generation
// ---------------------------------------------------------------------------

export const gen_input_sources = memo(async function gen_input_sources(handle) {
    const outPath = declared_path(handle, handle.attrs.out);
    return glob({ root: ".", include: handle.attrs.srcs || [], exclude: [outPath] });
});

export const odinGenRun = product("odin-gen", "build", async function odinGenRun(handle) {
    const inputFiles = await gen_input_sources(handle);
    const outPath = declared_path(handle, handle.attrs.out);

    if (handle.attrs.generator) {
        const mod = await import(handle.attrs.generator);
        const content = await mod.generate({ srcs: handle.attrs.srcs });
        // Content rides in argv so it keys the task cache; no shell
        // interpolation touches it (same pattern as vs.js writeJsonFile).
        return run({
            argv: [
                "sh", "-c",
                'mkdir -p "$(dirname "$1")" && printf %s "$2" > "$1"',
                "odin-gen-write",
                output_path(outPath),
                content,
            ],
            outputs: [output(outPath)],
            display: `generate ${outPath}`,
        });
    }

    return run({
        argv: [...handle.attrs.cmd, outPath],
        inputs: [inputFiles],
        outputs: [output(outPath)],
        sandbox: false,
        impure: true,
        display: `generate ${outPath}`,
    });
});

async function collect_gen_sets(handle, seen) {
    const key = dep_key(handle);
    if (seen.has(key)) return [];
    seen.add(key);

    const sets = [];
    for (const dep of hydrateTarget(handle).deps.map(dep => dep.handle)) {
        if (!dep) continue;
        if (dep.kind === "odin-gen") {
            await odinGenRun(dep);
            const addr = targetAddress(dep);
            const scope = addr.slice(2).split(":")[0];
            const outPath = scope
                ? normalize_workspace_path(`${scope}/${dep.attrs.out}`)
                : normalize_workspace_path(dep.attrs.out);
            sets.push(file_set.literal([outPath]));
        }
    }
    for (const dep of await effective_deps(handle)) {
        sets.push(...await collect_gen_sets(dep, seen));
    }
    return sets;
}

export const generateBuild = product("odin-build-generator", "generate-build",
    async function generateBuild(handle) {
        const files = allUnowned({
            root: handle.attrs.root || ".",
            include: ["**/*.odin"],
            exclude: handle.attrs.exclude || DEFAULT_GENERATE_BUILD_EXCLUDES,
        });
        const normalDirs = new Set(
            files
                .filter(default_package_source_file)
                .map(dirname),
        );
        const testDirs = new Set(
            files
                .filter(default_package_test_file)
                .map(dirname),
        );
        const dirs = Array.from(normalDirs).sort();
        const existingPackages = workspaceTargets("odin-package").map(package_spec_from_workspace_target);
        const existingTestPackages = workspaceTargets("odin-test-package").map(package_spec_from_workspace_target);
        const existingPaths = new Set(existingPackages.map(pkg => normalize_workspace_path(pkg.path || ".")));
        const existingTestPaths = new Set(existingTestPackages.map(pkg => normalize_workspace_path(pkg.path || ".")));
        const generatedPackages = dirs
            .map(generated_package_spec)
            .filter(pkg => !existingPaths.has(normalize_workspace_path(pkg.path || ".")));
        const index = build_package_index([
            ...existingPackages,
            ...generatedPackages,
        ]);
        const collections = collection_map(null);
        const result = {};
        for (const pkg of generatedPackages) {
            const deps = infer_dep_entries(pkg, index, collections)
                .map(dep => targetRef(dep.address));
            const props = { srcs: ["*.odin"] };
            if (deps.length > 0) {
                props.deps = deps;
            }
            append_build_target(result, build_file_for_dir(pkg.path), {
                name: target_name_for_dir(pkg.path),
                rule: "odinPackage",
                props,
            });
        }

        const generatedTestPackages = Array.from(testDirs)
            .sort()
            .map(dir => ({
                ...generated_package_spec(dir),
                srcs: ["*.odin"],
                exclude: [],
            }))
            .filter(pkg => !existingTestPaths.has(normalize_workspace_path(pkg.path || ".")));
        for (const pkg of generatedTestPackages) {
            const deps = infer_dep_entries(pkg, index, collections)
                .map(dep => targetRef(dep.address));
            const props = {};
            if (deps.length > 0) {
                props.deps = deps;
            }
            const baseName = target_name_for_dir(pkg.path);
            append_build_target(result, build_file_for_dir(pkg.path), {
                name: normalDirs.has(pkg.path) ? `${baseName}_test` : baseName,
                rule: "odinTestPackage",
                props,
            });
        }
        return result;
    }
);

// ---------------------------------------------------------------------------
// Target constructors
// ---------------------------------------------------------------------------

/**
 * Declare an Odin source generation target.
 *
 * The generator command is run with the output path appended as the last argument.
 * Generated files must be excluded from any odinPackage glob that covers the same
 * directory — use the `exclude` option of odinPackage to enforce single ownership.
 *
 * @param {object} opts
 * @param {string[]} [opts.srcs=[]] Glob patterns for input files (for incremental tracking).
 * @param {string} opts.out Output file path, relative to the declaring BUILD.js directory.
 * @param {string[]} opts.cmd Command to run; output path is appended as the final argument.
 * @param {Array} [opts.deps=[]] Additional dependencies.
 * @returns {object} Target handle.
 */
export function odinGen({ srcs = [], out, cmd, generator, deps = [] }) {
    if (!out) throw new Error("odinGen requires an 'out' path");
    if (!generator && (!cmd || cmd.length === 0)) throw new Error("odinGen requires either 'cmd' or 'generator'");
    return target({
        kind: "odin-gen",
        attrs: { srcs, out, ...(generator ? { generator } : { cmd }) },
        deps,
    });
}

/**
 * Declare an Odin collection namespace mapping.
 *
 * Prefer workspace config for new code:
 *
 * configure("odin", { collections: { lib: "library" } })
 *
 * @param {object} opts
 * @param {string} opts.name Collection name, e.g. "lib".
 * @param {string} opts.path Workspace-relative collection path, e.g. "library".
 * @returns {object} Target handle.
 */
export function odinCollection({ name, path }) {
    if (!name || !path) {
        throw new Error("odinCollection({ name, path }) requires name and path");
    }
    return target({
        kind: "odin-collection",
        attrs: { name, path },
    });
}

/**
 * Declare an Odin package target.
 *
 * Sources are discovered lazily at build time via own_sources() / sources().
 *
 * @param {object} opts
 * @param {string[]} [opts.srcs=[]] Glob patterns matched against paths relative to opts.path.
 * @param {string[]} [opts.exclude=[]] Glob patterns to exclude from matches.
 * @param {string} [opts.path="."] Workspace-relative package path.
 * @param {object[]|object} [opts.collections=[]] Package-local Odin collection namespace mappings.
 * @param {object|string} [opts.toolchain] Odin toolchain target handle or version string.
 * @param {string} [opts.output] Workspace-relative executable output path.
 * @param {Array} [opts.deps=[]] Odin package and resource package dependencies.
 * @returns {object} Target handle.
 */
export function odinPackage({ srcs = undefined, exclude = undefined, path = ".", collections = [], toolchain, output, deps = [] }) {
    const toolchainHandle = toolchain && toolchain.__imp ? toolchain
                          : (typeof toolchain === "string" ? null : defaultOdinToolchain());
    const toolchainVersion = typeof toolchain === "string" ? toolchain : null;
    const normalizedDeps = normalize_deps(deps);

	// If sources are not specified, default to all .odin files in the package path.
	// Empty source lists are not useful for Odin package builds and produce invalid
	// glob filesets, so treat them like the omitted case.
	srcs = package_srcs({ srcs });

	if (exclude === undefined) {
		// exclude test files by default
		exclude = ["*_test.odin", "test_*.odin"];
	}

    return target({
        kind: "odin-package",
        attrs: {
            path,
            srcs,
            ...(exclude.length ? { exclude } : {}),
            ...(toolchainHandle ? { toolchain: toolchainHandle } : {}),
            ...(toolchainVersion ? { toolchainVersion } : {}),
            ...(output ? { output } : {}),
            ...(has_collection_config(collections) ? { collections } : {}),
            ...(normalizedDeps.length ? { deps: normalizedDeps } : {}),
        },
        sources: sourcesField({
            root: path,
            include: srcs,
            exclude,
        }),
    });
}

/**
 * Declare an Odin test package target.
 *
 * Test packages participate in the `test` goal and run `odin test`.
 * Unlike odinPackage, they include test files by default.
 *
 * @param {object} opts
 * @param {string[]} [opts.srcs=[]] Glob patterns matched against paths relative to opts.path.
 * @param {string[]} [opts.exclude=[]] Glob patterns to exclude from matches.
 * @param {string} [opts.path="."] Workspace-relative package path.
 * @param {object[]|object} [opts.collections=[]] Package-local Odin collection namespace mappings.
 * @param {object|string} [opts.toolchain] Odin toolchain target handle or version string.
 * @param {Array} [opts.deps=[]] Odin package and resource package dependencies.
 * @returns {object} Target handle.
 */
export function odinTestPackage({ srcs = undefined, exclude = undefined, path = ".", collections = [], toolchain, deps = [] }) {
    const toolchainHandle = toolchain && toolchain.__imp ? toolchain
                          : (typeof toolchain === "string" ? null : defaultOdinToolchain());
    const toolchainVersion = typeof toolchain === "string" ? toolchain : null;
    const normalizedDeps = normalize_deps(deps);

    srcs = package_srcs({ srcs });
    exclude = exclude || [];

    return target({
        kind: "odin-test-package",
        attrs: {
            path,
            srcs,
            ...(exclude.length ? { exclude } : {}),
            ...(toolchainHandle ? { toolchain: toolchainHandle } : {}),
            ...(toolchainVersion ? { toolchainVersion } : {}),
            ...(has_collection_config(collections) ? { collections } : {}),
            ...(normalizedDeps.length ? { deps: normalizedDeps } : {}),
        },
        sources: sourcesField({
            root: path,
            include: srcs,
            exclude,
        }),
    });
}

export const odin_test_package = odinTestPackage;

export function odinGenerateBuild({
    root = ".",
    exclude = DEFAULT_GENERATE_BUILD_EXCLUDES,
} = {}) {
    return target({
        kind: "odin-build-generator",
        attrs: { root, exclude },
    });
}
