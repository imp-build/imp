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
import { goal, goalError, logInfo } from "imp:core";

/** Aggregate every selected [TEST] root's execution-unit results and report once. */
export function graphTestGoal(roots) {
	const units = roots.flatMap(({ address, result }) =>
		(result || []).map((unit) => ({ ...unit, address })),
	);
	const failed = units.filter((unit) => !unit.ok);
	for (const unit of failed) {
		if (unit.output) logInfo(`${unit.address} ${unit.name}:\n${unit.output}`);
	}
	logInfo(`test: ${units.length - failed.length}/${units.length} unit(s) passed`);
	if (failed.length > 0) {
		throw goalError(
			`test failed: ${failed.map((unit) => `${unit.address} ${unit.name}`).join(", ")}`,
		);
	}
}

export const TEST = goal("test", undefined, { graph: graphTestGoal });
