// Python linting: `ruff check` exits nonzero when it finds violations, which
// is a normal lint outcome, not a build-system error — unlike fmt/test, the
// lint goal (rules/workflows/lint.js) runs every selected target to
// completion and reports a combined summary, so `run()` is called with
// `allowFailure: true` and the pass/fail decision is made from the returned
// exitCode instead of a thrown exception.

import { declared_path, python_file_sources } from "//rules/python";
import {
	resolveRuffToolchainVersion,
	ruffTool,
} from "//rules/python/ruff_toolchain";
import { digestOf, diffDigests, output, paths, run } from "imp:core";

// Check a target's own Python sources with ruff, without writing anything
// back unless `fix` is requested. `--color=always` forces ruff's diagnostic
// colors even though stdout/stderr are piped rather than a tty. `ruff check
// --fix` still exits nonzero when unsafe/unfixable violations remain, so
// `ok` keeps coming straight from `exitCode` either way.
export async function ruffCheck(handle, { fix = false } = {}) {
	const srcs = await python_file_sources(handle);
	const files = paths(srcs);
	if (files.length === 0) {
		return {
			ok: true,
			output: "",
			fixSupported: true,
			fixApplied: false,
			outputDigest: null,
		};
	}
	const path = declared_path(handle, handle.attrs.src || ".");
	const tool = await ruffTool(resolveRuffToolchainVersion());
	const before = fix ? digestOf(srcs) : null;

	const result = await run({
		argv: [
			"ruff",
			"check",
			"--color=always",
			...(fix ? ["--fix"] : []),
			...files,
		],
		tools: [tool],
		inputs: [srcs],
		...(fix ? { outputs: files.map((f) => output(f)), materialize: true } : {}),
		allowFailure: true,
		display: `ruff check ${fix ? "--fix " : ""}${path}`,
	});

	const changed = fix ? diffDigests(before, result.outputDigest) : [];
	return {
		ok: result.exitCode === 0,
		output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
		fixSupported: true,
		fixApplied: changed.length > 0,
		outputDigest: fix ? result.outputDigest : null,
	};
}
