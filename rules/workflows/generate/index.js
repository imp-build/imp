// Generic `generate` goal, wiring //rules/imp/generate's `generatedFiles()`
// helper into the build graph: `generate` writes a target's generated files
// into the workspace, `generate --check` verifies they're already up to date
// without writing — for CI drift gates on committed codegen.
//
// The legacy target()/product() dispatch this goal used to fall back to has
// been retired — nothing in the repo registers a real GENERATE product via
// product() today (//ci:docs_workflow, the one real consumer, uses
// attach(label, "generate", fn) instead). attach(label, "generate", fn) (the
// `generate()` sugar in imp:core) is a separate, still-supported mechanism
// and is unaffected. A future graph-native [GENERATE] materialization
// contract (#110) isn't wired up yet.
import { goal } from "imp:core";

export const GENERATE = goal("generate", undefined, {
	flags: {
		check: {
			description:
				"Verify generated files are up to date without writing changes",
		},
	},
});
