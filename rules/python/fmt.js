// Python formatting: like rustfmt, ruff format has a native `--check` mode,
// so format-check doesn't need the digest-diff workaround odinfmt requires —
// a nonzero exit from `ruff format --check` is enough for run() to fail the
// product, which fmtGoal (rules/workflows/fmt.js) already turns into a goal
// error. The write path (`ruffFmt`) still uses digestOf/diffDigests, the same
// generic before/after comparison cargoFmt/odinFmt use, to report an accurate
// count of files actually changed.

import { declared_path, python_file_sources } from "//rules/python";
import { resolveRuffToolchainVersion, ruffTool } from "//rules/python/ruff_toolchain";
import { digestOf, diffDigests, output, paths, run } from "imp:core";

// Reformat a target's own Python sources in place.
export async function ruffFmt(handle) {
    const srcs = await python_file_sources(handle);
    const files = paths(srcs);
    if (files.length === 0) {
        return { formatted: 0 };
    }
    const path = declared_path(handle, handle.attrs.src || ".");
    const tool = await ruffTool(resolveRuffToolchainVersion());
    const before = digestOf(srcs);

    const result = await run({
        argv: ["ruff", "format", ...files],
        tools: [tool],
        inputs: [srcs],
        outputs: files.map((f) => output(f)),
        materialize: true,
        display: `ruff format ${path}`,
    });

    const changes = diffDigests(before, result.outputDigest);
    return { formatted: changes.length };
}

// Verify a target's own Python sources are already formatted, without
// writing anything back. `ruff format --check` exits nonzero on unformatted
// files, which run() surfaces as a thrown error — no per-file parsing needed.
export async function ruffFormatCheck(handle) {
    const srcs = await python_file_sources(handle);
    const files = paths(srcs);
    if (files.length === 0) {
        return { checked: 0 };
    }
    const path = declared_path(handle, handle.attrs.src || ".");
    const tool = await ruffTool(resolveRuffToolchainVersion());

    await run({
        argv: ["ruff", "format", "--check", ...files],
        tools: [tool],
        inputs: [srcs],
        display: `ruff format --check ${path}`,
    });

    return { checked: files.length };
}
