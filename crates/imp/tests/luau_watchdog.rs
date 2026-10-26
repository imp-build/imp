#![cfg(unix)]

use std::process::Command;

fn check_long_goal(program: bool) {
    let binary = std::path::Path::new(env!("CARGO_BIN_EXE_imp"));
    // The Imp Cargo action does not stage the separate CLI binary.
    if !binary.is_file() {
        eprintln!("skip Luau watchdog CLI check: cargo did not stage the imp binary");
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let source = if program {
        r#"
local core = require("@imp/core")
local sleeper = core.native_tool("sleep")
local shell = core.native_tool("sh")
core.goal("probe", function()
    core.run_program({ argv = { "sh", "-c", "printf program-before; sleep 40; printf program-after >&2" }, tools = { shell, sleeper } })
end, { selection = "none" })
return {}
"#
    } else {
        r#"
local core = require("@imp/core")
require("@imp/rules/workflows/build")
return { slow = core.task({
    inputs = { sleeper = core.native_tool("sleep") },
    run = function(exec)
        exec.action({ argv = { "sleep", "40" }, cache = false })
    end,
}) }
"#
    };
    std::fs::write(
        root.path().join("imp.workspace.luau"),
        if program { source } else { "return {}\n" },
    )
    .unwrap();
    std::fs::write(
        root.path().join("BUILD.luau"),
        if program { "return {}\n" } else { source },
    )
    .unwrap();
    let rules = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("rules");
    let args: &[&str] = if program {
        &["probe"]
    } else {
        &["build", "//:slow"]
    };
    let output = Command::new(binary)
        .current_dir(root.path())
        .env_remove("IMP_RUNTIME")
        .env("IMP_RULES_DIR", rules)
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert!(!String::from_utf8_lossy(&output.stderr).contains("stalled"));
    if program {
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("program-before"),
            "{output:?}"
        );
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("program-after"),
            "{output:?}"
        );
    }
}

#[test]
fn long_luau_action_completes_under_the_cli_watchdog() {
    check_long_goal(false);
}

#[test]
fn long_luau_program_completes_under_the_cli_watchdog() {
    check_long_goal(true);
}
