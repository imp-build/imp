use std::path::Path;
use std::process::{Command, Output};

const WARNING: &str = "handler import may be missing";

fn write(root: &Path, path: &str, source: &str) {
    let path = root.join(path);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, source).unwrap();
}

fn run(root: &Path, _runtime: &str, args: &[&str]) -> Output {
    let rules = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("rules");
    Command::new(env!("CARGO_BIN_EXE_imp"))
        .current_dir(root)
        .env_remove("IMP_RUNTIME")
        .env("IMP_RULES_DIR", rules)
        .env_remove("GITHUB_ACTIONS")
        .args(args)
        .output()
        .unwrap()
}

fn assert_no_warning(output: &Output, success: bool) {
    assert_eq!(output.status.success(), success, "{output:?}");
    assert!(
        !String::from_utf8_lossy(&output.stderr).contains(WARNING),
        "{output:?}"
    );
}

fn workspace(root: &Path, _runtime: &str) {
    write(
        root,
        "imp.workspace.luau",
        "require('@imp/rules/workflows/fmt')\nrequire('@imp/rules/workflows/lint')\nreturn {}\n",
    );
    write(
        root,
        "BUILD.luau",
        r#"
local core = require("@imp/core")
local build = require("@imp/rules/workflows/build")
return { built = { [build.BUILD] = core.task({ run = function() end }) } }
"#,
    );
}

fn add_handlers(root: &Path, _runtime: &str) {
    write(
        root,
        "checked/BUILD.luau",
        r#"
local core = require("@imp/core")
local fmt = require("@imp/rules/workflows/fmt")
local lint = require("@imp/rules/workflows/lint")
return { checked = {
    [fmt.FMT] = core.task({ outputs = { result = core.output.value() },
        run = function() return { result = { paths = {} } } end }).outputs.result,
    [lint.LINT] = core.task({ outputs = { result = core.output.value() },
        run = function() return { result = { ok = true } } end }).outputs.result,
} }
"#,
    );
}

#[test]
fn quality_goals_warn_only_when_the_complete_selection_has_no_handler() {
    if !Path::new(env!("CARGO_BIN_EXE_imp")).is_file() {
        eprintln!("skip CLI warning check: cargo did not stage the imp binary");
        return;
    }
    for runtime in ["luau"] {
        let root = tempfile::tempdir().unwrap();
        workspace(root.path(), runtime);
        for goal in ["fmt", "lint"] {
            let output = run(root.path(), runtime, &[goal, "//...", "//"]);
            assert!(output.status.success(), "{output:?}");
            let stderr = String::from_utf8_lossy(&output.stderr);
            let warning = format!("warning: goal '{goal}' matched targets, but none has a handler for this goal; a handler import may be missing");
            assert_eq!(stderr.matches(&warning).count(), 1, "{output:?}");
            assert!(!String::from_utf8_lossy(&output.stdout).contains(WARNING));

            let output = run(root.path(), runtime, &[goal, "//:built"]);
            assert_no_warning(&output, false);
            assert!(
                String::from_utf8_lossy(&output.stderr)
                    .contains(&format!("has no '{goal}' workflow")),
                "{output:?}"
            );
            let output = run(root.path(), runtime, &[goal, "//missing/..."]);
            assert_no_warning(&output, false);
            assert!(
                String::from_utf8_lossy(&output.stderr).contains("no target matches selector"),
                "{output:?}"
            );
        }
        assert_no_warning(&run(root.path(), runtime, &["build", "//..."]), true);

        add_handlers(root.path(), runtime);
        for goal in ["fmt", "lint"] {
            // The first selector has no handler. The second runs valid work.
            // Repeat the invocation to cover reuse of cached task results.
            for _ in 0..2 {
                let output = run(root.path(), runtime, &[goal, "//", "//checked/..."]);
                assert_no_warning(&output, true);
                assert!(
                    String::from_utf8_lossy(&output.stdout).contains(&format!("{goal}: 1")),
                    "{output:?}"
                );
            }
            assert_no_warning(
                &run(
                    root.path(),
                    runtime,
                    &[goal, "//checked/...", "//missing/..."],
                ),
                false,
            );
        }
    }
}

#[test]
fn unchanged_selection_keeps_its_existing_nothing_to_do_message() {
    if !Path::new(env!("CARGO_BIN_EXE_imp")).is_file() {
        eprintln!("skip CLI warning check: cargo did not stage the imp binary");
        return;
    }
    for runtime in ["luau"] {
        let root = tempfile::tempdir().unwrap();
        workspace(root.path(), runtime);
        for args in [
            vec!["init", "--quiet"],
            vec!["add", "."],
            vec![
                "-c",
                "user.name=Imp Test",
                "-c",
                "user.email=imp@example.invalid",
                "commit",
                "--quiet",
                "-m",
                "fixture",
            ],
        ] {
            let output = Command::new("git")
                .current_dir(root.path())
                .args(args)
                .output()
                .unwrap();
            assert!(output.status.success(), "{output:?}");
        }
        for goal in ["fmt", "lint"] {
            let output = run(
                root.path(),
                runtime,
                &[goal, "--changed-since", "HEAD", "//..."],
            );
            assert_no_warning(&output, true);
            assert!(
                String::from_utf8_lossy(&output.stderr).contains("nothing to do"),
                "{output:?}"
            );
        }
    }
}

#[test]
fn empty_luau_expansions_have_a_handler_even_without_child_roots() {
    if !Path::new(env!("CARGO_BIN_EXE_imp")).is_file() {
        eprintln!("skip CLI warning check: cargo did not stage the imp binary");
        return;
    }
    let root = tempfile::tempdir().unwrap();
    workspace(root.path(), "luau");
    write(
        root.path(),
        "BUILD.luau",
        r#"
local core = require("@imp/core")
local fmt = require("@imp/rules/workflows/fmt")
local lint = require("@imp/rules/workflows/lint")
local children = core.expand({ create = function() return {} end })
return { empty = {
    [fmt.FMT] = children:all(fmt.FMT),
    [lint.LINT] = children:all(lint.LINT),
} }
"#,
    );
    for goal in ["fmt", "lint"] {
        for selector in ["//...", "//:empty"] {
            assert_no_warning(&run(root.path(), "luau", &[goal, selector]), true);
        }
    }
}

#[test]
fn changed_roots_without_the_requested_workflow_remain_a_silent_noop() {
    if !Path::new(env!("CARGO_BIN_EXE_imp")).is_file() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    workspace(root.path(), "luau");
    for args in [
        vec!["init", "--quiet"],
        vec!["add", "."],
        vec![
            "-c",
            "user.name=Imp Test",
            "-c",
            "user.email=imp@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "fixture",
        ],
    ] {
        assert!(Command::new("git")
            .current_dir(root.path())
            .args(args)
            .status()
            .unwrap()
            .success());
    }
    let build = root.path().join("BUILD.luau");
    std::fs::write(&build, std::fs::read_to_string(&build).unwrap() + "\n").unwrap();
    for goal in ["fmt", "lint"] {
        let output = run(
            root.path(),
            "luau",
            &[goal, "//...", "--changed-since", "HEAD"],
        );
        assert_no_warning(&output, true);
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("nothing to do"),
            "{output:?}"
        );
    }
}
