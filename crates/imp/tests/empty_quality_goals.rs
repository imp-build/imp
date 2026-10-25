use std::path::Path;
use std::process::{Command, Output};

const WARNING: &str = "handler import may be missing";

fn write(root: &Path, path: &str, source: &str) {
    let path = root.join(path);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, source).unwrap();
}

fn run(root: &Path, runtime: &str, args: &[&str]) -> Output {
    let rules = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("rules");
    Command::new(env!("CARGO_BIN_EXE_imp"))
        .current_dir(root)
        .env("IMP_RUNTIME", runtime)
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

fn workspace(root: &Path, runtime: &str) {
    if runtime == "js" {
        write(
            root,
            "imp.workspace.js",
            "import '//rules/workflows/fmt';\nimport '//rules/workflows/lint';\n",
        );
        write(
            root,
            "BUILD.js",
            r#"
import { task } from "imp:core";
import { BUILD } from "//rules/workflows/build";
export const built = { [BUILD]: task({ async run() {} }) };
"#,
        );
    } else {
        write(root, "imp.workspace.luau", "require('@imp/rules/workflows/fmt')\nrequire('@imp/rules/workflows/lint')\nreturn {}\n");
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
}

fn add_handlers(root: &Path, runtime: &str) {
    if runtime == "js" {
        write(
            root,
            "checked/BUILD.js",
            r#"
import { task, output } from "imp:core";
import { FMT } from "//rules/workflows/fmt";
import { LINT } from "//rules/workflows/lint";
export const checked = {
    [FMT]: task({ outputs: { paths: output.value() }, async run() { return { paths: [] }; } }),
    [LINT]: task({ outputs: { ok: output.value() }, async run() { return { ok: true }; } }),
};
"#,
        );
    } else {
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
}

#[test]
fn quality_goals_warn_only_when_the_complete_selection_has_no_handler() {
    if !Path::new(env!("CARGO_BIN_EXE_imp")).is_file() {
        eprintln!("skip CLI warning check: cargo did not stage the imp binary");
        return;
    }
    for runtime in ["js", "luau"] {
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
fn label_handlers_do_not_trigger_the_missing_handler_warning() {
    if !Path::new(env!("CARGO_BIN_EXE_imp")).is_file() {
        eprintln!("skip CLI warning check: cargo did not stage the imp binary");
        return;
    }
    let root = tempfile::tempdir().unwrap();
    workspace(root.path(), "js");
    write(
        root.path(),
        "labels/BUILD.js",
        r#"
import { attach, label } from "imp:core";
export const checked = label();
attach(checked, "fmt", async () => {});
attach(checked, "lint", async () => {});
"#,
    );
    for goal in ["fmt", "lint"] {
        assert_no_warning(&run(root.path(), "js", &[goal, "//..."]), true);
    }
}

#[test]
fn unchanged_selection_keeps_its_existing_nothing_to_do_message() {
    if !Path::new(env!("CARGO_BIN_EXE_imp")).is_file() {
        eprintln!("skip CLI warning check: cargo did not stage the imp binary");
        return;
    }
    for runtime in ["js", "luau"] {
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
