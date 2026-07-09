// Fans a cargoPackage out into one separately-addressable, separately-
// runnable `rust_test` target per compiled test binary (a lib's
// `#[cfg(test)]` unit tests, each bin's unit tests, each `tests/*.rs`
// integration-test file) — mirrors how rules/c/cmake/index.js's
// expandCmakeProject fans a CMake project out into per-executable cc_test
// targets, using `cargo test --no-run --message-format=json` as the
// structural equivalent of CMake's generated Ninja graph: it compiles every
// test binary without running any of them, and reports each one's compiled
// path as a JSON message on stdout.
//
// Doc-tests aren't discoverable this way (they only ever run through a real
// `cargo test`, never `--no-run`) — they're still covered by the existing,
// unscoped cargoTest product on cargo-package itself; this fan-out is
// additive, not a replacement.

import {
    Target,
    expand,
    output,
    output_path,
    product,
    registerTarget,
    run,
    targetAddress,
} from "imp:core";

import {
    declared_path,
    defaultRustToolchain,
    normalize_deps,
    resources,
    rust_toolchain_version,
    rustBuildCacheTools,
    rustLinkerTools,
    rustToolEnv,
    sources,
} from "//rules/rust";

import { rustTool } from "//rules/rust/toolchain";

function safe_target_address(handle) {
    if (!handle || handle.__imp !== true) return null;
    try {
        return targetAddress(handle);
    } catch (_) {
        return null;
    }
}

// Compiles every test binary in the crate (without running any of them) and
// materializes the whole cargo target-dir, same as cargoBuild/cargoTest's
// toolchain/linker resolution. Shared by the expander below (to discover
// binaries from stdout) and by each minted rust_test's own "build" product
// (a task-cache hit once the discovery call above has already run, since
// the argv/inputs are identical) — the target-dir is declared as a
// materialized directory output, so every binary it contains already sits
// at its normal on-disk path afterwards, with no per-binary staging step
// needed.
async function buildTestBinaries(handle) {
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
        'RUSTFLAGS="$rustflags" cargo test --no-run --message-format=json --manifest-path "$manifest" --target-dir "$target_dir" "$@"';

    const result = await run({
        argv: ["sh", "-c", script, "cargo-test-build", `${path}/Cargo.toml`, buildDir, rustflags],
        tools: [...rustTools, ...linkerTools, ...cacheTools],
        env: [...rustEnv, ...linkerEnv, ...cacheEnv],
        inputs: [srcs, resourceInputs],
        outputs: [output(output_path(buildDir), { kind: "directory" })],
        materialize: true,
        display: `cargo test --no-run ${path}`,
    });

    return { result, buildDir, path };
}

// Parses `cargo test --no-run --message-format=json`'s newline-delimited
// stdout for compiled test-binary artifacts (reliable across task-cache
// hits — run()'s stdout is itself part of the persisted cache record, not
// miss-only) and rebases each absolute executable path onto the
// workspace-relative buildDir it was compiled under.
export function parseTestBinaries(stdout, buildDir) {
    const binaries = [];
    for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg;
        try {
            msg = JSON.parse(trimmed);
        } catch (_) {
            continue;
        }
        if (msg.reason !== "compiler-artifact" || !msg.executable || !(msg.profile && msg.profile.test)) continue;
        const idx = msg.executable.indexOf(buildDir);
        const executable = idx === -1 ? msg.executable : msg.executable.slice(idx);
        binaries.push({
            name: msg.target.name,
            kind: (msg.target.kind && msg.target.kind[0]) || "test",
            executable,
        });
    }
    return binaries;
}

export class RustTest extends Target {
    static kind = "rust_test";
    constructor({ path = ".", buildDir, toolchain, toolchainVersion, executable, testArgs = [], deps = [] }) {
        // Forwards the parent cargoPackage's own resource-package deps (see
        // //rules/asset) so resources(handle) resolves the same way for a
        // fanned-out rust_test as it does for the parent — the whole crate
        // (this test binary included) is recompiled from the same sources,
        // so it needs the same extra files.
        const normalizedDeps = normalize_deps(deps);
        super({
            kind: RustTest.kind,
            attrs: {
                path,
                buildDir,
                executable,
                testArgs,
                ...(toolchain ? { toolchain } : {}),
                ...(toolchainVersion ? { toolchainVersion } : {}),
                ...(normalizedDeps.length ? { deps: normalizedDeps } : {}),
            },
            deps: [
                ...(toolchain ? [{ target: toolchain }] : []),
                ...normalizedDeps.map(target => ({ target })),
            ],
        });
    }
}

export const rustTestBuild = product("rust_test", "build", async function rustTestBuild(handle) {
    await buildTestBinaries(handle);
    return { outputPath: handle.attrs.executable };
});

// No outputs/materialize on this final step: test results aren't
// user-addressable artifacts. impure: true so a re-run always executes
// the binary rather than replaying a cached pass/fail from the task
// cache — same choice cargoTest/odinTest/runCTest make.
//
// --test-threads=1 makes this one binary's own #[test] fns run serially —
// the fan-out itself is what gets the parallelism/isolation (each binary is
// its own imp target, its own sandbox), not thread-level concurrency
// within a single binary.
export const rustTestRun = product("rust_test", "test", async function rustTestRun(handle) {
    await rustTestBuild(handle);
    return run({
        argv: [handle.attrs.executable, "--test-threads=1", ...handle.attrs.testArgs],
        inputs: [{ kind: "directory", path: handle.attrs.buildDir }],
        impure: true,
        display: `cargo test binary ${handle.attrs.executable}`,
    });
});

// Runs at most once per invocation, only for cargo-package targets actually
// reachable from the current goal's selection (see `ensure_expanded` in
// spike.rs) — buildTestBinaries' `cargo test --no-run` is itself a normal
// content-keyed task-cache entry, so this doesn't recompile on every build
// once a crate's tests are unchanged.
//
// Minted addresses are prefixed with the parent cargoPackage's own target
// name (`${parentName}_tests_${discoveredName}`) to avoid collisions: a
// discovered binary's name (crate name for lib unit tests, bin name for bin
// unit tests, file stem for integration tests) can otherwise collide with
// the parent's own hand-declared name, or with a sibling cargoPackage's
// discovered binaries in the same directory.
export const expandCargoTests = expand("cargo-package", async function expandCargoTests(handle) {
    const { result, buildDir } = await buildTestBinaries(handle);
    const binaries = parseTestBinaries(result.stdout, buildDir);

    const parentAddress = safe_target_address(handle);
    if (!parentAddress) return;
    const [scope, parentName] = [parentAddress.split(":")[0], parentAddress.split(":")[1]];

    for (const bin of binaries) {
        registerTarget(
            new RustTest({
                path: handle.attrs.path,
                buildDir,
                toolchain: handle.attrs.toolchain,
                toolchainVersion: handle.attrs.toolchainVersion,
                executable: bin.executable,
                testArgs: [],
                deps: handle.attrs.deps || [],
            }),
            `${scope}:${parentName}_tests_${bin.name}`,
        );
    }
});
