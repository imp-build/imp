// Odin formatting mechanics: runs odinfmt over a package's own sources inside
// the sandbox, either writing formatted files back (odinFmt) or diffing
// against the staged input without mutating the tree.
// Exposed to the build graph as products by //rules/workflows/fmt.

import { own_sources, declared_path } from "//rules/odin";
import { resolveOdinToolchainVersion } from "//rules/odin/toolchain";
import { odinfmtTool } from "//rules/odin/odinfmt/toolchain";
import { paths, output, run, read_file } from "imp:core";

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

// Verify a package's own sources are already formatted, without writing or
// diffing anything. odinfmt has no built-in check/dry-run mode: printing to
// stdout (rather than -w, which writes the formatted bytes to disk) is the
// only way to get the formatted result without mutating the file, so each
// file is compared against its real on-disk content in JS instead of via a
// sandboxed `cp`+`diff` (those aren't declared tools, and per the sandbox's
// hermetic PATH — see resolve_program/sandbox_command_env in src/exec.rs —
// undeclared host binaries silently aren't found there). Reports only which
// files would change, not the actual diff.
export async function odinFormatCheck(handle) {
    const srcs = await own_sources(handle);
    const files = paths(srcs);
    if (files.length === 0) {
        return { checked: 0 };
    }
    const { tool, command } = odinfmtTool(odinfmt_version(handle));
    const checked = await Promise.all(
        files.map(async (file) => {
            const { stdout } = await run({
                argv: ["sh", "-c", `${command} "$1"`, "odinfmt-check", file],
                tools: [tool],
                inputs: [srcs],
                display: `odinfmt --check ${file}`,
            });
            // Printing to stdout appends one trailing newline for terminal
            // display that -w's direct write wouldn't produce; strip it
            // before comparing against the real file.
            const formatted = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
            return formatted === read_file(file) ? null : file;
        }),
    );
    const unformatted = checked.filter((file) => file !== null);
    if (unformatted.length > 0) {
        throw new Error(`not formatted: ${unformatted.join(", ")}`);
    }
    return { checked: files.length };
}
