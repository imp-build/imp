// Ported from the legacy Rust command src/commands/vs.rs.
//
// Emits Visual Studio and VS Code build/launch configuration for every Odin
// package in the current selection, in Debug and Release variants:
//   .vs/launch.vs.json, .vs/tasks.vs.json, .vscode/launch.json, .vscode/tasks.json
//
// Its own "vs" goal, not "build" — emitting IDE config isn't building
// anything. Invoke as `imp vs //...` (or a narrower selector) — every Odin
// package exposing [VSCODE] in the selection is aggregated into one set of
// files. Graph-native: each package attaches its own [VSCODE] facet at
// declaration time (see //rules/odin/vscode), so this module has no central
// package registry of its own — it only aggregates whatever roots the
// engine resolves for the "vs" goal's selection.
//
// Output paths are computed with the same pure helper (odin_output_path,
// rules/odin/index.js) a real build uses internally — imported, not
// duplicated — so they can't drift from what a build actually produces.
// [VSCODE] roots only run a static source scan; no real build is ever
// triggered by this goal.

import { goal, run, output, output_path, platformInfo, group } from "imp:core";
import { odin_output_path, graphDefaultOutputPath } from "//rules/odin";

export const VSCODE = goal("vs", undefined, { graph: graphVsGoal });

const MODES = ["Debug", "Release"];

function targetName(address) {
	const colon = address.lastIndexOf(":");
	return colon >= 0 ? address.slice(colon + 1) : address;
}

function windowsOutput(outRel) {
	return `${outRel}.exe`.replace(/\//g, "\\");
}

function pretty(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}

// Write a JSON file as a cacheable run(). Content is passed as a positional
// argument so no shell interpolation touches it.
function writeJsonFile(path, value) {
	return run({
		argv: [
			"sh",
			"-c",
			'printf %s "$2" > "$1"',
			"vs-write",
			output_path(path),
			pretty(value),
		],
		outputs: [output(path)],
		materialize: true,
		display: `write ${path}`,
	});
}

/**
 * Aggregate every selected package's [VSCODE] facet into one set of
 * VS/VS Code IDE config files. Called by the engine with the resolved
 * roots for the "vs" goal's selection — no package registry involved.
 *
 * @param {Array<{address: string, result: {hasMainEntrypoint: boolean, packagePath: string}}>} roots
 */
export async function graphVsGoal(roots) {
	const isWindows = platformInfo().os === "windows";
	const debuggerType = isWindows ? "cppvsdbg" : "lldb-dap";

	const launchVs = { version: "0.2.1", defaults: {}, configurations: [] };
	const tasksVs = { version: "0.2.1", tasks: [] };
	const launchVsc = { version: "0.2.0", configurations: [] };
	const tasksVsc = { version: "2.0.0", tasks: [] };

	for (const { address, result: analysis } of roots) {
		const name = targetName(address);
		const out = graphDefaultOutputPath(address);
		const outRel = odin_output_path(out, analysis);
		const outWin = windowsOutput(outRel);
		const buildSelector = `${address}#build`;

		for (const mode of MODES) {
			const label = `${name} (${mode})`;
			const buildTask = `Build ${label}`;

			tasksVs.tasks.push({
				taskLabel: buildTask,
				appliesTo: "imp",
				type: "launch",
				command: "./imp",
				args: ["build", buildSelector],
				contextType: "build",
				output: `\${workspaceRoot}\\${outWin}`,
			});

			launchVs.configurations.push({
				type: "default",
				project: outWin,
				projectTarget: `View.Build (${name}_${mode})`,
				name: label,
				args: [],
				currentDir: "${workspaceRoot}",
			});

			tasksVsc.tasks.push({
				label: buildTask,
				type: "shell",
				command: `./imp build ${buildSelector}`,
				group: "build",
				problemMatcher: [],
			});

			launchVsc.configurations.push({
				name: label,
				type: debuggerType,
				request: "launch",
				program: `\${workspaceFolder}/${outRel}`,
				args: [],
				stopAtEntry: false,
				cwd: "${workspaceFolder}",
				environment: [],
				externalConsole: false,
				preLaunchTask: buildTask,
			});
		}
	}

	const files = {
		".vs/launch.vs.json": launchVs,
		".vs/tasks.vs.json": tasksVs,
		".vscode/launch.json": launchVsc,
		".vscode/tasks.json": tasksVsc,
	};
	await group(
		Object.entries(files).map(([path, value]) => writeJsonFile(path, value)),
	);

	return { generated: Object.keys(files) };
}
