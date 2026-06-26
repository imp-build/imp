use std::collections::HashSet;
use std::path::PathBuf;

use anyhow::{Context, Result};
use regex::Regex;

use crate::env::LocalEnv;
use crate::workspace;

/// Scan Odin files for generated registration attributes.
pub async fn update_module_list(progress: &mut prodash::tree::Item) -> Result<()> {
    progress.set_name("codegen: scanning modules/components/assets");

    let package_re = Regex::new(r"package\s+(\w+)").unwrap();
    let module_tag_re =
        Regex::new(r#"@\(tag\s*=\s*"module(?:\(([^"]*)\))?"\)\s*(\w+)\s*::\s*struct"#).unwrap();
    let component_tag_re =
        Regex::new(r#"@\(tag\s*=\s*"component(?:\(([^"]*)\))?"\)\s*(\w+)\s*::\s*struct"#).unwrap();
    let asset_tag_re =
        Regex::new(r#"@\(tag\s*=\s*"asset(?:\(([^"]*)\))?"\)\s*(\w+)\s*::\s*struct"#).unwrap();

    let root = workspace::root_dir();
    let odin_files = workspace::get_odin_files();

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

    let out_path = workspace::root_dir().join("ottar/generated_register.odin");
    std::fs::write(&out_path, out.join("\n"))
        .with_context(|| format!("write {}", out_path.display()))?;

    // format
    let odinfmt = workspace::odinfmt_bin();
    let odinfmt_str = odinfmt.to_string_lossy().into_owned();
    let out_str = out_path.to_string_lossy().into_owned();
    LocalEnv::new()
        .execute_check(&[&odinfmt_str, "-w", &out_str], None, false)
        .await?;

    progress.set_name(format!(
        "codegen: {} module registrations, {} component registrations, {} asset registrations",
        modules.len(),
        components.len(),
        assets.len()
    ));
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
