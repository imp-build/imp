// Odin formatting mechanics: runs odinfmt -w over a package's own sources
// inside the sandbox and compares the resulting output digest against the
// pre-run digest of the same files, rather than scraping stdout — odinfmt has
// no dry-run/check mode, and shelling out to a sandboxed `diff` isn't an
// option (undeclared host binaries aren't visible on the sandbox's hermetic
// PATH; see resolve_program/sandbox_command_env in src/exec.rs). Write mode
// and check mode share the same run, differing only in whether the result is
// materialized back into the workspace.
// Exposed to the build graph as a product by //rules/workflows/fmt.

import {
	own_sources,
	declared_path,
	OdinPackage,
	OdinTestPackage,
} from "//rules/odin";
import { resolveOdinToolchainVersion } from "//rules/odin/toolchain";
import { odinfmtTool } from "//rules/odin/odinfmt/toolchain";
import {
	paths,
	output,
	run,
	digestOf,
	diffDigests,
	product,
	FMT,
} from "imp:core";
import { ODINFMT_TOOL } from "//rules/odin/odinfmt/toolchain";

export {
	defaultOdinfmtToolchain,
	odinfmtToolchain,
} from "//rules/odin/odinfmt/toolchain";

function odinfmt_version(handle) {
	const toolchainHandle = handle.attrs.toolchain;
	return toolchainHandle
		? toolchainHandle.attrs.version
		: resolveOdinToolchainVersion(handle.attrs.toolchainVersion);
}

// Runs odinfmt -w over a package's own sources inside the sandbox, and
// returns the set of files whose content actually changed (by digest, not by
// timestamp/existence). When `materialize` is true (write mode), the
// formatted files are copied back into the real workspace; when false (check
// mode), the sandboxed result is captured into CAS and diffed, but the
// workspace is left untouched.
async function runOdinFmt(handle, { materialize }) {
	const srcs = await own_sources(handle);
	const files = paths(srcs);
	if (files.length === 0) {
		return { total: 0, changed: [] };
	}
	const before = digestOf(srcs);
	const { tool, command } = await odinfmtTool(odinfmt_version(handle));
	const result = await run({
		argv: [
			"sh",
			"-c",
			`for f in "$@"; do ${command} -w "$f"; done`,
			"odinfmt",
			...files,
		],
		tools: [tool],
		inputs: [srcs],
		outputs: files.map((f) => output(f)),
		materialize,
		display: `odinfmt ${materialize ? "" : "--check "}${declared_path(handle, handle.attrs.path || ".")}`,
	});
	const changes = diffDigests(before, result.outputDigest);
	return { total: files.length, changed: changes.map((c) => c.path) };
}

// Reformat a package's own sources in place, or (when `check` is true)
// verify they're already formatted without writing anything back. Only the
// package's own sources are touched; dependencies are formatted by their own
// targets. Check mode does not throw on its own — the fmt goal callback
// (rules/workflows/fmt_goal.js) decides whether unformatted files are a
// failure, so every selected target gets checked and reported before any
// error is raised.
export async function odinFmt(handle, { check = false } = {}) {
	const { total, changed } = await runOdinFmt(handle, {
		materialize: !check,
	});
	return check
		? { checked: total, unformatted: changed }
		: { formatted: changed.length };
}

export const odinPackageFmt = product(OdinPackage, FMT, ODINFMT_TOOL, odinFmt, {
	display: "fmt {0}",
	level: "info",
});
export const odinTestPackageFmt = product(
	OdinTestPackage,
	FMT,
	ODINFMT_TOOL,
	odinFmt,
	{ display: "fmt {0}", level: "info" },
);
