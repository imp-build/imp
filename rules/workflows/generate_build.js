// The `generate-build` goal: dispatches to every selected generator target's
// "generate-build" product (see e.g. //rules/rust/generate_build.js), merges
// the `{ file: [{name, rule, props}, ...] }` edits every product returns —
// one product call may touch a BUILD.js another target's product also wants
// to add targets to — then renders/writes them in one pass via
// applyBuildEdits() (imp:core), the JS entry point for the render_raw_build_file
// pipeline that preserves hand-written exports and merges imports.
//
// Runs through the same goal machinery as fmt/build/test/generate
// (//rules/workflows/fmt.js, //rules/workflows/generate.js) rather than a
// bespoke CLI command, so it gets a scheduler + exec_root for free — needed
// because generator products (e.g. cargo metadata) call run().
import { applyBuildEdits, goal, resolveProduct, goalFlags, logInfo } from "imp:core";

function mergeEdits(target, edits) {
    for (const [file, targets] of Object.entries(edits || {})) {
        if (!target[file]) target[file] = [];
        target[file].push(...targets);
    }
}

export async function generateBuildGoal(selection) {
    const { check } = goalFlags();
    const resolved = selection.map(resolveProduct);

    const edits = {};
    for (const { label, fn, handle } of resolved) {
        let result;
        try {
            result = await fn(handle);
        } catch (e) {
            throw new Error(`${label}: ${e && e.message ? e.message : e}`);
        }
        mergeEdits(edits, result);
    }

    const { changed, checked } = applyBuildEdits({ edits, check });

    if (check) {
        logInfo(`generate-build: ${checked.length} file(s) checked, ${changed.length} out of date`);
        if (changed.length > 0) {
            throw new Error(`generated BUILD files are out of date: ${changed.join(", ")}`);
        }
    } else if (changed.length > 0) {
        logInfo(`generate-build: ${changed.length} file(s) written\n${changed.map((f) => `  ${f}`).join("\n")}`);
    }
}

goal(
    "generate-build",
    generateBuildGoal,
    {
        flags: {
            check: { description: "Verify generated BUILD files are up to date without writing changes" },
        },
    },
);
