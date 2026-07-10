// Generic `generate` / `generate-check` goal, wiring //rules/imp/generate's
// `generatedFiles()` helper into the build graph the same way //rules/workflows/fmt
// wires `fmt` / `format-check` for odin/cargo packages: `generate` writes a target's
// generated files into the workspace, `generate-check` verifies they're already up
// to date without writing — for CI drift gates on committed codegen (see
// //rules/imp/generate.js's doc comment for the product-authoring pattern).
//
// No target kind registers `generate`/`generate-check` products yet — this module
// only provides the shared dispatch goal; a rule package adds the products for its
// own target kind following the pattern documented in generate.js.
import { goal, resolveProduct, goalFlags, logInfo } from "imp:core";

export async function generateGoal(selection) {
    const { check } = goalFlags();
    const targets = check
        ? selection.map((entry) => ({ ...entry, product: "generate-check" }))
        : selection;
    const resolved = targets.map(resolveProduct);
    const calls = resolved.map(({ label, fn, handle }) => ({ label, promise: fn(handle) }));

    const summaryLines = [];
    const staleReports = [];
    for (const { label, promise } of calls) {
        let result;
        try {
            result = await promise;
        } catch (e) {
            throw new Error(`${label}: ${e && e.message ? e.message : e}`);
        }
        if (check) {
            const stale = (result && result.stale) || [];
            if (stale.length > 0) {
                summaryLines.push(`- ${label}: ${stale.length} file(s) out of date`);
                for (const file of stale) staleReports.push(`${label}: ${file}`);
            }
        } else {
            const count = (result && result.generated) || 0;
            if (count > 0) {
                summaryLines.push(`- ${label}: ${count} file(s) generated`);
            }
        }
    }

    if (summaryLines.length > 0) {
        logInfo(["generate:", ...summaryLines].join("\n"));
    }
    if (check && staleReports.length > 0) {
        throw new Error(`generated files out of date:\n${staleReports.map((f) => `  ${f}`).join("\n")}`);
    }
}

goal(
    "generate",
    generateGoal,
    {
        flags: {
            check: { description: "Verify generated files are up to date without writing changes" },
        },
    },
);

