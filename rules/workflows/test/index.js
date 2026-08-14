// Every built-in ruleset is graph-native and exposes [TEST] directly today
// (Odin, rules-test's rulesTest(), Rust's cargoPackage(), ...). A selected
// [TEST] root resolves to a list of execution-unit results — one entry per
// file (Python), test binary (Rust), CMake test target, or Odin package,
// matching the granularity each underlying tool reports natively rather than
// exploding down to individual test cases:
//
//   [{ name, ok, output }]
//
// `output` (combined stdout+stderr) is only meaningful — and only present —
// for a failing unit; the same allowFailure/{ok, output} contract [LINT]
// already uses (see //rules/rust/workspace_expansion, //rules/odin,
// //rules/c/cmake). graphTestGoal aggregates every selected root's units so
// one failing target doesn't hide another selected target's results — graph
// execution runs every selected root concurrently, and previously a thrown
// exception from the first failure aborted visibility into the rest.
//
// The legacy target()/product() dispatch this goal used to fall back to has
// been retired. attach(label, "test", fn) (the `test()` sugar in imp:core)
// is a separate, still-supported mechanism and is unaffected.
import { goal, goalError } from "imp:core";

// Returned (on an all-passing run) or thrown as the goalError message (on any
// failure) rather than logged: the live progress UI's logger suspends and
// redraws indicatif per line, which fights a burst of ~one-line-per-unit
// output for the terminal. Returning/throwing a plain string instead lets the
// host print it with a plain `println!`/`eprintln!` once the UI has already
// been torn down (see execute_goal_live_selection's `report` capture and
// `run()` in crates/imp/src/main.rs).
function formatReport(units) {
	const sorted = [...units].sort(
		(a, b) =>
			a.address.localeCompare(b.address) || a.name.localeCompare(b.name),
	);
	const lines = sorted.map(
		(unit) => `${unit.ok ? "PASS" : "FAIL"} ${unit.address} ${unit.name}`,
	);
	const failed = units.filter((unit) => !unit.ok);
	for (const unit of failed) {
		if (unit.output) lines.push(`${unit.address} ${unit.name}:\n${unit.output}`);
	}
	lines.push(`test: ${units.length - failed.length}/${units.length} unit(s) passed`);
	return lines.join("\n");
}

/** Aggregate every selected [TEST] root's execution-unit results and report once. */
export function graphTestGoal(roots) {
	const units = roots.flatMap(({ address, result }) =>
		(result || []).map((unit) => ({ ...unit, address })),
	);
	const report = formatReport(units);
	if (units.some((unit) => !unit.ok)) throw goalError(report);
	return report;
}

export const TEST = goal("test", undefined, { graph: graphTestGoal });
