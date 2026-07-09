import {
    Target,
    allUnowned,
    file_set,
    glob,
    memo,
    output,
    output_path,
    paths,
    product,
    productFor,
    read_file,
    registerBuildRule,
    run,
    sourcesField,
    targetAddress,
    workspaceTargets,
} from "imp:core";

import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";
import {
    defaultGccToolchain,
    gccTool,
} from "//rules/c/gcc/toolchain";
import {
    defaultZigToolchain,
    zigBuildCacheTool,
    zigGlobalCacheEnv,
    zigTool,
} from "//rules/c/zig/toolchain";

// Generated BUILD.js files can reference these rule names regardless of which
// module implements the target constructor.
registerBuildRule({ rule: "ccLibrary", importFrom: "//rules/c" });
registerBuildRule({ rule: "ccBinary", importFrom: "//rules/c" });
registerBuildRule({ rule: "cmakeLib", importFrom: "//rules/c/cmake" });

export const DEFAULT_CPP_SRCS = [
    "**/*.c",
    "**/*.cc",
    "**/*.cpp",
    "**/*.cxx",
];

export const DEFAULT_CPP_HDRS = [
    "**/*.h",
    "**/*.hh",
    "**/*.hpp",
    "**/*.hxx",
];

const DEFAULT_GENERATE_BUILD_EXCLUDES = [
    "**/.*/**",
    "**/build/**",
    "**/coverage/**",
    "**/dist/**",
    "**/obj/**",
    "**/target/**",
    "**/vendor/**",
];

function normalize_workspace_path(path) {
    const parts = [];
    for (const part of path.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") {
            throw new Error(`C/C++ paths must stay within the workspace: ${path}`);
        }
        parts.push(part);
    }
    return parts.length === 0 ? "." : parts.join("/");
}

function safe_target_address(handle) {
    if (!handle || handle.__imp !== true) return null;
    try {
        return targetAddress(handle);
    } catch (_) {
        return null;
    }
}

function declaring_directory(handle) {
    const address = safe_target_address(handle);
    if (!address || !address.startsWith("//")) return ".";
    const scope = address.slice(2).split(":")[0];
    return scope.length === 0 ? "." : scope;
}

export function declared_path(handle, path = ".") {
    const base = declaring_directory(handle);
    const local = path || ".";
    if (base === ".") return normalize_workspace_path(local);
    if (local === ".") return base;
    return normalize_workspace_path(`${base}/${local}`);
}

function dirname(path) {
    const index = path.lastIndexOf("/");
    return index < 0 ? "." : path.slice(0, index);
}

function basename(path) {
    const index = path.lastIndexOf("/");
    return index < 0 ? path : path.slice(index + 1);
}

function build_file_for_dir(dir) {
    return dir === "." ? "BUILD.js" : `${dir}/BUILD.js`;
}

function sanitize_identifier(raw) {
    let name = raw.replace(/[^A-Za-z0-9_$]/g, "_");
    if (name.length === 0) name = "root";
    if (!/^[A-Za-z_$]/.test(name)) name = `_${name}`;
    return name;
}

function target_name_for_dir(dir) {
    if (dir === ".") return "root";
    return sanitize_identifier(basename(dir));
}

function append_build_target(result, file, target) {
    if (!result[file]) result[file] = [];
    result[file].push(target);
}

function normalize_deps(deps) {
    return deps
        .map(d => d && d.__imp ? d : (d && d.target ? d.target : null))
        .filter(Boolean);
}

function source_ext(path) {
    const match = /\.([^.\/]+)$/.exec(path);
    return match ? match[1].toLowerCase() : "";
}

function is_cxx_source(path) {
    return ["cc", "cpp", "cxx"].includes(source_ext(path));
}

function object_path_for(handle, source) {
    const label = safe_target_address(handle)
        ? targetAddress(handle).slice(2).replace(/[^A-Za-z0-9_.-]/g, "_")
        : `target_${handle.__id}`;
    const name = source.replace(/[^A-Za-z0-9_.-]/g, "_");
    return `build/c/${label}/${name}.o`;
}

function default_output_path(handle, extension) {
    const address = safe_target_address(handle);
    const name = address ? address.slice(address.lastIndexOf(":") + 1) : `target_${handle.__id}`;
    return `build/c/${name}${extension}`;
}

