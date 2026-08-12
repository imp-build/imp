// Generates the GitHub workflows from ci/gen_workflow.py — a small,
// concrete exercise of the generate/generate-check mechanism from
// //rules/imp/generate and //rules/workflows/generate: the workflow files
// must exist for real (GitHub Actions reads them off the repo, not out of
// imp's build graph), so it belongs in the "workspace-materialized" bucket
// rather than a plain build product.
//
//   imp generate //ci:docs_workflow          # regenerate the file
//   imp generate //ci:docs_workflow --check   # CI drift gate, no writes
import { file } from "imp:core";
import { jsSources } from "//rules/js";
import { GENERATE } from "//rules/workflows/generate";
import { nativeTool } from "//rules/imp/native-tool";
import { generatedFiles } from "//rules/imp/generate";

const SCRIPT = "ci/gen_workflow.py";
const OUTS = [".github/workflows/docs.yml", ".github/workflows/release.yml"];

export const js = jsSources({ base: "ci" });

export const docs_workflow = {
	[GENERATE]: generatedFiles({
		display: "generate GitHub workflows",
		tools: { python3: nativeTool("python3") },
		inputs: { script: file(SCRIPT) },
		outputPaths: OUTS,
		// exec.tool() gives the in-sandbox path for the declared tool —
		// sandboxed runs build PATH strictly from declared tools' bin dirs
		// (see sandbox_command_env in crates/imp-execution/src/exec.rs), so a
		// host path would not resolve from inside the sandbox.
		argv: (exec, { python3 }) => [
			exec.tool(python3, "python3"),
			SCRIPT,
			...OUTS,
		],
	}),
};
