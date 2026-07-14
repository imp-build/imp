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
// via the general goal-flags mechanism (`goalFlags()`). The callback drives
// its own resolve/fan-out/await loop (resolveProduct) rather than delegating
// to a shared dispatch helper, so every selected target gets checked and
// summarized before any unformatted file turns into a thrown error — a
// single formatter failing to compile shouldn't hide the report for every
// other target.
export {
    odinPackageFmt,
    odinTestPackageFmt,
    odinPackageFormatCheck,
    odinTestPackageFormatCheck,
} from "//rules/odin/odinfmt";
export {
    cargoPackageFmt,
    cargoPackageFormatCheck,
} from "//rules/rust/rustfmt";
export {
    pythonAppFmt,
    pythonAppFormatCheck,
} from "//rules/python/ruff";
import { goal, resolveProduct, goalFlags, logInfo } from "imp:core";
import { FORMAT_CHECK } from "//rules/workflows/products";

export async function fmtGoal(selection) {
    const { check } = goalFlags();
    const targets = check
        ? selection.map((entry) => ({ ...entry, product: FORMAT_CHECK }))
        : selection;
    const resolved = targets.map(resolveProduct);
    const calls = resolved.map(({ label, fn, handle }) => ({ label, promise: fn(handle) }));

    const summaryLines = [];
    const unformatted = [];
    for (const { label, promise } of calls) {
        let result;
        try {
            result = await promise;
        } catch (e) {
            throw new Error(`${label}: ${e && e.message ? e.message : e}`);
        }
        if (check) {
            const files = (result && result.unformatted) || [];
            if (files.length > 0) {
                summaryLines.push(`- ${label}: ${files.length} file(s) not formatted`);
                for (const file of files) unformatted.push(`${label}: ${file}`);
            }
        } else {
            const count = (result && result.formatted) || 0;
            if (count > 0) {
                summaryLines.push(`- ${label}: ${count} file(s) reformatted`);
            }
        }
    }

    if (summaryLines.length > 0) {
        logInfo(["fmt:", ...summaryLines].join("\n"));
    }
    if (check && unformatted.length > 0) {
        throw new Error(`not formatted:\n${unformatted.map((f) => `  ${f}`).join("\n")}`);
    }
}

goal(
    "fmt",
    fmtGoal,
    {
        flags: {
            check: { description: "Verify formatting without writing changes" },
        },
    },
);
