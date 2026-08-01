// The "gen-builtin-lockfiles" goal: regenerate every shipped toolchain
// lockfile from its registerBuiltinLockfile() spec (rules/workflows/
// lockfiles.js), independent of which toolchain targets any workspace
// declares. The checked-in locks are derived state — each registered version
// list is the source of truth, and regeneration writes exactly those
// versions.
//
// The toolchain module imports below are load-bearing: registration happens
// at module load, so every module shipping a builtin lockfile must be
// imported here. Invoke as `imp goal gen-builtin-lockfiles` (no selector —
// the callback ignores the selection and walks the registry).

import { goal, logInfo } from "imp:core";
import {
	builtinLockfiles,
	generateBuiltinLockfile,
} from "//rules/workflows/lockfiles";

import "//rules/c/cmake";
import "//rules/c/gcc";
import "//rules/c/mold";
import "//rules/c/zig";
import "//rules/js/biome/toolchain";
import "//rules/js/node/toolchain";
import "//rules/js/pnpm/toolchain";
import "//rules/oci/toolchain";
import "//rules/odin/toolchain";
import "//rules/odin/odinfmt/toolchain";
import "//rules/python/pex_toolchain";
import "//rules/python/ruff_toolchain";
import "//rules/python/uv_toolchain";
import "//rules/rust/kache/toolchain";
import "//rules/rust/toolchain";
import "//rules/zola";

async function genBuiltinLockfiles() {
	const specs = builtinLockfiles();
	if (specs.length === 0) {
		throw new Error(
			"no builtin lockfiles registered; did the toolchain module imports change?",
		);
	}
	for (const spec of specs) {
		logInfo(
			`lock ${spec.name} ${spec.versions.join(", ")} -> ${spec.lockfile}`,
		);
		await generateBuiltinLockfile(spec);
	}
}

goal("gen-builtin-lockfiles", genBuiltinLockfiles, { selection: "none" });
