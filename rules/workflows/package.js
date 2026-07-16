// The "package" goal is seeded by default in HostState::default() (src/spike.rs),
// but declared explicitly here (like build/test/fmt/run) so its callback,
// packageGoal, actually runs instead of Rust's generic per-target dispatch.
//
// A `package` product describes what to publish rather than publishing it:
// it builds with materialize:false, then returns artifact(digest, {from})
// (imp:core) — a digest plus an optional subtree path within it.
// packageGoal below is the only thing that materializes that artifact (via
// writeWorkspace, no sandbox, no cache record, no run()-level materialize:true
// warning) and reports on it (via digestStat) — so every package product's
// output lands under a predictable dist/ path (distPathFor()) and gets the
// same summary, instead of each rule hand-picking a path and printing nothing.
// See docs/BUILD.js's site_package for the reference implementation.
//
// odin-package's package product (odinDistPackage, rules/odin/index.js)
// publishes the built binary/archive the same way. The legacy Rust command
// (src/commands/package.rs, no longer wired into the binary) built a
// content pak, copied game binaries and license files into a per-platform
// dist/ directory, and zipped the result, with platform/version as CLI
// arguments — a richer packaging story (content-pack + binary composed into
// a distributable zip) than odinDistPackage's plain binary publish, and
// still a TODO if that's needed again.

import {
	digestStat,
	goal,
	logInfo,
	resolveProducts,
	targetAddress,
	writeWorkspace,
} from "imp:core";

/**
 * Derive a target's dist/ destination from its workspace address (e.g.
 * "//docs:site" → "dist/docs/site"), so package products don't each pick
 * their own ad hoc path.
 *
 * @param {object} handle A target handle returned by target().
 * @returns {string} Workspace-relative dist/ path.
 */
export function distPathFor(handle) {
	const address = targetAddress(handle);
	const withoutSlashes = address.replace(/^\/\//, "");
	const [dir, name] = withoutSlashes.split(":");
	return dir ? `dist/${dir}/${name}` : `dist/${name}`;
}

function formatSize(bytes) {
	if (bytes < 1024) {
		return `${bytes}B`;
	}
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(1)}${units[unit]}`;
}

/**
 * Resolve every selected target's package product, publish whatever
 * artifact(...) it returns to dist/, and print a summary of what got
 * published. A product returning null/undefined means there's nothing to
 * publish for that target (e.g. a cargo crate with no binaries) — skipped,
 * not an error.
 *
 * @param {Array<{id: number, address: string, kind: string, product: string|object}>} selection
 */
export async function packageGoal(selection) {
	const resolved = selection.flatMap(resolveProducts);
	const published = [];
	for (const { label, fn, handle } of resolved) {
		let result;
		try {
			result = await fn(handle);
		} catch (e) {
			throw new Error(`${label}: ${e && e.message ? e.message : e}`);
		}
		if (result == null) {
			continue;
		}
		if (!result.__imp_artifact) {
			throw new Error(
				`${label}: package product must return artifact(digest, opts) or null/undefined, got ${JSON.stringify(result)}`,
			);
		}
		const dest = distPathFor(handle);
		writeWorkspace(dest, result.digest, { from: result.from });
		const stat = digestStat(result.digest, result.from);
		published.push({ label, dest, digest: result.digest, ...stat });
	}
	if (published.length === 0) {
		logInfo("Packaged 0 targets");
		return;
	}
	logInfo(
		`Packaged ${published.length} target${published.length === 1 ? "" : "s"}:`,
	);
	for (const p of published) {
		logInfo(
			`  ${p.label} -> ${p.dest} (${p.fileCount} file${p.fileCount === 1 ? "" : "s"}, ${formatSize(p.totalSize)}, ${p.digest})`,
		);
	}
}

goal("package", packageGoal);
