import {
    Target,
    glob,
    memo,
    output,
    output_path,
    paths,
    platformInfo,
    product,
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
    gccTool,
} from "//rules/c/gcc/toolchain";

// Registers the "build" goal's artifact summary callback for consumers that
// import Rust build rules without importing the workflows layer explicitly.
import "//rules/workflows/build_workflow";

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

export function rust_toolchain_version(handle) {
    const toolchainHandle = handle.attrs.toolchain;
    return toolchainHandle
        ? toolchainHandle.attrs.version
        : resolveRustToolchainVersion(handle.attrs.toolchainVersion);
}

// cargo/rustc need a real C linker in the hermetic sandbox. Linux reuses the
// pinned Bootlin gcc toolchain Odin already relies on and points rustc at its
// "clang" wrapper. Windows uses the host MinGW gcc discovered via PATH; the
// Bootlin archive is Linux-only and cannot provide a native Windows linker.
async function rustLinkerTools() {
    if (platformInfo().os === "windows") {
        return {
            tools: [await nativeToolSpec(nativeTool("gcc"))],
            rustflags: "-C linker=gcc",
        };
    }
    const gcc = defaultGccToolchain();
    if (!gcc) {
        throw new Error("cargo builds need a declared gccToolchain() default — see //rules/c/gcc");
    }
    return {
        tools: [await nativeToolSpec(nativeTool("dirname")), await gccTool(gcc.attrs.version)],
        rustflags: "-C linker=clang",
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
        const linker = await rustLinkerTools();

        const path = declared_path(handle, handle.attrs.path || ".");
        const srcs = await sources(handle);

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
                `${path}/Cargo.toml`, buildDir, linker.rustflags,
                ...(handle.attrs.release ? ["--release"] : []),
                ...handle.attrs.cargoArgs,
            ],
            tools: [...toolSpec.tools, ...linker.tools],
            env: [`RUSTUP_HOME=${toolSpec.rustupHome}`, `CARGO_HOME=${toolSpec.cargoHome}`],
            inputs: [srcs],
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
        const linker = await rustLinkerTools();

        const path = declared_path(handle, handle.attrs.path || ".");
        const srcs = await sources(handle);
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
                `${path}/Cargo.toml`, buildDir, linker.rustflags,
                ...handle.attrs.testArgs,
            ],
            tools: [...toolSpec.tools, ...linker.tools],
            env: [`RUSTUP_HOME=${toolSpec.rustupHome}`, `CARGO_HOME=${toolSpec.cargoHome}`],
            inputs: [srcs],
            impure: true,
            display: `cargo test ${path}`,
        });
    }
);

// ---------------------------------------------------------------------------
// Target constructor
// ---------------------------------------------------------------------------

export class CargoPackage extends Target {
    static kind = "cargo-package";
    constructor({ path = ".", bin, release = false, toolchain, cargoArgs = [], testArgs = [] }) {
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
            },
            sources: sourcesField({
                root: path,
                include: ["Cargo.toml", "Cargo.lock", "**/*.rs"],
                exclude: ["target/**"],
            }),
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
 * @returns {object} Target handle.
 */
export function cargoPackage({ path = ".", bin, release = false, toolchain, cargoArgs = [], testArgs = [] }) {
    return new CargoPackage({ path, bin, release, toolchain, cargoArgs, testArgs });
}
