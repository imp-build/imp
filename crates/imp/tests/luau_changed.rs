use std::collections::BTreeSet;
use std::path::Path;
use std::process::{Command, Output};

fn write(root: &Path, path: &str, source: &str) {
    let path = root.join(path);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, source).unwrap();
}

fn git(root: &Path, args: &[&str]) {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
}

fn run(root: &Path, args: &[&str]) -> Output {
    let rules = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("rules");
    let output = Command::new(env!("CARGO_BIN_EXE_imp"))
        .current_dir(root)
        .env("IMP_RUNTIME", "luau")
        .env("IMP_RULES_DIR", rules)
        .env_remove("GITHUB_ACTIONS")
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    output
}

fn addresses(output: &Output) -> BTreeSet<String> {
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| line.starts_with("//"))
        .map(str::to_owned)
        .collect()
}

fn expected(values: &[&str]) -> BTreeSet<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

#[cfg(unix)]
#[test]
fn changed_since_tracks_symlinked_workspace_configuration() {
    if !Path::new(env!("CARGO_BIN_EXE_imp")).is_file() {
        eprintln!("skip Luau changed CLI check: cargo did not stage the imp binary");
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    write(
        root,
        "config.luau",
        "require('@imp/rules/workflows/build')\nreturn require('@workspace/settings')\n",
    );
    write(root, "settings.luau", "return {}\n");
    std::os::unix::fs::symlink("config.luau", root.join("imp.workspace.luau")).unwrap();
    for package in ["a", "b"] {
        write(root, &format!("{package}/BUILD.luau"), "local core = require('@imp/core')\nreturn { app = core.task({ run = function() error('must not run') end }) }\n");
        write(
            root,
            &format!("{package}/unit.test.luau"),
            "error('must not run')\n",
        );
    }
    git(root, &["init", "-q"]);
    git(root, &["add", "."]);
    git(
        root,
        &[
            "-c",
            "user.name=Imp Test",
            "-c",
            "user.email=imp@example.invalid",
            "commit",
            "-qm",
            "baseline",
        ],
    );
    for (path, wanted) in [
        ("a/BUILD.luau", vec!["//a:app"]),
        ("a/unit.test.luau", vec!["//a:app"]),
        ("config.luau", vec!["//a:app", "//b:app"]),
        ("settings.luau", vec!["//a:app", "//b:app"]),
    ] {
        let source = std::fs::read_to_string(root.join(path)).unwrap();
        write(root, path, &(source + "\n"));
        let output = run(root, &["targets", "//...", "--changed-since", "HEAD"]);
        assert_eq!(addresses(&output), expected(&wanted), "{path}: {output:?}");
        assert!(
            !String::from_utf8_lossy(&output.stderr).contains("owned by no selectable root"),
            "{path}: {output:?}"
        );
        git(root, &["checkout", "--", path]);
    }
}

#[test]
fn changed_since_selects_luau_modules_inputs_and_expansion_children() {
    // The Imp Cargo action does not stage the separate CLI binary.
    if !Path::new(env!("CARGO_BIN_EXE_imp")).is_file() {
        eprintln!("skip Luau changed CLI check: cargo did not stage the imp binary");
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    write(
        root,
        "imp.workspace.luau",
        "require('@imp/rules/workflows/build')\nreturn {}\n",
    );
    write(root, "shared/leaf.luau", "return true\n");
    write(root, "shared/index.luau", "return require('./leaf')\n");
    for package in ["a", "b"] {
        write(
            root,
            &format!("{package}/BUILD.luau"),
            &format!(
                r#"
local core = require('@imp/core')
require('@workspace/shared')
require('@workspace/shared/index.luau')
return {{ app = core.task({{
    inputs = {{ nested = {{ sources = core.files({{ root = '{package}', include = {{ '*.txt' }}, exclude = {{ 'excluded.txt' }} }}) }} }},
    cache = false,
    run = function() core.log_warn('executed-{package}') end,
}}) }}
"#
            ),
        );
        write(root, &format!("{package}/input.txt"), "initial\n");
        write(root, &format!("{package}/excluded.txt"), "initial\n");
        write(
            root,
            &format!("{package}/unit.test.luau"),
            "error('selection must not execute test modules')\n",
        );
    }
    write(root, "other/BUILD.luau", "local core = require('@imp/core')\nreturn { idle = core.task({ run = function() error('unrelated root ran') end }) }\n");
    write(
        root,
        "expanded/BUILD.luau",
        r#"
local core = require('@imp/core')
local build = require('@imp/rules/workflows/build')
local discover = core.task({
    inputs = { files = core.files({ root = 'expanded', include = { 'discovery.txt' } }) },
    outputs = { value = core.output.value() },
    run = function() return { value = true } end,
})
local children = core.expand({ inputs = { metadata = discover.outputs.value }, create = function()
    local result = {}
    for _, key in ipairs({ 'first', 'second' }) do
        result[key] = { [build.BUILD] = core.task({
            inputs = { files = core.files({ root = 'expanded', include = { key .. '.txt' } }) },
            run = function() error('change detection executed a root action') end,
        }) }
    end
    return result
end })
return { group = { [build.BUILD] = children:all(build.BUILD) }, picked = { [build.BUILD] = children:get('first', build.BUILD) } }
"#,
    );
    for path in [
        "expanded/first.txt",
        "expanded/second.txt",
        "expanded/discovery.txt",
        "unowned.txt",
    ] {
        write(root, path, "initial\n");
    }
    git(root, &["init", "-q"]);
    git(root, &["add", "."]);
    git(
        root,
        &[
            "-c",
            "user.name=Imp Test",
            "-c",
            "user.email=imp@example.invalid",
            "commit",
            "-qm",
            "baseline",
        ],
    );

    for (path, wanted, owned) in [
        ("a/BUILD.luau", vec!["//a:app"], true),
        ("a/unit.test.luau", vec!["//a:app"], true),
        ("shared/leaf.luau", vec!["//a:app", "//b:app"], true),
        ("shared/index.luau", vec!["//a:app", "//b:app"], true),
        ("a/input.txt", vec!["//a:app"], true),
        ("a/excluded.txt", vec![], false),
        ("unowned.txt", vec![], false),
        (
            "expanded/first.txt",
            vec![
                "//expanded:group",
                "//expanded:group#first",
                "//expanded:picked",
            ],
            true,
        ),
        (
            "expanded/second.txt",
            vec!["//expanded:group", "//expanded:group#second"],
            true,
        ),
        (
            "expanded/discovery.txt",
            vec!["//expanded:group", "//expanded:picked"],
            true,
        ),
    ] {
        let source = std::fs::read_to_string(root.join(path)).unwrap();
        write(root, path, &(source + "\n"));
        let output = run(root, &["targets", "//...", "--changed-since", "HEAD"]);
        assert_eq!(addresses(&output), expected(&wanted), "{path}: {output:?}");
        assert_eq!(
            !String::from_utf8_lossy(&output.stderr).contains("owned by no selectable root"),
            owned,
            "{path}: {output:?}"
        );
        if owned {
            assert!(
                String::from_utf8_lossy(&output.stdout).contains("selected because:"),
                "{output:?}"
            );
        }
        git(root, &["checkout", "--", path]);
    }

    std::fs::remove_file(root.join("a/input.txt")).unwrap();
    assert_eq!(
        addresses(&run(root, &["targets", "//...", "--changed-since", "HEAD"])),
        expected(&["//a:app"])
    );
    git(root, &["checkout", "--", "a/input.txt"]);
    write(root, "a/new.txt", "new\n");
    assert_eq!(
        addresses(&run(root, &["targets", "//...", "--changed-since", "HEAD"])),
        expected(&["//a:app"])
    );
    std::fs::remove_file(root.join("a/new.txt")).unwrap();
    write(root, "a/new.test.luau", "error('must not run')\n");
    assert_eq!(
        addresses(&run(root, &["targets", "//...", "--changed-since", "HEAD"])),
        expected(&["//a:app"])
    );
    std::fs::remove_file(root.join("a/new.test.luau")).unwrap();
    std::fs::remove_file(root.join("a/unit.test.luau")).unwrap();
    assert_eq!(
        addresses(&run(root, &["targets", "//...", "--changed-since", "HEAD"])),
        expected(&["//a:app"])
    );
    git(root, &["checkout", "--", "a/unit.test.luau"]);

    write(root, "shared/leaf.luau", "return false\n");
    assert_eq!(
        addresses(&run(
            root,
            &["targets", "//b/...", "--changed-since", "HEAD"]
        )),
        expected(&["//b:app"])
    );
    git(root, &["checkout", "--", "shared/leaf.luau"]);
    write(root, "a/input.txt", "changed\n");
    let output = run(root, &["build", "//...", "--changed-since", "HEAD"]);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("executed-a"), "{output:?}");
    assert!(!stderr.contains("executed-b"), "{output:?}");
    git(root, &["checkout", "--", "a/input.txt"]);
    write(
        root,
        "imp.workspace.luau",
        "require('@imp/rules/workflows/build')\nreturn {}\n\n",
    );
    assert_eq!(
        addresses(&run(root, &["targets", "//...", "--changed-since", "HEAD"])),
        expected(&[
            "//a:app",
            "//b:app",
            "//other:idle",
            "//expanded:group",
            "//expanded:picked"
        ])
    );
}
