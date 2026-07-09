import {
    Target,
    file_set,
    glob,
    hydrateTarget,
    memo,
    output,
    output_path,
    paths,
    platformInfo,
    product,
    productFor,
    run,
    sourcesField,
    targetAddress,
} from "imp:core";

import {
    defaultRustToolchain,
    resolveRustToolchainVersion,
    rustTool,
    rustToolchain,
} from "//rules/rust/toolchain";

import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";

import {
    defaultGccToolchain,
} from "//rules/c/gcc/toolchain";

import {
    resources as resource_package_sources,
} from "//rules/asset";

// Registers the "build" goal's artifact summary callback for consumers that
// import Rust build rules without importing the workflows layer explicitly.
import "//rules/workflows/build_workflow";

// Registers the rust_test fan-out (expandCargoTests + rust_test's build/test
// products) for consumers that import Rust build rules without importing
// //rules/rust/test explicitly — same reasoning as the build_workflow import
// above. Side-effect only; nothing exported from it is used in this file.
import "//rules/rust/test";

// Registers the "generate-build" product (auto-declaring cargoPackage()
// targets for unowned Cargo.toml files) for the same reason.
import "//rules/rust/generate_build";

export {
    acquireRustToolchain,
    defaultRustToolchain,
    defaultRustToolchainVersion,
    resolveRustToolchainVersion,
    rustArtifactName,
    rustBin,
    rustCacheKey,
    rustDownloadUrl,
    rustTool,
    rustToolchain,
} from "//rules/rust/toolchain";

// ---------------------------------------------------------------------------
// Path helpers (same pattern as rules/odin/index.js, rules/c/cmake/index.js)
// ---------------------------------------------------------------------------

