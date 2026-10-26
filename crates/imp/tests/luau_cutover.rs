use std::path::Path;
use std::process::{Command, Output};

fn run(root: &Path, runtime: Option<&str>, args: &[&str]) -> Output {
    let rules = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("rules");
    let mut command = Command::new(env!("CARGO_BIN_EXE_imp"));
    command
        .current_dir(root)
        .env("IMP_RULES_DIR", rules)
        .env_remove("IMP_RUNTIME")
        .env_remove("GITHUB_ACTIONS")
        .args(args);
    if let Some(runtime) = runtime {
        command.env("IMP_RUNTIME", runtime);
    }
    command.output().unwrap()
}

#[test]
fn luau_is_the_only_runtime_and_old_environment_values_have_no_effect() {
    if !Path::new(env!("CARGO_BIN_EXE_imp")).is_file() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("imp.workspace.luau"), "return {}\n").unwrap();
    std::fs::write(root.path().join("BUILD.luau"), "local core = require('@imp/core')\nrequire('@imp/rules/workflows/build')\nreturn { probe = core.task({ run = function() end }) }\n").unwrap();
    for dual in [false, true] {
        if dual {
            std::fs::write(
                root.path().join("imp.workspace.js"),
                "throw new Error('must not load');",
            )
            .unwrap();
            std::fs::write(
                root.path().join("BUILD.js"),
                "throw new Error('must not load');",
            )
            .unwrap();
        }
        for runtime in [None, Some("luau"), Some("js"), Some("unknown")] {
            let output = run(root.path(), runtime, &["targets", "//..."]);
            assert!(output.status.success(), "{output:?}");
            assert!(
                String::from_utf8_lossy(&output.stdout).contains("//:probe"),
                "{output:?}"
            );
        }
    }
    let nested = root.path().join("nested");
    std::fs::create_dir(&nested).unwrap();
    assert!(run(&nested, None, &["targets", "//..."]).status.success());
    std::fs::write(nested.join("imp.workspace.js"), "").unwrap();
    let output = run(&nested, None, &["targets", "//..."]);
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(
        error.contains("JavaScript authoring is no longer supported")
            && error.contains("imp.workspace.luau"),
        "{output:?}"
    );
}

#[test]
fn workspace_module_can_export_graph_roots() {
    if !Path::new(env!("CARGO_BIN_EXE_imp")).is_file() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("imp.workspace.luau"),
        r#"
local core = require("@imp/core")
require("@imp/rules/workflows/build")
return { imp = { jobs = 2 }, bootstrap = core.task({ run = function() end }) }
"#,
    )
    .unwrap();
    let output = run(root.path(), None, &["build", "//:bootstrap"]);
    assert!(output.status.success(), "{output:?}");
    for selector in ["//:bootstrap", "//..."] {
        let output = run(root.path(), None, &["targets", selector]);
        assert!(output.status.success(), "{output:?}");
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("//:bootstrap"),
            "{output:?}"
        );
    }
}

#[test]
fn rules_schema_is_rejected_before_workspace_loading() {
    if !Path::new(env!("CARGO_BIN_EXE_imp")).is_file() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let output = run(root.path(), None, &["rules", "schema"]);
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(
        !String::from_utf8_lossy(&output.stderr).contains("could not find"),
        "{output:?}"
    );
    let help = run(root.path(), None, &["rules", "--help"]);
    assert!(help.status.success());
    assert!(!String::from_utf8_lossy(&help.stdout).contains("schema"));
    std::fs::write(root.path().join("imp.workspace.luau"), "return {}\n").unwrap();
    assert!(run(root.path(), None, &["rules"]).status.success());
    assert!(run(root.path(), None, &["config", "schema"])
        .status
        .success());
}

#[test]
fn goal_selection_keeps_per_selector_errors_and_forwards_flags() {
    if !Path::new(env!("CARGO_BIN_EXE_imp")).is_file() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("imp.workspace.luau"), "return {}\n").unwrap();
    std::fs::write(
        root.path().join("BUILD.luau"),
        r#"
local core = require("@imp/core")
local build = require("@imp/rules/workflows/build")
local INSPECT = core.goal("inspect", function(roots)
    local lines = {}
    for _, root in ipairs(roots) do table.insert(lines, root.address) end
    table.insert(lines, tostring(core.goal_flags().loud))
    table.insert(lines, table.concat(core.run_args(), ","))
    return table.concat(lines, "\n")
end, { flags = { loud = {} } })
return {
    a = { [INSPECT] = core.task({ run = function() end }) },
    b = { [INSPECT] = core.task({ run = function() end }) },
    build_only = { [build.BUILD] = core.task({ run = function() end }) },
}
"#,
    )
    .unwrap();
    let output = run(root.path(), None, &["inspect", "//:a", "//:b", "--loud"]);
    assert!(output.status.success(), "{output:?}");
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("//:a\n//:b\ntrue"), "{output:?}");
    let output = run(root.path(), None, &["inspect"]);
    assert!(!output.status.success(), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("requires at least one selector"),
        "{output:?}"
    );
    let output = run(root.path(), None, &["inspect", "//:a", "//:missing"]);
    assert!(!output.status.success(), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("//:missing"));
    let output = run(root.path(), None, &["inspect", "//:build_only"]);
    assert!(!output.status.success(), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("has no 'inspect' workflow"),
        "{output:?}"
    );
}
