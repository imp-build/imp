// JS/TS formatting: biome format has a native check mode (no `--write`
// exits nonzero if any file needs reformatting), so check mode doesn't need
// the digest-diff workaround odinfmt requires — a nonzero exit from `biome
// format` is enough for run() to fail the product, which fmtGoal
// (rules/workflows/fmt_goal.js) already turns into a goal error. The write
// path still uses digestOf/diffDigests, the same generic before/after
// comparison ruffFmt/cargoFmt/odinFmt use, to report an accurate count of
// files actually changed.

import {
	declared_path,
	js_file_sources,
	jsSourcesActionHandle,
} from "//rules/js";
import {
	biomeTool,
	resolveBiomeToolchainVersion,
} from "//rules/js/biome/toolchain";
import { digestOf, diffDigests, output, paths, run } from "imp:core";

// Reformat a target's own JS/TS sources in place, or (when `check` is
// true) verify they're already formatted without writing anything back.
// `biome format` (no `--write`) exits nonzero when any file needs
// reformatting — verified against a real 2.5.4 binary, not assumed from
// docs alone.
export async function biomeFmt(handle, { check = false } = {}) {
	handle = jsSourcesActionHandle(handle);
	const srcs = await js_file_sources(handle);
	const files = paths(srcs);
	if (files.length === 0) {
		return check ? { checked: 0 } : { formatted: 0 };
	}
	const path = declared_path(handle, handle.attrs.src || ".");
	const tool = await biomeTool(resolveBiomeToolchainVersion());

	if (check) {
		await run({
			argv: ["biome", "format", ...files],
			tools: [tool],
			inputs: [srcs],
			display: `biome format --check ${path}`,
		});

		return { checked: files.length };
	}

	const before = digestOf(srcs);

	const result = await run({
		argv: ["biome", "format", "--write", ...files],
		tools: [tool],
		inputs: [srcs],
		outputs: files.map((f) => output(f)),
		materialize: true,
		display: `biome format ${path}`,
	});

	const changes = diffDigests(before, result.outputDigest);
	return { formatted: changes.length };
}
