// Goal-only lint workflow. Importing this module registers the "lint" goal
// but enables no linter on its own — each language's lint integration (e.g.
// //rules/python/ruff/lint) is a separate opt-in import, so callers such as
// `imp init` can enable only the integrations a workspace selected.
//
// No built-in ruleset registers a legacy lint product today — Rust's
// cargoPackage() and odin-package both expose [LINT] directly (see
// //rules/rust, //rules/rust/workspace_expansion, //rules/odin) — so
// lintGoal's resolveProducts fan-out below only matters for targets still
// using the legacy target()/product() API.
//
// Unlike fmtGoal/testGoal, which fail fast on the first target that throws,
// lintGoal runs every selected target to completion: ruffCheck never throws
// for a tool-reported lint failure (it calls run() with allowFailure: true
// and returns { ok, output, fixSupported, fixApplied, outputDigest } instead),
// so nothing here aborts early. Every target's captured output — ANSI codes
// intact, since the underlying tools are invoked with forced color — is
// printed only after every run has finished, followed by a pass/fail summary;
// the goal then fails if any target was unclean, regardless of whether
// `--fix` also fixed some of it.
//
// odin-package follows the same allowFailure/{ok, output, ...} contract as
// ruffCheck, running `odin check -vet` (which has no autofix mode, so it
// always reports fixSupported: false).
import {
	goal,
	resolveProducts,
	goalFlags,
	logInfo,
	writeWorkspace,
} from "imp:core";

// `fix` is passed straight through to each product function as a second
// argument (`fn(handle, {fix})`) rather than registering a second product —
// same convention fmtGoal uses for `--check` (//rules/workflows/fmt). Not
// every lint tool has a fix mode, so the decision of what (if anything) to
// do with `fix` belongs to each linter, not to a product-lookup fallback
// here.
export async function lintGoal(selection) {
	const { fix } = goalFlags();
	const resolved = selection.flatMap(resolveProducts);
	const calls = resolved.map(({ label, fn, handle }) => ({
		label,
		promise: fn(handle, { fix }),
	}));

	const results = [];
	for (const { label, promise } of calls) {
		results.push({ label, ...(await promise) });
	}

	for (const { label, output } of results) {
		if (output) logInfo(`${label}:\n${output}`);
	}

	if (fix) {
		const fixed = results.filter((r) => r.fixApplied);
		if (fixed.length > 0) {
			logInfo(
				`lint --fix: ${fixed.map((r) => r.label).join(", ")} had fixes applied`,
			);
		}
	}

	const failed = results.filter((r) => !r.ok);
	logInfo(
		`lint: ${results.length - failed.length}/${results.length} target(s) clean`,
	);
	if (failed.length > 0) {
		throw new Error(`lint failed: ${failed.map((r) => r.label).join(", ")}`);
	}
}

/** Report graph lint roots using the same result contract as legacy linters. */
export function graphLintGoal(roots) {
	const { fix } = goalFlags();
	const results = roots.map(({ address, result }) => ({
		address,
		...(result?.result || result),
	}));
	if (fix) {
		for (const result of results) {
			if (!result.fixed?.digest || !Array.isArray(result.paths)) continue;
			for (const path of result.paths) {
				writeWorkspace(path, result.fixed.digest, { from: `fixed/${path}` });
			}
		}
	}
	for (const { address, output } of results) {
		if (output) logInfo(`${address}:\n${output}`);
	}
	const fixed = results.filter((result) => result.fixApplied);
	if (fixed.length > 0) {
		logInfo(
			`lint --fix: ${fixed.map((result) => result.address).join(", ")} had fixes applied`,
		);
	}
	const failed = results.filter((result) => !result.ok);
	logInfo(
		`lint: ${results.length - failed.length}/${results.length} target(s) clean`,
	);
	if (failed.length > 0) {
		throw new Error(
			`lint failed: ${failed.map((result) => result.address).join(", ")}`,
		);
	}
}

goal("lint", lintGoal, {
	graph: graphLintGoal,
	flags: { fix: { description: "Automatically fix what can be fixed" } },
});
