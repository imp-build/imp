import { jsSources } from "//rules/js";

// One target per directory, not a recursive glob — src/ has its own files,
// so it gets its own target rather than being pulled in by this one.
export const hello = jsSources({ base: "rules/js/example" });
export const hello_src = jsSources({ base: "rules/js/example", src: "src" });
