// Odin formatting mechanics: runs odinfmt over a package's own sources inside
// the sandbox, either writing formatted files back (odinFmt) or diffing
// against the staged input without mutating the tree.
// Exposed to the build graph as products by //rules/workflows/fmt.

import { own_sources, declared_path } from "//rules/odin";
import { resolveOdinToolchainVersion } from "//rules/odin/toolchain";
import { odinfmtTool } from "//rules/odin/odinfmt/toolchain";
import { paths, output, run } from "imp:core";

function odinfmt_version(handle) {
    const toolchainHandle = handle.attrs.toolchain;
    return toolchainHandle
        ? toolchainHandle.attrs.version
        : resolveOdinToolchainVersion(handle.attrs.toolchainVersion);
}

// Reformat a package's own sources in place. Runs odinfmt -w on each file inside
// the sandbox and declares the same paths as outputs, so the formatted files are
// materialized back into the workspace. Only the package's own sources are
// touched; dependencies are formatted by their own targets.
export async function odinFmt(handle) {
    const srcs = await own_sources(handle);
    const files = paths(srcs);
    if (files.length === 0) {
        return { formatted: 0 };
    }
    const { tool, command } = odinfmtTool(odinfmt_version(handle));
    await run({
        argv: [
            "sh",
            "-c",
            `for f in "$@"; do ${command} -w "$f"; done`,
            "odinfmt",
            ...files,
        ],
        tools: [tool],
        inputs: [srcs],
        outputs: files.map(f => output(f)),
        display: `odinfmt ${declared_path(handle, handle.attrs.path || ".")}`,
    });
    return { formatted: files.length };
}

// Verify a package's own sources are already formatted. Formats each file in the
// sandbox and diffs against the staged input; exits non-zero (failing the build)
// if any file would change. Declares no outputs, so it never mutates the tree.
export async function odinFormatCheck(handle) {
    const srcs = await own_sources(handle);
    const files = paths(srcs);
    if (files.length === 0) {
        return { checked: 0 };
    }
    const { tool, command } = odinfmtTool(odinfmt_version(handle));
    await run({
        argv: [
            "sh",
            "-c",
            `status=0; for f in "$@"; do cp "$f" "$f.orig"; ${command} -w "$f"; ` +
                `if ! diff -q "$f.orig" "$f" >/dev/null 2>&1; then ` +
                `echo "not formatted: $f" >&2; status=1; fi; done; exit $status`,
            "odinfmt-check",
            ...files,
        ],
        tools: [tool],
        inputs: [srcs],
        display: `odinfmt --check ${declared_path(handle, handle.attrs.path || ".")}`,
    });
    return { checked: files.length };
}
