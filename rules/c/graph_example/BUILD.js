import { ccBinary, ccLibrary } from "//rules/c/graph";
import { defaultGccGraphToolchain } from "//rules/c/gcc";
import { jsSources } from "//rules/js";

// Explicit gcc toolchain rather than relying on the zig-preferred default —
// zig's own `zig cc`/`zig ar` static-archive linking has an open issue
// ("artifact: unrecognized file extension") not yet chased down; see #61.
const toolchain = defaultGccGraphToolchain();

export const lib = ccLibrary({
	path: "rules/c/graph_example/lib",
	toolchain,
});

export const hello = ccBinary({
	path: "rules/c/graph_example",
	srcs: ["main.c"],
	deps: [lib],
	toolchain,
});

export const js = jsSources({ base: "rules/c/graph_example" });
