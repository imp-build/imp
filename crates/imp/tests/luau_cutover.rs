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
    for _, root in ipairs(roots) do table.insert(lines, root.address.spec) end
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

#[test]
fn named_facets_select_independently_and_report_missing_facets_before_execution() {
    if !Path::new(env!("CARGO_BIN_EXE_imp")).is_file() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("imp.workspace.luau"), "return {}\n").unwrap();
    std::fs::create_dir(root.path().join("pkg")).unwrap();
    std::fs::write(
        root.path().join("pkg/BUILD.luau"),
        r#"
local core = require("@imp/core")
local CHECK = core.goal("check", function(roots)
    local names = {}
    for _, root in ipairs(roots) do
        assert(root.address.target == "//pkg:app" or root.address.target == "//pkg:direct")
        table.insert(names, root.address.spec .. "=" .. root.result)
    end
    return table.concat(names, ",")
end)
local function task(name)
    return core.task({ outputs = { value = core.output.value() }, run = function()
        assert(name ~= "guard", "GUARD EXECUTED")
        return { value = name }
    end }).outputs.value
end
return {
    app = { [CHECK] = { unit = task("unit"), doctests = task("doctests") } },
    direct = { [CHECK] = task("direct") },
    guard = { [CHECK] = task("guard") },
}
"#,
    )
    .unwrap();
    for (cwd, selectors, expected) in [
        (root.path(), vec!["//pkg:app@unit"], "//pkg:app@unit=unit"),
        (
            root.path(),
            vec!["//pkg:app", "//pkg:app@unit"],
            "//pkg:app@doctests=doctests,//pkg:app@unit=unit",
        ),
        (root.path(), vec!["//pkg@unit"], "//pkg:app@unit=unit"),
        (root.path(), vec!["//...@unit"], "//pkg:app@unit=unit"),
        (root.path(), vec!["//pkg:direct"], "//pkg:direct=direct"),
        (
            root.path().join("pkg").as_path(),
            vec![":app@unit"],
            "//pkg:app@unit=unit",
        ),
    ] {
        let mut args = vec!["goal", "check"];
        args.extend(selectors);
        let output = run(cwd, None, &args);
        assert!(output.status.success(), "{output:?}");
        assert!(
            String::from_utf8_lossy(&output.stdout).contains(expected),
            "{output:?}"
        );
    }
    for command in [
        vec!["goal", "check", "//pkg:guard", "//pkg:app@missing"],
        vec!["targets", "//pkg:app@missing"],
        vec!["graph", "--view", "catalog", "//pkg:app@missing"],
    ] {
        let output = run(root.path(), None, &command);
        assert!(!output.status.success(), "{output:?}");
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(
            error.contains("available facets: doctests, unit"),
            "{output:?}"
        );
        assert!(!error.contains("GUARD EXECUTED"), "{output:?}");
    }
}

#[test]
fn goal_provider_addresses_keep_module_paths_and_selector_characters() {
    if !Path::new(env!("CARGO_BIN_EXE_imp")).is_file() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("imp.workspace.luau"), "return {}\n").unwrap();
    std::fs::write(root.path().join("BUILD.luau"), r#"
local core = require("@imp/core")
local identities = { "@workspace/tool.lock", "@imp/rules/tool#part@version.lock", "plain#child@facet" }
core.goal("probe", function(roots)
    local names = {}
    for index, root in ipairs(roots) do
        assert(root.address.target == identities[index])
        assert(root.address.spec == identities[index])
        assert(root.address.facet == nil and root.address.child_key == nil)
        table.insert(names, tostring(root.address))
    end
    return table.concat(names, ",")
end, { selection = "none", roots = function()
    local roots = {}
    for _, identity in ipairs(identities) do
        table.insert(roots, { address = identity, root = core.task({ run = function() end }) })
    end
    return roots
end })
return {}
"#).unwrap();
    let output = run(root.path(), None, &["goal", "probe"]);
    assert!(output.status.success(), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stdout)
            .contains("@workspace/tool.lock,@imp/rules/tool#part@version.lock,plain#child@facet"),
        "{output:?}"
    );
}

