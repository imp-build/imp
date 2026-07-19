use std::collections::HashSet;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use regex::Regex;
use walkdir::WalkDir;

const CODEGEN_EXCLUDE: &[&str] = &[
    ".toolchain",
    "target/",
    "vendor/jodin/joltphysics",
    "vendor/jodin/out",
];

fn get_odin_files_from(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for entry in WalkDir::new(root).into_iter().filter_entry(|e| {
        let s = e.path().to_string_lossy();
        !CODEGEN_EXCLUDE.iter().any(|ex| s.contains(ex))
    }) {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension() != Some(OsStr::new("odin")) {
            continue;
        }
        // Exclude test files to match odinPackage's default exclude patterns.
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        if name.ends_with("_test.odin") || name.starts_with("test_") {
            continue;
        }
        files.push(path.to_owned());
    }
    files.sort();
    files
}

/// Scan Odin files for generated registration attributes, writing to `out_path`.
/// Scans from the current working directory.
pub async fn update_module_list_to(out_path: &Path, odinfmt: &Path) -> Result<()> {
    let root = std::env::current_dir().context("get current directory")?;
    let out_path_abs = if out_path.is_absolute() {
        out_path.to_owned()
    } else {
        root.join(out_path)
    };

    let package_re = Regex::new(r"package\s+(\w+)").unwrap();
    let module_tag_re =
        Regex::new(r#"@\(tag\s*=\s*"module(?:\(([^"]*)\))?"\)\s*(\w+)\s*::\s*struct"#).unwrap();
    let component_tag_re =
        Regex::new(r#"@\(tag\s*=\s*"component(?:\(([^"]*)\))?"\)\s*(\w+)\s*::\s*struct"#).unwrap();
    let asset_tag_re =
        Regex::new(r#"@\(tag\s*=\s*"asset(?:\(([^"]*)\))?"\)\s*(\w+)\s*::\s*struct"#).unwrap();

    let odin_files = get_odin_files_from(&root);

    let mut modules: Vec<std::collections::HashMap<String, String>> = Vec::new();
    let mut components: Vec<std::collections::HashMap<String, String>> = Vec::new();
    let mut assets: Vec<std::collections::HashMap<String, String>> = Vec::new();

    for path in &odin_files {
        let text =
            std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;

        let module_tag_matches: Vec<_> = module_tag_re.captures_iter(&text).collect();
        let component_tag_matches: Vec<_> = component_tag_re.captures_iter(&text).collect();
        let asset_tag_matches: Vec<_> = asset_tag_re.captures_iter(&text).collect();
        if module_tag_matches.is_empty()
            && component_tag_matches.is_empty()
            && asset_tag_matches.is_empty()
        {
            continue;
        }

        let package_name = package_re
            .captures(&text)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_owned())
            .with_context(|| format!("no package declaration in {}", path.display()))?;

        let rel_path = path.strip_prefix(&root).unwrap_or(path);

        for cap in module_tag_matches {
            let attr_text = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            let struct_name = cap.get(2).map(|m| m.as_str()).unwrap_or("").to_owned();

            modules.push(module_data(
                &package_name,
                rel_path,
                &struct_name,
                attr_text,
            ));
        }

        for cap in component_tag_matches {
            let attr_text = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            let struct_name = cap.get(2).map(|m| m.as_str()).unwrap_or("").to_owned();

            components.push(component_data(
                &package_name,
                rel_path,
                &struct_name,
                attr_text,
            ));
        }

        for cap in asset_tag_matches {
            let attr_text = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            let struct_name = cap.get(2).map(|m| m.as_str()).unwrap_or("").to_owned();

            assets.push(asset_data(&package_name, rel_path, &struct_name, attr_text));
        }
    }

    assets.sort_by(|a, b| (&a["package"], &a["type"]).cmp(&(&b["package"], &b["type"])));

    // --- generate output ---
    let mut out = vec![
        "package ottar".to_owned(),
        r#"import "root:engine""#.to_owned(),
    ];
    let mut seen_imports: HashSet<String> = HashSet::new();
    seen_imports.insert("root:engine".into());

    for fns in modules.iter().chain(components.iter()).chain(assets.iter()) {
        let imp = PathBuf::from(fns["import"].clone());
        let module_name = &fns["package"];
        let parent = imp.parent().unwrap_or(std::path::Path::new(""));
        // Normalise to forward slashes: on Windows Path components use '\',
        // which is invalid in Odin import paths and breaks the replaces below.
        let rel_str = parent.to_string_lossy().replace('\\', "/");
        let path = format!("../{rel_str}")
            .replace("../library/", "lib:")
            .replace("../engine", "root:engine");

        if seen_imports.contains(&path) {
            continue;
        }
        seen_imports.insert(path.clone());
        out.push(format!(r#"import {module_name} "{path}""#));
    }

    out.push(String::new()); // blank line
    out.push("register_all_modules :: proc(mgr: ^engine.Module_Manager) {".to_owned());

    for fns in &modules {
        let p = &fns["package"];
        let state = &fns["state"];
        let state_var = format!("{}_state", state.to_lowercase());
        let priority = fns.get("priority").map(|s| s.as_str()).unwrap_or("default");
        let prio_cap = capitalize(priority);

        let init = resolve_fn(fns, "init", p);
        let shutdown = resolve_fn(fns, "shutdown", p);

        out.push(format!("    {state_var} := new({p}.{state})"));
        out.push(format!(
            r#"    engine.auto_register(mgr, "{p}.{state}", {state_var}, .{prio_cap}, {init}, {shutdown})"#
        ));
    }
    out.push("}".to_owned());
    out.push(String::new());

    out.push("register_all_components :: proc(reg: ^engine.Component_Registry) {".to_owned());

    for fns in &components {
        let p = &fns["package"];
        let component_type = &fns["type"];

        let destroy = resolve_optional_fn(fns, "destroy", p);
        if destroy == "nil" {
            out.push(format!(
                r#"    engine.component_register(reg, "{p}.{component_type}", {p}.{component_type})"#
            ));
        } else {
            out.push(format!(
                r#"    engine.component_register(reg, "{p}.{component_type}", {p}.{component_type}, {destroy})"#
            ));
        }
    }
    out.push("}".to_owned());
    out.push(String::new());

    out.push("register_all_assets :: proc(reg: ^engine.Asset_Registry) {".to_owned());

    for fns in &assets {
        let p = &fns["package"];
        let asset_type = &fns["type"];

        if has_custom_asset_hooks(fns) {
            let decode = resolve_optional_fn(fns, "decode", p);
            let encode = resolve_optional_fn(fns, "encode", p);
            let destroy = resolve_optional_fn(fns, "destroy", p);

            out.push(format!(
                r#"    engine.asset_register_custom(reg, "{p}.{asset_type}", {decode}, {encode}, {destroy})"#
            ));
        } else {
            out.push(format!(
                r#"    engine.asset_register(reg, "{p}.{asset_type}", {p}.{asset_type})"#
            ));
        }
    }
    out.push("}".to_owned());
    out.push(String::new());

    if let Some(parent) = out_path_abs.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create dir {}", parent.display()))?;
    }
    std::fs::write(&out_path_abs, out.join("\n"))
        .with_context(|| format!("write {}", out_path_abs.display()))?;

    let output = tokio::process::Command::new(odinfmt)
        .arg("-w")
        .arg(&out_path_abs)
        .current_dir(&root)
        .output()
        .await
        .with_context(|| format!("run {}", odinfmt.display()))?;
    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!(
            "{} failed ({}):\n{stdout}{stderr}",
            odinfmt.display(),
            output.status
        );
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn module_data(
    package_name: &str,
    rel_path: &std::path::Path,
    struct_name: &str,
    attr_text: &str,
) -> std::collections::HashMap<String, String> {
    let mut data = std::collections::HashMap::new();
    data.insert("state".into(), struct_name.to_owned());
    data.insert("package".into(), package_name.to_owned());
    data.insert("import".into(), rel_path.to_string_lossy().into_owned());

    for part in attr_text.split(',') {
        if let Some((k, v)) = part.split_once('=') {
            let k = k.trim();
            let v = v.trim();
            if matches!(k, "init" | "shutdown" | "priority") {
                data.insert(k.to_owned(), v.to_owned());
            }
        }
    }

    data
}

fn component_data(
    package_name: &str,
    rel_path: &std::path::Path,
    struct_name: &str,
    attr_text: &str,
) -> std::collections::HashMap<String, String> {
    let mut data = std::collections::HashMap::new();
    data.insert("type".into(), struct_name.to_owned());
    data.insert("package".into(), package_name.to_owned());
    data.insert("import".into(), rel_path.to_string_lossy().into_owned());

    for part in attr_text.split(',') {
        if let Some((k, v)) = part.split_once('=') {
            let k = k.trim();
            let v = v.trim();
            if k == "destroy" {
                data.insert(k.to_owned(), v.to_owned());
            }
        }
    }

    data
}

fn asset_data(
    package_name: &str,
    rel_path: &std::path::Path,
    struct_name: &str,
    attr_text: &str,
) -> std::collections::HashMap<String, String> {
    let mut data = std::collections::HashMap::new();
    data.insert("type".into(), struct_name.to_owned());
    data.insert("package".into(), package_name.to_owned());
    data.insert("import".into(), rel_path.to_string_lossy().into_owned());

    for part in attr_text.split(',') {
        if let Some((k, v)) = part.split_once('=') {
            let k = k.trim();
            let v = v.trim();
            if matches!(k, "decode" | "encode" | "destroy") {
                data.insert(k.to_owned(), v.to_owned());
            }
        }
    }

    data
}

fn has_custom_asset_hooks(fns: &std::collections::HashMap<String, String>) -> bool {
    fns.contains_key("decode") || fns.contains_key("encode") || fns.contains_key("destroy")
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
    }
}

fn resolve_fn(fns: &std::collections::HashMap<String, String>, key: &str, pkg: &str) -> String {
    match fns.get(key) {
        Some(val) => format!("{pkg}.{val}"),
        None => "nil".to_owned(),
    }
}

fn resolve_optional_fn(
    fns: &std::collections::HashMap<String, String>,
    key: &str,
    pkg: &str,
) -> String {
    resolve_fn(fns, key, pkg)
}