function normalize_workspace_path(path) {
    const parts = [];
    for (const part of path.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") {
            throw new Error(`Rust paths must stay within the workspace: ${path}`);
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

// ---------------------------------------------------------------------------
// Source discovery
// ---------------------------------------------------------------------------

// Just the crate's .rs files — used by fmt, which only ever reformats source
// files (not Cargo.toml/Cargo.lock).
export const rust_file_sources = memo(async function rust_file_sources(handle) {
    const root = declared_path(handle, handle.attrs.path || ".");
    return glob({ root, include: ["**/*.rs"], exclude: ["target/**"] });
});

// Everything cargo build needs to see: manifest, lockfile (if present), and
// sources. Multi-crate workspaces (a workspace-root Cargo.lock shared across
// members) aren't supported yet — cargoPackage assumes a self-contained crate.
export const sources = memo(async function sources(handle) {
    const root = declared_path(handle, handle.attrs.path || ".");
    return glob({ root, include: ["Cargo.toml", "Cargo.lock", "**/*.rs"], exclude: ["target/**"] });
});

// FileSet of a cargoPackage's declared resource-package deps (see
// //rules/asset's resourcePackage) — same pattern rules/odin/index.js's
// `resources` uses, minus the transitive-package-dep recursion (a
// cargoPackage has no notion of depending on another cargoPackage the way
// an odinPackage depends on other odin-package targets; Cargo itself owns
// crate-to-crate deps via Cargo.toml/the registry).
export const resources = memo(async function resources(handle) {
    const sets = (hydrateTarget(handle).deps || [])
        .map(dep => dep.handle)
        .filter(dep => dep && dep.kind === "resource-package");
    if (sets.length === 0) return file_set.literal([]);
    const resolved = await Promise.all(sets.map(resource_package_sources));
    return resolved.length === 1 ? resolved[0] : file_set.union(...resolved);
});

export function rust_toolchain_version(handle) {
    const toolchainHandle = handle.attrs.toolchain;
    return toolchainHandle
        ? toolchainHandle.attrs.version
        : resolveRustToolchainVersion(handle.attrs.toolchainVersion);
}

// cargo/rustc need a real C link driver in the hermetic sandbox — rustc
// shells out to a program literally named "cc" by default. Reuse the gcc
// toolchain Odin already relies on for the same reason (rules/odin/index.js's
// odinScriptTools): its "rust-link-driver" product exposes a "clang"-named
// wrapper script on PATH that execs the real (prefixed) gcc binary, so
// pointing rustc's linker at "clang" sidesteps needing a "cc" alias of our
// own. A workspace can additionally opt into a faster backend linker (e.g.
// mold) via rustToolchain({ linker: moldToolchain() }); by default no extra
// -fuse-ld= flag is added.
//
// Windows has no pinned toolchain to plug into this abstraction (the Bootlin
// gcc archive is Linux-only) — it always uses the host's own MinGW gcc,
// discovered via PATH, regardless of any declared rustToolchain/linkDriver.
export async function rustLinkerTools(toolchainHandle) {
    if (platformInfo().os === "windows") {
        return {
            tools: [await nativeToolSpec(nativeTool("gcc"))],
            rustflags: "-C linker=gcc",
            env: [],
        };
    }
    const linkDriverHandle = (toolchainHandle && toolchainHandle.attrs.linkDriver) || defaultGccToolchain();
    if (!linkDriverHandle) {
        throw new Error("cargo builds need a declared gccToolchain() default, or a rustToolchain({ linkDriver }) — see //rules/c/gcc");
    }
    const linkDriver = await productFor(linkDriverHandle, "rust-link-driver");

    const linkerHandle = toolchainHandle && toolchainHandle.attrs.linker;
    const linker = linkerHandle ? await productFor(linkerHandle, "rust-linker") : null;

    const sccacheActive = !!(toolchainHandle && toolchainHandle.attrs.sccache);
    const tools = [...(await linkDriver.tools()), ...(linker ? await linker.tools() : [])];
    const rustflags = [...(await linkDriver.rustflags()), ...(linker ? await linker.rustflags() : [])].join(" ");
    const env = await linkDriver.env(sccacheActive);
    return { tools, rustflags, env };
}

// Optional rustc build-caching layer (e.g. sccache, //rules/rust/sccache),
// wired independently of the linker abstraction above since it wraps rustc
// itself rather than the link step. Opt in via
// rustToolchain({ sccache: sccacheToolchain() }); no-ops otherwise.
export async function rustBuildCacheTools(toolchainHandle) {
    const sccacheHandle = toolchainHandle && toolchainHandle.attrs.sccache;
    if (!sccacheHandle) {
        return { tools: [], env: [] };
    }
    const wrapper = await productFor(sccacheHandle, "rust-build-cache");
    return {
        tools: await wrapper.tools(),
        env: await wrapper.env(),
    };
}

// Resolve RUSTUP_HOME/CARGO_HOME/PATH for invoking cargo/rustc.
//
// Normally these are sandbox-relative "tool" mount aliases (toolSpec.tools +
// toolSpec.rustupHome/cargoHome) — reproducible and explicitly tracked as
// build inputs, per the sandbox's usual hermeticity model.
//
// When sccache is wrapping rustc, that per-sandbox aliasing itself becomes a
// bug: sccache's long-lived server caches detected "compiler info" keyed by
// the *canonicalized* exe path (resolving the sandbox symlink down to the
// same real, stable toolchain directory every time — see
// mozilla/sccache's src/server.rs `compiler_info()`), but the *literal*
// (uncanonicalized) exe path embedded in that cached entry — the one
// actually used to spawn the compiler on a cache miss — is whichever
// sandbox's path happened to be seen first. Once that first sandbox is torn
// down, every later build sharing the same server fails with "No such file
// or directory" trying to invoke a compiler at a path that no longer
// exists, even though the exact same toolchain is trivially reachable via
// the *current* sandbox's own (different) symlink.
//
// The fix is to make the literal exe path identical across every sandbox in
// the first place: when sccache is active, resolve cargo/rustc through the
// real, absolute, stable named-cache directory (toolSpec.rustupHomeAbs/
// cargoHomeAbs) instead of the sandbox-relative alias, and skip mounting
// the sandbox "tool" copies at all — mirroring the same real-path-over-
// sandbox-mount tradeoff already made for sccache's own data directory (see
// sccacheDataDir() in //rules/rust/sccache/toolchain).
export function rustToolEnv(toolSpec, sccacheActive) {
    if (!sccacheActive) {
        return {
            tools: toolSpec.tools,
            env: [`RUSTUP_HOME=${toolSpec.rustupHome}`, `CARGO_HOME=${toolSpec.cargoHome}`],
        };
    }
    return {
        tools: [],
        env: [
            `RUSTUP_HOME=${toolSpec.rustupHomeAbs}`,
            `CARGO_HOME=${toolSpec.cargoHomeAbs}`,
            `PATH=${toolSpec.rustupHomeAbs}/toolchains/${toolSpec.toolchainId}/bin:${toolSpec.cargoHomeAbs}/bin`,
        ],
    };
}

// ---------------------------------------------------------------------------
// Product functions
// ---------------------------------------------------------------------------

/**
 * Build a Cargo binary crate.
 *
 * @param {object} handle Target handle returned by cargoPackage().
 * @returns {Promise<object>} Run result, plus `outputPaths`: the built
 * binaries' workspace-relative paths, one per `bin` entry.
 */
export const cargoBuild = product("cargo-package", "build",
    async function cargoBuild(handle) {
        const toolSpec = await rustTool(rust_toolchain_version(handle));
        const toolchainHandle = handle.attrs.toolchain || defaultRustToolchain();
        const { tools: linkerTools, rustflags, env: linkerEnv } = await rustLinkerTools(toolchainHandle);
        const { tools: cacheTools, env: cacheEnv } = await rustBuildCacheTools(toolchainHandle);
        const { tools: rustTools, env: rustEnv } = rustToolEnv(toolSpec, !!(toolchainHandle && toolchainHandle.attrs.sccache));

        const path = declared_path(handle, handle.attrs.path || ".");
        const srcs = await sources(handle);
        const resourceInputs = await resources(handle);

        const profile = handle.attrs.release ? "release" : "debug";
        const buildDir = output_path(`build/rust/${path === "." ? "root" : path}`);
        const plat = platformInfo();
        const exeSuffix = plat.os === "windows" ? ".exe" : "";
        const outPaths = handle.attrs.bins.map((name) => `${buildDir}/${profile}/${name}${exeSuffix}`);

        const script = 'manifest=$1; target_dir=$2; rustflags=$3; shift 3; ' +
            'RUSTFLAGS="$rustflags" cargo build --manifest-path "$manifest" --target-dir "$target_dir" "$@"';

        const result = await run({
            argv: [
                "sh", "-c", script, "cargo-build",
                `${path}/Cargo.toml`, buildDir, rustflags,
                ...(handle.attrs.release ? ["--release"] : []),
                ...handle.attrs.cargoArgs,
            ],
            tools: [...rustTools, ...linkerTools, ...cacheTools],
            env: [...rustEnv, ...linkerEnv, ...cacheEnv],
            inputs: [srcs, resourceInputs],
            outputs: outPaths.map((p) => output(output_path(p))),
            materialize: true,
            display: `cargo build ${path}`,
        });

        return { ...result, outputPaths: outPaths };
    }
);

/**
 * Run a Cargo binary crate's tests.
 *
 * Unlike Odin (which compiles a separate odin-test-package target excluding
 * test files from its regular build), Cargo compiles test code from the same
 * crate/manifest — `sources()` already globs the whole crate, tests
 * included — so this reuses the cargo-package target directly rather than
 * needing a distinct test target kind.
 *
 * @param {object} handle Target handle returned by cargoPackage().
 * @returns {Promise<object>} Run result from `cargo test`.
 */
export const cargoTest = product("cargo-package", "test",
    async function cargoTest(handle) {
        const toolSpec = await rustTool(rust_toolchain_version(handle));
        const toolchainHandle = handle.attrs.toolchain || defaultRustToolchain();
        const { tools: linkerTools, rustflags, env: linkerEnv } = await rustLinkerTools(toolchainHandle);
        const { tools: cacheTools, env: cacheEnv } = await rustBuildCacheTools(toolchainHandle);
        const { tools: rustTools, env: rustEnv } = rustToolEnv(toolSpec, !!(toolchainHandle && toolchainHandle.attrs.sccache));

        const path = declared_path(handle, handle.attrs.path || ".");
        const srcs = await sources(handle);
        const resourceInputs = await resources(handle);
        const buildDir = output_path(`build/rust/${path === "." ? "root" : path}`);

        const script = 'manifest=$1; target_dir=$2; rustflags=$3; shift 3; ' +
            'RUSTFLAGS="$rustflags" cargo test --manifest-path "$manifest" --target-dir "$target_dir" "$@"';

        // No outputs/materialize: test binaries aren't user-addressable
        // artifacts. impure: true so a re-run always executes the tests
        // rather than replaying a cached pass/fail from the task cache —
        // same choice Odin's odinTest makes.
        return run({
            argv: [
                "sh", "-c", script, "cargo-test",
                `${path}/Cargo.toml`, buildDir, rustflags,
                ...handle.attrs.testArgs,
            ],
            tools: [...rustTools, ...linkerTools, ...cacheTools],
            env: [...rustEnv, ...linkerEnv, ...cacheEnv],
            inputs: [srcs, resourceInputs],
            impure: true,
            display: `cargo test ${path}`,
        });
    }
);

// ---------------------------------------------------------------------------
// Target constructor
// ---------------------------------------------------------------------------

export function normalize_deps(deps) {
    return deps
        .map(d => (d && d.__imp ? d : (d && d.target ? d.target : null)))
        .filter(Boolean);
}

export class CargoPackage extends Target {
    static kind = "cargo-package";
    constructor({ path = ".", bin, release = false, toolchain, cargoArgs = [], testArgs = [], deps = [] }) {
        if (!bin) {
            throw new Error("cargoPackage requires 'bin' (the binary name(s) cargo produces)");
        }
        const bins = Array.isArray(bin) ? bin : [bin];
        if (bins.length === 0) {
            throw new Error("cargoPackage 'bin' must include at least one binary name");
        }

        const toolchainHandle = toolchain && toolchain.__imp === true ? toolchain
                              : (typeof toolchain === "string" ? null : defaultRustToolchain());
        const toolchainVersion = typeof toolchain === "string" ? toolchain : null;

        const normalizedDeps = normalize_deps(deps);
        const allDeps = [
            ...(toolchainHandle ? [{ target: toolchainHandle }] : []),
            ...normalizedDeps.map(target => ({ target })),
        ];

        super({
            kind: CargoPackage.kind,
            attrs: {
                path,
                bins,
                release,
                cargoArgs,
                testArgs,
                ...(toolchainHandle ? { toolchain: toolchainHandle } : {}),
                ...(toolchainVersion ? { toolchainVersion } : {}),
                ...(normalizedDeps.length ? { deps: normalizedDeps } : {}),
            },
            sources: sourcesField({
                root: path,
                include: ["Cargo.toml", "Cargo.lock", "**/*.rs"],
                exclude: ["target/**"],
            }),
            deps: allDeps,
        });
    }
}

/**
 * Declare a Cargo binary crate target. Library crates and multi-crate
 * workspaces aren't supported yet — declare one cargoPackage per
 * self-contained binary crate.
 *
 * @category target
 * @param {object} opts
 * @param {string} [opts.path="."] Workspace-relative directory containing Cargo.toml.
 * @param {string|string[]} opts.bin Binary name(s) cargo produces (matches `[[bin]]`/package name in Cargo.toml).
 * @param {boolean} [opts.release=false] Build with `cargo build --release`.
 * @param {object|string} [opts.toolchain] Rust toolchain target handle or version string.
 * @param {string[]} [opts.cargoArgs=[]] Extra arguments appended to `cargo build`.
 * @param {string[]} [opts.testArgs=[]] Extra arguments appended to `cargo test`.
 * @param {Array<object>} [opts.deps=[]] Extra deps, e.g. a resourcePackage() (see //rules/asset) providing non-.rs files an `include_str!`/`include_bytes!` needs.
 * @returns {object} Target handle.
 */
export function cargoPackage({ path = ".", bin, release = false, toolchain, cargoArgs = [], testArgs = [], deps = [] }) {
    return new CargoPackage({ path, bin, release, toolchain, cargoArgs, testArgs, deps });
}
