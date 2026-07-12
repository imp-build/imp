// Python linting: `ruff check` exits nonzero when it finds violations, which
// is a normal lint outcome, not a build-system error — unlike fmt/test, the
// lint goal (rules/workflows/lint.js) runs every selected target to
// completion and reports a combined summary, so `run()` is called with
// `allowFailure: true` and the pass/fail decision is made from the returned
// exitCode instead of a thrown exception.

import { declared_path, python_file_sources } from "//rules/python";
import { resolveRuffToolchainVersion, ruffTool } from "//rules/python/ruff_toolchain";
import { paths, run } from "imp:core";

// Check a target's own Python sources with ruff, without writing anything
// back. `--color=always` forces ruff's diagnostic colors even though stdout/
// stderr are piped rather than a tty.
export async function ruffCheck(handle) {
    const srcs = await python_file_sources(handle);
    const files = paths(srcs);
    if (files.length === 0) {
        return { ok: true, output: "" };
    }
    const path = declared_path(handle, handle.attrs.src || ".");
    const tool = await ruffTool(resolveRuffToolchainVersion());

    const result = await run({
        argv: ["ruff", "check", "--color=always", ...files],
        tools: [tool],
        inputs: [srcs],
        allowFailure: true,
        display: `ruff check ${path}`,
    });

    return {
        ok: result.exitCode === 0,
        output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
    };
}
