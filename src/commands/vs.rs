use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};

use crate::commands::build::BuildMode;
use crate::workspace;

type Tree = Arc<prodash::tree::Root>;

pub async fn cmd_vs(tree: &Tree) -> Result<()> {
    let mut p = tree.add_child("generate VS/VSCode configs");
    let targets = workspace::get_targets()?;
    let ws = workspace::root_dir();

    let vs_dir = ws.join(".vs");
    let vscode_dir = ws.join(".vscode");
    std::fs::create_dir_all(&vs_dir)?;
    std::fs::create_dir_all(&vscode_dir)?;

    let mut launch_vs = json!({ "version": "0.2.1", "defaults": {}, "configurations": [] });
    let mut tasks_vs = json!({ "version": "0.2.1", "tasks": [] });
    let mut launch_vsc = json!({ "version": "0.2.0", "configurations": [] });
    let mut tasks_vsc = json!({ "version": "2.0.0", "tasks": [] });

    for target in &targets {
        for mode in [BuildMode::Debug, BuildMode::Release] {
            let name = format!("{} ({mode})", target.name);
            let out_rel = format!(
                "build/{}/{}_{}",
                target.path.to_string_lossy(),
                target.name,
                mode
            );

            let out_win = std::path::Path::new(&out_rel)
                .with_extension("exe")
                .to_string_lossy()
                .replace('/', "\\");

            append(
                &mut tasks_vs["tasks"],
                json!({
                    "taskLabel": format!("Build {name}"),
                    "appliesTo": "imp",
                    "type": "launch",
                    "command": "./imp",
                    "args": ["build", "--target", &target.name, "--mode", mode.to_string()],
                    "contextType": "build",
                    "output": format!("${{workspaceRoot}}\\{out_win}")
                }),
            );

            append(
                &mut launch_vs["configurations"],
                json!({
                    "type": "default",
                    "project": out_win,
                    "projectTarget": format!("View.Build ({}_{mode})", target.name),
                    "name": name,
                    "args": [],
                    "currentDir": "${workspaceRoot}"
                }),
            );

            append(
                &mut tasks_vsc["tasks"],
                json!({
                    "label": format!("Build {name}"),
                    "type": "shell",
                    "command": format!("./imp build --target {} --mode {mode}", target.name),
                    "group": "build",
                    "problemMatcher": []
                }),
            );

            let debugger = if cfg!(windows) {
                "cppvsdbg"
            } else {
                "lldb-dap"
            };
            append(
                &mut launch_vsc["configurations"],
                json!({
                    "name": name,
                    "type": debugger,
                    "request": "launch",
                    "program": format!("${{workspaceFolder}}/{}", out_rel),
                    "args": [],
                    "stopAtEntry": false,
                    "cwd": "${workspaceFolder}",
                    "environment": [],
                    "externalConsole": false,
                    "preLaunchTask": format!("Build {name}")
                }),
            );
        }
    }

    std::fs::write(
        vs_dir.join("launch.vs.json"),
        serde_json::to_string_pretty(&launch_vs)?,
    )?;
    std::fs::write(
        vs_dir.join("tasks.vs.json"),
        serde_json::to_string_pretty(&tasks_vs)?,
    )?;
    std::fs::write(
        vscode_dir.join("launch.json"),
        serde_json::to_string_pretty(&launch_vsc)?,
    )?;
    std::fs::write(
        vscode_dir.join("tasks.json"),
        serde_json::to_string_pretty(&tasks_vsc)?,
    )?;

    p.done("generated .vs/ and .vscode/");
    Ok(())
}

fn append(array: &mut Value, item: Value) {
    if let Value::Array(ref mut arr) = array {
        arr.push(item);
    }
}
