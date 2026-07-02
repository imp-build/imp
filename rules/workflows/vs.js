// Ported from the legacy Rust command src/commands/vs.rs.
//
// Emits Visual Studio and VS Code build/launch configuration for every
// odin-package target, in Debug and Release variants:
//   .vs/launch.vs.json, .vs/tasks.vs.json, .vscode/launch.json, .vscode/tasks.json
//
// Invoke as a product: `imp build //:<vs-target>#build`.

import { target, product, run, output, output_path, workspaceTargets, platformInfo } from "imp:core";

const MODES = ["Debug", "Release"];

function targetName(address) {
    const colon = address.lastIndexOf(":");
    return colon >= 0 ? address.slice(colon + 1) : address;
}

// Executable output path for an odin-package target (matches odinBuild's
// default_output_path); honours an explicit `output` attr when set.
function outputPath(entry, name) {
    return entry.attrs && entry.attrs.output ? entry.attrs.output : `build/odin/${name}`;
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
            'mkdir -p "$(dirname "$1")" && printf %s "$2" > "$1"',
            "vs-write",
            output_path(path),
            pretty(value),
        ],
        outputs: [output(path)],
        display: `write ${path}`,
    });
}

export const vs = product("vs-workspace", "build", async function vs(handle) {
    const isWindows = platformInfo().os === "windows";
    const debuggerType = isWindows ? "cppvsdbg" : "lldb-dap";

    const launchVs = { version: "0.2.1", defaults: {}, configurations: [] };
    const tasksVs = { version: "0.2.1", tasks: [] };
    const launchVsc = { version: "0.2.0", configurations: [] };
    const tasksVsc = { version: "2.0.0", tasks: [] };

    for (const entry of workspaceTargets("odin-package")) {
        const name = targetName(entry.address);
        const outRel = outputPath(entry, name);
        const outWin = windowsOutput(outRel);
        const buildSelector = `${entry.address}#build`;

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
    await Promise.all(Object.entries(files).map(([path, value]) => writeJsonFile(path, value)));

    return { generated: Object.keys(files) };
});

/**
 * Declare a target that generates VS/VS Code IDE configuration for the workspace.
 *
 * @returns {object} Target handle of kind "vs-workspace".
 */
export function vsWorkspace() {
    return target({ kind: "vs-workspace", attrs: {} });
}
