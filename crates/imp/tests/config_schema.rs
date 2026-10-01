use std::process::Command;

#[test]
fn config_schema_reports_luau_schemas_and_effective_values() {
    let root = tempfile::tempdir().expect("create temporary workspace");
    std::fs::write(
        root.path().join("rule-config.luau"),
        r#"
local core = require("@imp/core")
core.define_config_schema("sample", {
    enabled = core.field.bool({ default = false }),
})
return {}
"#,
    )
    .expect("write workspace rule config schema");
    std::fs::write(
        root.path().join("imp.workspace.luau"),
        "require('@workspace/rule-config')\nreturn { imp = { jobs = 6 }, cache = { gc_max_age_days = 9 }, sample = { enabled = true } }\n",
    )
    .expect("write Luau workspace config");

    let repository_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .expect("find repository root");
    let imp_binary = std::path::Path::new(env!("CARGO_BIN_EXE_imp"));
    // Imp runs Rust test binaries in an isolated sandbox. Its Cargo test
    // action stages the test binaries, but not this separate CLI binary.
    // Direct `cargo test` runs this CLI regression with the binary present.
    if !imp_binary.is_file() {
        eprintln!("skip config schema CLI check: cargo did not stage the imp binary");
        return;
    }

    let output = Command::new(imp_binary)
        .current_dir(root.path())
        .args(["config", "schema", "--effective"])
        .env("IMP_RULES_DIR", repository_root.join("rules"))
        .output()
        .expect("run config schema command");

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("parse config schema JSON");
    let schemas = result["schemas"].as_array().expect("schema list");
    let imp_schema = schemas
        .iter()
        .find(|schema| schema["namespace"] == "imp")
        .expect("built-in Imp schema");
    assert!(imp_schema["shape"].get("js_workers").is_some());
    assert!(imp_schema["shape"].get("jsWorkers").is_none());
    assert!(schemas.iter().any(|schema| schema["namespace"] == "sample"));
    assert_eq!(result["effective"]["imp"]["jobs"], 6);
    assert_eq!(result["effective"]["imp"]["js_workers"], 1);
    assert_eq!(result["effective"]["cache"]["gc_max_age_days"], 9);
    assert_eq!(result["effective"]["sample"]["enabled"], true);
}
