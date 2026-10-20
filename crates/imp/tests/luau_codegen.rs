use std::process::{Command, Output};

#[cfg(unix)]
#[test]
fn luau_codegen_exports_selected_cached_artifacts_and_rejects_conflicts() {
    let binary = std::path::Path::new(env!("CARGO_BIN_EXE_imp"));
    // The Imp Cargo action does not stage this separate CLI binary.
    // Run this regression with cargo test --workspace.
    if !binary.is_file() {
        eprintln!("skip Luau codegen CLI check: cargo did not stage the imp binary");
        return;
    }
    let root = tempfile::tempdir().expect("create workspace");
    std::fs::write(
        root.path().join("imp.workspace.luau"),
        "require('@imp/rules/workflows/build')\nrequire('@imp/rules/workflows/codegen')\nreturn {}\n",
    )
    .unwrap();
    std::fs::write(
        root.path().join("BUILD.luau"),
        r#"
local core = require("@imp/core")
local codegen = require("@imp/rules/imp/codegen").codegen
local function generated(path, text)
    return codegen({
        tools = { sh = core.native_tool("sh") },
        output_paths = { path },
        argv = function()
            return { "sh", "-c", "printf %s " .. text .. " > " .. path }
        end,
    })
end
return {
    bindings = generated("app/generated/bindings.txt", "bindings"),
    other = generated("other.txt", "other"),
    conflict = generated("app/generated/bindings.txt", "conflict"),
}
"#,
    )
    .unwrap();
    let rules = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("rules");
    let run = |args: &[&str]| -> Output {
        Command::new(binary)
            .current_dir(root.path())
            .env("IMP_RUNTIME", "luau")
            .env("IMP_RULES_DIR", &rules)
            .args(args)
            .output()
            .expect("run Imp")
    };
    let success = |args: &[&str]| {
        let output = run(args);
        assert!(output.status.success(), "{output:?}");
    };
    success(&["build", "//:bindings"]);
    assert!(!root.path().join("app").exists());
    assert!(!root.path().join("dist").exists());
    success(&["codegen", "//:bindings"]);
    let output = root.path().join("dist/codegen/app/generated/bindings.txt");
    assert_eq!(std::fs::read_to_string(&output).unwrap(), "bindings");
    assert!(!root.path().join("app").exists());
    assert!(!root.path().join("dist/codegen/other.txt").exists());
    std::fs::remove_file(&output).unwrap();
    success(&["codegen", "//:bindings"]);
    assert_eq!(std::fs::read_to_string(&output).unwrap(), "bindings");
    success(&["codegen", "//:other"]);
    assert_eq!(std::fs::read_to_string(&output).unwrap(), "bindings");
    assert_eq!(
        std::fs::read_to_string(root.path().join("dist/codegen/other.txt")).unwrap(),
        "other"
    );
    let failed = run(&["codegen", "//:bindings", "//:conflict"]);
    assert!(!failed.status.success());
    assert!(String::from_utf8_lossy(&failed.stderr).contains("codegen output path conflict"));
    assert_eq!(std::fs::read_to_string(&output).unwrap(), "bindings");
}
