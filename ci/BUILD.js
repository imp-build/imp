// Generates the GitHub workflows from ci/gen_workflow.py — a small,
// concrete exercise of the generate/generate-check mechanism from
// //rules/imp/generate and //rules/workflows/generate: the workflow files
// must exist for real (GitHub Actions reads them off the repo, not out of
// imp's build graph), so it belongs in the "workspace-materialized" bucket
// rather than a plain build product.
//
//   imp goal generate //ci:docs_workflow          # regenerate the file
//   imp goal generate //ci:docs_workflow --check   # CI drift gate, no writes
import { target, product, file_set, targetKind, toolName } from "imp:core";
import { GENERATE } from "//rules/workflows/generate";
import { GENERATE_CHECK } from "//rules/workflows/products";

const CiWorkflow = targetKind("ci-workflow");
const CI_TOOL = toolName("ci");
import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";
import { generatedFiles } from "//rules/imp/generate";

const python3 = nativeTool("python3");

const SCRIPT = "ci/gen_workflow.py";
const OUTS = [".github/workflows/docs.yml", ".github/workflows/release.yml"];

async function runGenerator(materialize) {
    const py = await nativeToolSpec(python3);
    return generatedFiles({
        display: "generate GitHub workflows",
        // Invoke the tool by its bare declared name — sandboxed runs build
        // PATH strictly from declared tools' bin dirs (see
        // sandbox_command_env in src/exec.rs), so `py.path` (the host path
        // used for cache-keying) isn't itself resolvable from inside the
        // sandbox. Same pattern as docs/BUILD.js's mkdir/dirname/zola calls.
        argv: ["python3", SCRIPT, ...OUTS],
        tools: [py],
        inputs: [file_set.literal([SCRIPT])],
        outputPaths: OUTS,
        materialize,
    });
}

export const docs_workflow = target({ kind: "ci-workflow", attrs: {} });

export const generate = product(CiWorkflow, GENERATE, CI_TOOL, async function generate() {
    const { changed } = await runGenerator(true);
    return { generated: changed.length };
});

export const generate_check = product(CiWorkflow, GENERATE_CHECK, CI_TOOL, async function generate_check() {
    const { changed } = await runGenerator(false);
    return { checked: 1, stale: changed };
});
