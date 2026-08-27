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
import { statusReport } from "//rules/workflows/report";

/** Aggregate every selected [TEST] root's execution-unit results and report once. */
export function graphTestGoal(roots) {
	// Group by address *and* configuration: one invocation can build the
	// same target under more than one configuration (`--profile a --profile
	// b`), and two runs of one unit under two configurations are two
	// results, not one repeated. `configLabel` is null when the invocation
	// asked for only one configuration, thus the key is the address alone.
	const units = roots.flatMap(({ address, configLabel, result }) =>
		(result || []).map((unit) => ({
			...unit,
			address: configLabel ? `${address} [${configLabel}]` : address,
		})),
	);
	// Returned (on an all-passing run) or thrown as the goalError message (on
	// any failure) rather than logged: the live progress UI's logger suspends
	// and redraws indicatif per line, which fights a burst of ~one-line-per-unit
	// output for the terminal. Returning/throwing a plain string instead lets
	// the host print it with a plain `println!`/`eprintln!` once the UI has
	// already been torn down (see execute_goal_live_selection's `report`
	// capture and `run()` in crates/imp/src/main.rs).
	const report = statusReport(
		units.map((unit) => ({
			key: `${unit.address} ${unit.name}`,
			status: unit.ok ? "pass" : "fail",
			output: unit.output,
		})),
		{
			order: ["fail", "pass"],
			colors: { fail: "red", pass: "green" },
			summary: (counts) =>
				`test: ${counts.pass}/${counts.pass + counts.fail} unit(s) passed`,
		},
	);
	if (units.some((unit) => !unit.ok)) throw goalError(report);
	return report;
}

export const TEST = goal("test", undefined, { graph: graphTestGoal });
