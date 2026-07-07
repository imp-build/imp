// Ported from the legacy Rust command src/commands/fmt.rs.
//
// Wires Odin's fmt mechanics (//rules/odin/odinfmt) into the build graph as
// products: `fmt` reformats a package's own sources in place, `format-check`
// verifies they're already formatted without mutating the tree. `imp fmt
// --check` runs the check variant; `format-check` also stays reachable
// directly via `//:<pkg>#format-check` for scripting.
//
// The "fmt" goal is declared with a callback so `--check` can pick a
// different product (`format-check` instead of `fmt`) per selected target,
// via the general goal-flags mechanism (`goalFlags()`) plus the existing
// dispatchSelection/resolveProduct machinery — see imp_core.js.
import { odinFmt, odinFormatCheck } from "//rules/odin/odinfmt";
import { goal, product, dispatchSelection, goalFlags } from "imp:core";

goal(
    "fmt",
    (selection) => {
        const { check } = goalFlags();
        const targets = check
            ? selection.map((entry) => ({ ...entry, product: "format-check" }))
            : selection;
        return dispatchSelection(targets);
    },
    {
        flags: {
            check: { description: "Verify formatting without writing changes" },
        },
    },
);

export const odinPackageFmt = product("odin-package", "fmt", odinFmt);
export const odinTestPackageFmt = product("odin-test-package", "fmt", odinFmt);
export const odinPackageFormatCheck = product("odin-package", "format-check", odinFormatCheck);
export const odinTestPackageFormatCheck = product("odin-test-package", "format-check", odinFormatCheck);
