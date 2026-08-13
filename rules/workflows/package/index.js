// The "package" goal is seeded by default in HostState::default()
// (crates/imp-engine/src/spike.rs), but declared explicitly here (like
// build/test/fmt/run) so its graph handler, graphPackageGoal, actually runs
// instead of Rust's generic per-target dispatch.
//
// Because the seeded goal makes `imp package` a valid command in every
// workspace, a workspace that never loads this module gets a full build and
// no dist/ output at all: crates/imp-engine/src/spike.rs only calls the
// handler if one is registered. Every rule module that sets [PACKAGE] on an
// export therefore imports this module itself (rules/odin/index.js,
// rules/rust/index.js, rules/c/index.js, rules/c/cmake/expansion.js,
// rules/python/graph.js, rules/oci/index.js), the same way they already
// import //rules/workflows/build.
//
// A `package` root describes what to publish rather than publishing it: it
// builds with materialize:false, then returns artifact(digest, {from})
// (imp:core) — a digest plus an optional subtree path within it.
// graphPackageGoal below materializes those artifacts and reports on them.
// Label handlers bypass this goal and publish their own artifacts —
// attach(label, "package", fn) (the `packageGoal()` sugar in imp:core) is a
// separate, still-supported mechanism and is unaffected by this goal's own
// dispatch. It uses the same dist/ address convention.
//
// The legacy Rust command (crates/imp/src/commands/package.rs, since
// deleted) built a content pak, copied game binaries and license files into
// a per-platform dist/ directory, and zipped the result, with
// platform/version as CLI arguments — a richer packaging story (content-pack
// + binary composed into a distributable zip) than the plain binary publish
// below, and still a TODO if that's needed again.

import { goal, goalError, logInfo, writeWorkspace } from "imp:core";

/** Publish graph package roots at the same workflow boundary as legacy artifacts. */
export function graphPackageGoal(roots) {
	const published = [];
	for (const { address, result } of roots) {
		if (!result || result.type !== "artifact" || !result.digest) {
			throw goalError(
				`${address}: package graph root must resolve to an artifact handle`,
			);
		}
		const withoutSlashes = address.replace(/^\/\//, "");
		const [dir, name] = withoutSlashes.split(":");
		const dest = dir ? `dist/${dir}/${name}` : `dist/${name}`;
		writeWorkspace(dest, result.digest, { from: result.path });
		published.push({ address, dest });
	}
	if (published.length > 0) {
		logInfo(
			`Packaged ${published.length} target${published.length === 1 ? "" : "s"}:` +
				published.map(({ address, dest }) => `\n  ${address} -> ${dest}`).join(""),
		);
	}
}

export const PACKAGE = goal("package", undefined, { graph: graphPackageGoal });
