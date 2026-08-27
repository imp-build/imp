// Probe for graph subsetting: build the same work under more than one
// configuration in one invocation, and show which nodes fork and which stay
// shared.
//
// `leaf` reads the `opt` axis, thus it is built one time for each
// configuration it is used under. `shared` reads no axis, thus it stays one
// node no matter how many configurations are above it. `both` consumes
// `leaf` at the configuration of the invocation, `leaf` pinned to release,
// and `shared` — so one invocation of `imp build //rules/imp/config/example:both`
// must run leaf two times and shared one time.

import { BUILD } from "//rules/workflows/build";
import { configured, output, semantic, task } from "imp:core";
import { nativeTool } from "//rules/imp/native-tool";
import { jsSources } from "//rules/js";
import "//rules/imp/mode";

function stamp(name, inputs) {
	return task({
		display: `config-probe ${name}`,
		inputs: { sh: nativeTool("sh"), ...inputs },
		outputs: { artifact: output.artifact(), text: output.value() },
		async run(exec, resolved) {
			const text = `${name}:${resolved.opt || "none"}`;
			const path = `config-probe-${name}.txt`;
			const result = await exec.action({
				argv: [
					exec.tool(resolved.sh, "sh"),
					"-c",
					'printf %s "$1" > "$2"',
					"config-probe",
					text,
					path,
				],
				tools: [resolved.sh],
				outputs: { file: output.file(path) },
				display: `config-probe ${name} ${text}`,
			});
			return { artifact: result.outputs.file, text };
		},
	});
}

// Reads the axis: must fork per configuration.
const leaf = stamp("leaf", { opt: semantic.mode("opt") });

// Reads no axis: must stay shared across configurations.
const shared = stamp("shared", {});

const both = task({
	display: "config-probe both",
	inputs: {
		debug: leaf.outputs.text,
		release: configured(leaf, { opt: "release" }).outputs.text,
		shared: shared.outputs.text,
	},
	outputs: { report: output.value() },
	run(_exec, resolved) {
		return {
			report: `${resolved.debug}|${resolved.release}|${resolved.shared}`,
		};
	},
});

export const probe = { [BUILD]: both };
export const js = jsSources({ base: "rules/imp/config/example" });
