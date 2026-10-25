import { builtinFiles, output, resolveGraphHandle, task } from "imp:core";
import { nativeTool } from "//rules/imp/native-tool";
import { impTool } from "//rules/imp/self-tool";
import { expect, test } from "//rules/imp/test";

const workspace = `import "//rules/workflows/fmt";
import "//rules/workflows/lint";
`;
const buildOnly = `import { task, output } from "imp:core";
import { BUILD } from "//rules/workflows/build";
import { FMT } from "//rules/workflows/fmt";
import { LINT } from "//rules/workflows/lint";
export const built = { [BUILD]: task({ inputs: {}, async run() {} }) };
`;
const checked = `export const checked = {
    [FMT]: task({ outputs: { paths: output.value() }, async run() { return { paths: [] }; } }),
    [LINT]: task({ outputs: { ok: output.value() }, async run() { return { ok: true }; } }),
};
`;

async function invoke(goal, handlers) {
	const probe = task({
		inputs: {
			imp: impTool,
			sh: nativeTool("sh"),
			rules: builtinFiles({
				include: [
					"workflows/fmt/index.js",
					"workflows/lint/index.js",
					"workflows/build/index.js",
					"workflows/report.js",
				],
			}),
			goal,
			build: buildOnly + (handlers ? checked : ""),
		},
		outputs: { result: output.value() },
		async run(exec, inputs) {
			const result = await exec.action({
				argv: [
					"sh",
					"-c",
					'printf "%s" "$1" > imp.workspace.js; printf "%s" "$2" > BUILD.js; exec imp "$3" //...',
					"fixture",
					workspace,
					inputs.build,
					inputs.goal,
				],
				inputs: [inputs.rules],
				tools: [inputs.imp, inputs.sh],
				env: ["IMP_RUNTIME=js", "IMP_RULES_DIR=."],
				allowFailure: true,
				display: `check ${inputs.goal} missing-handler warning`,
			});
			return {
				result: {
					code: result.exitCode,
					stdout: result.stdout,
					stderr: result.stderr,
				},
			};
		},
	});
	return resolveGraphHandle(probe.outputs.result);
}

for (const goal of ["fmt", "lint"]) {
	test(`${goal} warns once when selected targets have no handler`, async () => {
		const result = await invoke(goal, false);
		if (result.code !== 0) throw new Error(result.stdout + result.stderr);
		const warning = `warning: goal '${goal}' matched targets, but none has a handler for this goal; a handler import may be missing`;
		expect(result.stderr.split(warning).length - 1).toBe(1);
		expect(result.stdout).not.toContain(warning);
	});

	test(`${goal} does not warn when a selected target has a handler`, async () => {
		const result = await invoke(goal, true);
		if (result.code !== 0) throw new Error(result.stdout + result.stderr);
		expect(result.stderr).not.toContain("handler import may be missing");
		expect(result.stdout).toContain(`${goal}: 1`);
	});
}
