// Product-name tokens shared between the workflow goals and the rule modules
// that implement them. They live in a leaf module (importing nothing from the
// rule tree) so goal callbacks (//rules/workflows/fmt.js, generate.js) and
// per-language implementations (odinfmt, rustfmt, ruff, ...) can both import
// a token without creating a module cycle.
import { productName } from "imp:core";

/** Verify a target's sources are formatted without rewriting them;
 * dispatched per target by `imp fmt --check`. */
export const FORMAT_CHECK = productName("format-check");

/** Verify a target's committed generated files are up to date without
 * rewriting them; dispatched per target by `imp generate --check`. */
export const GENERATE_CHECK = productName("generate-check");
