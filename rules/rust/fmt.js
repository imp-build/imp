// Rust formatting: unlike odinfmt (rules/odin/odinfmt), rustfmt has a native
// `--check` mode, so format-check doesn't need the digest-diff workaround —
// a nonzero exit from `cargo fmt --check` is enough for run() to fail the
// product, which fmtGoal (rules/workflows/fmt.js) already turns into a goal
// error. The write path (`cargoFmt`) still uses digestOf/diffDigests, the
// same generic before/after comparison odinFmt uses, to report an accurate
// count of files actually changed.

import { declared_path, rust_file_sources, rust_toolchain_version, sources } from "//rules/rust";
import { rustTool } from "//rules/rust/toolchain";
import { digestOf, diffDigests, output, paths, run } from "imp:core";

function cargoFmtEnv(toolSpec) {
    return [`RUSTUP_HOME=${toolSpec.rustupHome}`, `CARGO_HOME=${toolSpec.cargoHome}`];
}

// Reformat a crate's own sources in place.
export async function cargoFmt(handle) {
    const rustSrcs = await rust_file_sources(handle);
    const files = paths(rustSrcs);
    if (files.length === 0) {
        return { formatted: 0 };
    }
    const path = declared_path(handle, handle.attrs.path || ".");
    const toolSpec = await rustTool(rust_toolchain_version(handle));
    const before = digestOf(rustSrcs);

    // cargo needs Cargo.toml/Cargo.lock staged too, not just the .rs files
    // that get reformatted/materialized back.
    const result = await run({
        argv: ["sh", "-c", 'cargo fmt --manifest-path "$1"', "cargo-fmt", `${path}/Cargo.toml`],
        tools: toolSpec.tools,
        env: cargoFmtEnv(toolSpec),
        inputs: [await sources(handle)],
        outputs: files.map((f) => output(f)),
        materialize: true,
        display: `cargo fmt ${path}`,
    });

    const changes = diffDigests(before, result.outputDigest);
    return { formatted: changes.length };
}

// Verify a crate's own sources are already formatted, without writing
// anything back. `cargo fmt --check` exits nonzero on unformatted files,
// which run() surfaces as a thrown error — no per-file parsing needed.
export async function cargoFormatCheck(handle) {
    const files = paths(await rust_file_sources(handle));
    if (files.length === 0) {
        return { checked: 0 };
    }
    const path = declared_path(handle, handle.attrs.path || ".");
    const toolSpec = await rustTool(rust_toolchain_version(handle));

    await run({
        argv: ["sh", "-c", 'cargo fmt --manifest-path "$1" --check', "cargo-fmt-check", `${path}/Cargo.toml`],
        tools: toolSpec.tools,
        env: cargoFmtEnv(toolSpec),
        inputs: [await sources(handle)],
        display: `cargo fmt --check ${path}`,
    });

    return { checked: files.length };
}