function shell_quote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function strip_c_comments_and_strings(input) {
    let out = "";
    let i = 0;
    let inString = false;
    let inChar = false;
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

        if (!inString && !inChar && ch === "/" && next === "/") {
            inLineComment = true;
            out += "  ";
            i += 2;
            continue;
        }
        if (!inString && !inChar && ch === "/" && next === "*") {
            blockDepth = 1;
            out += "  ";
            i += 2;
            continue;
        }

        if (inString || inChar) {
            out += ch === "\n" ? "\n" : " ";
            if (ch === "\\" && next !== undefined) {
                out += next === "\n" ? "\n" : " ";
                i += 2;
                continue;
            }
            if (inString && ch === "\"") inString = false;
            if (inChar && ch === "'") inChar = false;
            i++;
            continue;
        }

        if (ch === "\"") {
            inString = true;
            out += " ";
            i++;
            continue;
        }
        if (ch === "'") {
            inChar = true;
            out += " ";
            i++;
            continue;
        }

        out += ch;
        i++;
    }

    return out;
}

export function has_c_main_entrypoint(sourceText) {
    const text = strip_c_comments_and_strings(sourceText);
    return /(?:^|[^\w])main\s*\(/m.test(text);
}

export class CcTarget extends Target {
    constructor({
        kind,
        path = ".",
        srcs = DEFAULT_CPP_SRCS,
        hdrs = DEFAULT_CPP_HDRS,
        deps = [],
        toolchain,
        copts = [],
        linkopts = [],
        output: out,
        backend = "raw",
        backendAttrs = {},
    }) {
        if (toolchain && toolchain.__imp !== true) {
            throw new Error("ccLibrary/ccBinary toolchain must be a target handle providing cc-toolchain");
        }
        const normalizedDeps = normalize_deps(deps);
        const toolchainHandle = toolchain && toolchain.__imp === true
            ? toolchain
            : (!toolchain ? (defaultZigToolchain() || defaultGccToolchain()) : null);
        const allDeps = [
            ...(toolchainHandle ? [{ target: toolchainHandle, mode: "tool" }] : []),
            ...normalizedDeps.map(target => ({ target })),
        ];

        super({
            kind,
            attrs: {
                path,
                srcs,
                hdrs,
                deps: normalizedDeps,
                copts,
                linkopts,
                backend,
                ...(out ? { output: out } : {}),
                ...(toolchainHandle ? { toolchain: toolchainHandle } : {}),
                ...backendAttrs,
            },
            sources: sourcesField({
                root: path,
                include: [...srcs, ...hdrs],
                exclude: [],
            }),
            deps: allDeps,
        });
    }
}

export class CcLibrary extends CcTarget {
    static kind = "cc_library";
    constructor(opts = {}) {
        super({ ...opts, kind: CcLibrary.kind });
    }
}

export class CcBinary extends CcTarget {
    static kind = "cc_binary";
    constructor(opts = {}) {
        super({ ...opts, kind: CcBinary.kind });
    }
}

/**
 * Declare a raw C/C++ library target.
 *
 * @category target
 * @param {object} opts
 * @param {string} [opts.path="."]
 * @param {string[]} [opts.srcs]
 * @param {string[]} [opts.hdrs]
 * @param {Array} [opts.deps=[]]
 * @param {object} [opts.toolchain] Toolchain handle providing the cc-toolchain product.
 * @param {string[]} [opts.copts=[]]
 * @param {string[]} [opts.linkopts=[]]
 * @param {string} [opts.output]
 * @returns {object} Target handle.
 */
export function ccLibrary(opts = {}) {
    return new CcLibrary(opts);
}

/**
 * Declare a raw C/C++ binary target.
 *
 * @category target
 * @param {object} opts
 * @param {string} [opts.path="."]
 * @param {string[]} [opts.srcs]
 * @param {string[]} [opts.hdrs]
 * @param {Array} [opts.deps=[]]
 * @param {object} [opts.toolchain] Toolchain handle providing the cc-toolchain product.
 * @param {string[]} [opts.copts=[]]
 * @param {string[]} [opts.linkopts=[]]
 * @param {string} [opts.output]
 * @returns {object} Target handle.
 */
export function ccBinary(opts = {}) {
    return new CcBinary(opts);
}

export const own_sources = memo(async function own_sources(handle) {
    return glob({
        root: declared_path(handle, handle.attrs.path || "."),
        include: handle.attrs.srcs || DEFAULT_CPP_SRCS,
    });
});

const headers = memo(async function headers(handle) {
    return glob({
        root: declared_path(handle, handle.attrs.path || "."),
        include: handle.attrs.hdrs || DEFAULT_CPP_HDRS,
    });
});

class GccCcToolchain {
    constructor(handle) {
        this.handle = handle;
    }

    async tools() {
        return [
            await nativeToolSpec(nativeTool("dirname")),
            await nativeToolSpec(nativeTool("mkdir")),
            await gccTool(this.handle.attrs.version),
        ];
    }

    env() {
        return [];
    }

    compiler(source) {
        return is_cxx_source(source) ? ["c++"] : ["clang"];
    }

    linker(needsCxx) {
        return needsCxx ? ["c++"] : ["clang"];
    }

    archiver() {
        return ["ar"];
    }
}

class ZigCcToolchain {
    constructor(handle) {
        this.handle = handle;
    }

    async tools() {
        return [
            await nativeToolSpec(nativeTool("dirname")),
            await nativeToolSpec(nativeTool("mkdir")),
            await zigTool(this.handle.attrs.version),
            await zigBuildCacheTool(this.handle.attrs.version),
        ];
    }

    env() {
        return zigGlobalCacheEnv();
    }

    compiler(source) {
        return is_cxx_source(source) ? ["zig", "c++"] : ["zig", "cc"];
    }

    linker(needsCxx) {
        return needsCxx ? ["zig", "c++"] : ["zig", "cc"];
    }

    archiver() {
        return ["zig", "ar"];
    }
}

product("gcc-toolchain", "cc-toolchain", (handle) => new GccCcToolchain(handle));
product("zig-toolchain", "cc-toolchain", (handle) => new ZigCcToolchain(handle));

async function ccToolchainFor(handle) {
    const toolchain = handle.attrs.toolchain || defaultZigToolchain() || defaultGccToolchain();
    if (!toolchain) {
        throw new Error("C/C++ builds need an explicit toolchain or a declared default zigToolchain()/gccToolchain()");
    }
    return productFor(toolchain, "cc-toolchain");
}

async function compileRawObjects(handle, toolchain) {
    const sourcePaths = paths(await own_sources(handle));
    const headerInputs = await headers(handle);
    const tools = await toolchain.tools();
    const env = toolchain.env();
    const objects = [];

    for (const source of sourcePaths) {
        const obj = object_path_for(handle, source);
        objects.push({ source, object: obj });
        const compiler = toolchain.compiler(source);
        const args = [...compiler, "-c", source, "-o", obj, ...(handle.attrs.copts || [])];
        const script = `mkdir -p "$(dirname "$1")" && shift && "$@"`;
        await run({
            argv: ["sh", "-c", script, "cc-compile", obj, ...args],
            tools,
            env,
            inputs: [{ kind: "file", path: source }, headerInputs],
            outputs: [output(output_path(obj))],
            materialize: true,
            display: `cc compile ${source}`,
        });
    }

    return objects;
}

export const cc_link_artifacts = memo(async function cc_link_artifacts(handle) {
    if (handle.attrs.backend === "cmake") {
        const cmake = await import("//rules/c/cmake");
        return cmake.cmake_link_artifacts(handle);
    }
    const result = await ccBuild(handle);
    return file_set.literal(result && result.outputPath ? [result.outputPath] : []);
});

async function buildRawLibrary(handle) {
    const toolchain = await ccToolchainFor(handle);
    const objects = await compileRawObjects(handle, toolchain);
    const outPath = handle.attrs.output || default_output_path(handle, ".a");
    const tools = await toolchain.tools();
    const env = toolchain.env();
    const ar = toolchain.archiver();
    const objectPaths = objects.map(obj => obj.object);
    const script = `mkdir -p "$(dirname "$1")" && ${ar.map(shell_quote).join(" ")} rcs "$1" ${objectPaths.map(shell_quote).join(" ")}`;
    const result = await run({
        argv: ["sh", "-c", script, "cc-archive", outPath],
        tools,
        env,
        inputs: objectPaths.map(path => ({ kind: "file", path })),
        outputs: [output(output_path(outPath))],
        materialize: true,
        display: `cc archive ${outPath}`,
    });
    result.outputPath = outPath;
    return result;
}

async function depLinkArtifacts(handle) {
    const sets = [];
    for (const dep of (handle.attrs.deps || []).filter(h => h && h.kind === "cc_library")) {
        sets.push(await cc_link_artifacts(dep));
    }
    if (sets.length === 0) return file_set.literal([]);
    return sets.length === 1 ? sets[0] : file_set.union(...sets);
}

async function buildRawBinary(handle) {
    const toolchain = await ccToolchainFor(handle);
    const objects = await compileRawObjects(handle, toolchain);
    const linkInputs = await depLinkArtifacts(handle);
    const outPath = handle.attrs.output || default_output_path(handle, "");
    const tools = await toolchain.tools();
    const env = toolchain.env();
    const sourcePaths = objects.map(obj => obj.source);
    const needsCxx = sourcePaths.some(is_cxx_source);
    const linker = toolchain.linker(needsCxx);
    const objectPaths = objects.map(obj => obj.object);
    const linkPaths = paths(linkInputs);
    const script = `mkdir -p "$(dirname "$1")" && ${linker.map(shell_quote).join(" ")} -o "$1" ${objectPaths.map(shell_quote).join(" ")} ${linkPaths.map(shell_quote).join(" ")} ${(handle.attrs.linkopts || []).map(shell_quote).join(" ")}`;
    const result = await run({
        argv: ["sh", "-c", script, "cc-link", outPath],
        tools,
        env,
        inputs: [...objectPaths.map(path => ({ kind: "file", path })), linkInputs],
        outputs: [output(output_path(outPath))],
        materialize: true,
        display: `cc link ${outPath}`,
    });
    result.outputPath = outPath;
    return result;
}

export const ccBuild = product("cc_library", "build", async function ccBuild(handle) {
    if (handle.attrs.backend === "cmake") {
        const cmake = await import("//rules/c/cmake");
        return cmake.buildCmakeArtifact(handle);
    }
    return buildRawLibrary(handle);
});

product("cc_binary", "build", async function ccBinaryBuild(handle) {
    if (handle.attrs.backend === "cmake") {
        const cmake = await import("//rules/c/cmake");
        return cmake.buildCmakeArtifact(handle);
    }
    return buildRawBinary(handle);
});

product("cc_test", "build", async function ccTestBuild(handle) {
    if (handle.attrs.backend === "cmake") {
        const cmake = await import("//rules/c/cmake");
        return cmake.buildCmakeArtifact(handle);
    }
    return buildRawBinary(handle);
});

product("cc_test", "test", async function ccTestRun(handle) {
    if (handle.attrs.backend === "cmake") {
        const cmake = await import("//rules/c/cmake");
        return cmake.runCTest(handle);
    }
    throw new Error("raw cc_test is not implemented");
});

function path_is_under(path, root) {
    const normalizedPath = normalize_workspace_path(path);
    const normalizedRoot = normalize_workspace_path(root);
    return normalizedRoot === "."
        ? normalizedPath !== "."
        : normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function source_has_main(path) {
    if (!["c", "cc", "cpp", "cxx"].includes(source_ext(path))) return false;
    return has_c_main_entrypoint(read_file(path));
}

export const generateBuild = product("cpp-build-generator", "generate-build",
    async function generateBuild(handle) {
        const root = handle.attrs.root || ".";
        const exclude = handle.attrs.exclude || DEFAULT_GENERATE_BUILD_EXCLUDES;
        const files = allUnowned({
            root,
            include: ["**/CMakeLists.txt", ...DEFAULT_CPP_SRCS, ...DEFAULT_CPP_HDRS],
            exclude,
        });

        const existingPaths = new Set([
            ...workspaceTargets("cc_library").map(({ handle: h }) => declared_path(h, h.attrs.path || ".")),
            ...workspaceTargets("cc_binary").map(({ handle: h }) => declared_path(h, h.attrs.path || ".")),
            ...workspaceTargets("cmake-lib").map(({ handle: h }) => declared_path(h, h.attrs.src || ".")),
        ].map(normalize_workspace_path));

        const cmakeDirs = Array.from(new Set(
            files
                .filter(path => basename(path) === "CMakeLists.txt")
                .map(dirname),
        )).sort();

        const result = {};
        for (const dir of cmakeDirs) {
            if (existingPaths.has(normalize_workspace_path(dir))) continue;
            append_build_target(result, build_file_for_dir(dir), {
                name: `${target_name_for_dir(dir)}_cmake`,
                rule: "cmakeLib",
                props: {},
            });
        }

        const cmakeRoots = cmakeDirs.filter(dir => !existingPaths.has(normalize_workspace_path(dir)));
        const rawSources = files
            .filter(path => ["c", "cc", "cpp", "cxx"].includes(source_ext(path)))
            .filter(path => !cmakeRoots.some(root => path_is_under(path, root)));

        const rawDirs = Array.from(new Set(rawSources.map(dirname))).sort();
        for (const dir of rawDirs) {
            if (existingPaths.has(normalize_workspace_path(dir))) continue;
            const dirSources = rawSources.filter(path => dirname(path) === dir);
            const hasMain = dirSources.some(source_has_main);
            append_build_target(result, build_file_for_dir(dir), {
                name: target_name_for_dir(dir),
                rule: hasMain ? "ccBinary" : "ccLibrary",
                props: {},
            });
        }

        return result;
    }
);

export class CppGenerateBuild extends Target {
    static kind = "cpp-build-generator";
    constructor({ root = ".", exclude = DEFAULT_GENERATE_BUILD_EXCLUDES } = {}) {
        super({
            kind: CppGenerateBuild.kind,
            attrs: { root, exclude },
        });
    }
}

/**
 * Declare a C/C++ BUILD.js generation scanner target.
 *
 * @category target
 * @param {object} [opts]
 * @param {string} [opts.root="."]
 * @param {string[]} [opts.exclude]
 * @returns {object} Target handle.
 */
export function cppGenerateBuild({ root = ".", exclude = DEFAULT_GENERATE_BUILD_EXCLUDES } = {}) {
    return new CppGenerateBuild({ root, exclude });
}
