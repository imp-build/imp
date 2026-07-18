// Workspace-wide build-mode conventions. Import this module from a workspace
// file to make the profiles available to every goal in that workspace.
import { defineModeAxis, defineProfile } from "imp:core";

defineModeAxis("opt", {
	kind: "rebuild",
	values: ["debug", "release"],
	default: "debug",
});

// The named default is intentionally redundant with the axis default: it
// gives automation an explicit, stable profile name without changing normal
// invocations that omit --profile.
defineProfile("default", { opt: "debug" });
defineProfile("release", { opt: "release" });
