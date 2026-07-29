// Generates the GitHub workflows from ci/gen_workflow.py — a small,
// concrete exercise of the generate/generate-check mechanism from
// //rules/imp/generate and //rules/workflows/generate: the workflow files
// must exist for real (GitHub Actions reads them off the repo, not out of
// imp's build graph), so it belongs in the "workspace-materialized" bucket
// rather than a plain build product.
//
//   imp goal generate //ci:docs_workflow          # regenerate the file
//   imp goal generate //ci:docs_workflow --check   # CI drift gate, no writes
import {
	attach,
	file_set,
	goal,
	label,
	logInfo,
	product,
	sourcesField,
	target,
	targetKind,
	toolName,
} from "imp:core";
import { jsSources } from "//rules/js";
import { GENERATE } from "//rules/workflows/generate";
import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";
import { generatedFiles } from "//rules/imp/generate";

const CiWorkflow = targetKind("ci-workflow");
const CI_TOOL = toolName("ci");
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

// Keep the production root on the target/product path until #77 teaches
// --changed-since how to select labels. CI invokes this exact address with
// changed-file filtering, which is intentionally outside the #76 pilot.
export const docs_workflow = target({
	kind: "ci-workflow",
	attrs: {},
	sources: sourcesField({ root: "//", include: [SCRIPT, ...OUTS] }),
});

export const js = jsSources({});

export const generate = product(
	CiWorkflow,
	GENERATE,
	CI_TOOL,
	async function generate(handle, { check = false } = {}) {
		const { changed } = await runGenerator(!check);
		return check
			? { checked: 1, stale: changed }
			: { generated: changed.length };
	},
	{ display: "generate {0}", level: "info" },
);

// The one-off workflow pilot remains real and directly executable without
// claiming changed-file ownership it cannot yet provide. It uses a dedicated
// goal so recursive production generate invocations do not run both adapters.
goal("generate-pilot", undefined, {
	flags: {
		check: {
			description: "Verify the pilot workflow output is up to date",
		},
	},
});

const docs_workflow_pilot = label();
attach(
	docs_workflow_pilot,
	"generate-pilot",
	async function generateDocsWorkflowPilot(ctx) {
		const check = !!ctx.flags.check;
		const { changed } = await runGenerator(!check);
		if (check && changed.length > 0) {
			throw new Error(
				`generated workflows are out of date:\n${changed
					.map((path) => `  ${path}`)
					.join("\n")}`,
			);
		}
		if (!check && changed.length > 0) {
			logInfo(`generated ${changed.length} workflow file(s)`);
		}
		return check
			? { checked: 1, stale: changed }
			: { generated: changed.length };
	},
);
export { docs_workflow_pilot };