#[test]
fn changed_selection_preserves_facets_and_validates_unchanged_selectors() {
    if !Path::new(env!("CARGO_BIN_EXE_imp")).is_file() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("imp.workspace.luau"), "return {}\n").unwrap();
    std::fs::create_dir(root.path().join("pkg")).unwrap();
    let source = r#"
local core = require("@imp/core")
local CHECK = core.goal("check", function(roots)
    local names = {}
    for _, root in ipairs(roots) do
        table.insert(names, root.address.spec .. "=" .. root.result)
    end
    return table.concat(names, ",")
end)
local function task(name)
    return core.task({ outputs = { value = core.output.value() }, run = function() return { value = name } end }).outputs.value
end
local OTHER = core.goal("other", function() end)
return {
    app = { [CHECK] = { unit = task("unit"), doctests = task("doctests") } },
    other = { [CHECK] = { doctests = task("other-doctests") } },
    foreign = { [OTHER] = { unit = task("foreign-unit") } },
}
"#;
    std::fs::write(root.path().join("pkg/BUILD.luau"), source).unwrap();
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
    for changed in [false, true] {
        if changed {
            std::fs::write(
                root.path().join("pkg/BUILD.luau"),
                format!("{source}\n-- changed\n"),
            )
            .unwrap();
        }
        for (selectors, expected) in [
            (vec!["//pkg:app@unit"], "//pkg:app@unit=unit"),
            (
                vec!["//pkg:app@unit", "//pkg:app@doctests"],
                "//pkg:app@doctests=doctests,//pkg:app@unit=unit",
            ),
            (vec!["//pkg@unit"], "//pkg:app@unit=unit"),
            (vec!["//...@unit"], "//pkg:app@unit=unit"),
            (
                vec!["//pkg:app", "//pkg:app@unit"],
                "//pkg:app@doctests=doctests,//pkg:app@unit=unit",
            ),
        ] {
            let mut args = vec!["goal", "check", "--changed-since", "HEAD"];
            args.extend(selectors);
            let output = run(root.path(), None, &args);
            assert!(output.status.success(), "{output:?}");
            let stdout = String::from_utf8_lossy(&output.stdout);
            if changed {
                assert!(stdout.contains(expected), "{output:?}");
                assert!(
                    !stdout.contains("other-doctests") && !stdout.contains("foreign-unit"),
                    "{output:?}"
                );
                if !expected.contains("doctests") {
                    assert!(!stdout.contains("@doctests="), "{output:?}");
                }
            } else {
                assert!(!stdout.contains("@unit="), "{output:?}");
                assert!(
                    String::from_utf8_lossy(&output.stderr).contains("nothing to do"),
                    "{output:?}"
                );
            }
        }
        let output = run(
            root.path().join("pkg").as_path(),
            None,
            &["goal", "check", ":app@unit", "--changed-since", "HEAD"],
        );
        assert!(output.status.success(), "{output:?}");
        for command in [
            vec![
                "goal",
                "check",
                "//pkg:app@missing",
                "--changed-since",
                "HEAD",
            ],
            vec!["targets", "//pkg:app@missing", "--changed-since", "HEAD"],
        ] {
            let output = run(root.path(), None, &command);
            assert!(!output.status.success(), "{output:?}");
            assert!(
                String::from_utf8_lossy(&output.stderr)
                    .contains("available facets: doctests, unit"),
                "{output:?}"
            );
        }
        let wildcard = run(
            root.path(),
            None,
            &["targets", "//pkg@unit", "--changed-since", "HEAD"],
        );
        assert!(wildcard.status.success(), "{wildcard:?}");
        let listed = String::from_utf8_lossy(&wildcard.stdout);
        assert!(!listed.contains("//pkg:other"), "{wildcard:?}");
        assert_eq!(listed.contains("//pkg:app"), changed, "{wildcard:?}");
        assert_eq!(listed.contains("//pkg:foreign"), changed, "{wildcard:?}");
        let output = run(
            root.path(),
            None,
            &["targets", "//pkg:app@unit", "--changed-since", "HEAD"],
        );
        assert!(output.status.success(), "{output:?}");
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).contains("//pkg:app"),
            changed,
            "{output:?}"
        );
    }
}
