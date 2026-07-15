import { jsSources } from "//rules/js";

// One target per directory, not a recursive glob — src/ has its own files,
// so it gets its own target rather than being pulled in by this one.
export const hello = jsSources({});
export const hello_src = jsSources({ src: "src" });
