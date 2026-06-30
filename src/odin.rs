// TODO: port to JS rules (no language-specific Rust goal)
// The logic here should eventually live in rules/odin/index.js as part of the
// dependency-inference product, eliminating this file.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::{bail, Context, Result};
use regex::Regex;

use crate::spike::{
    Dependency, DependencyMode, Target, path_to_workspace_string, source_field_workspace_root,
    target_scope_path, workspace_glob_files, workspace_relative_directory,
};

pub(crate) fn infer_odin_dependencies(
    workspace_root: &Path,
    targets: &mut BTreeMap<String, Target>,
    workspace_config: &BTreeMap<String, serde_json::Value>,
) -> Result<()> {
    let odin_packages: Vec<String> = targets
        .values()
        .filter(|target| target.kind == "odin-package")
        .map(|target| target.address.clone())
        .collect();
    if odin_packages.is_empty() {
        return Ok(());
    }

    let mut package_by_path: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for address in &odin_packages {
        let target = &targets[address];
        package_by_path
            .entry(odin_package_path(target)?)
            .or_default()
            .push(address.clone());
    }

    let global_collections = odin_collections_from_workspace_config(workspace_config)?;
    let mut inferred: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for address in &odin_packages {
        let target = &targets[address];
        let self_path = odin_package_path(target)?;
        let mut collections = global_collections.clone();
        for (name, path) in odin_collections_from_target(target, targets)? {
            collections.insert(name, path);
        }

        let mut deps = BTreeSet::new();
        for import in odin_imports_for_target(workspace_root, target)? {
            let Some(resolved_path) = resolve_odin_import_path(&import, &collections)? else {
                continue;
            };
            if resolved_path == self_path {
                continue;
            }
            let candidates = package_by_path
                .get(&resolved_path)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|candidate| candidate != address)
                .collect::<Vec<_>>();
            match candidates.as_slice() {
                [] => {}
                [dep] => {
                    deps.insert(dep.clone());
                }
                many => {
                    bail!(
                        "{}: Odin import '{}' resolves to multiple packages: {}",
                        address,
                        import.path,
                        many.join(", ")
                    );
                }
            }
        }
        inferred.insert(address.clone(), deps.into_iter().collect());
    }

    for (address, deps) in inferred {
        let Some(target) = targets.get_mut(&address) else {
            continue;
        };
        for dep in deps {
            if target
                .dependencies
                .iter()
                .any(|existing| existing.address == dep)
            {
                continue;
            }
            target.dependencies.push(Dependency {
                address: dep,
                mode: DependencyMode::Auto,
            });
        }
    }

    Ok(())
}

fn odin_package_path(target: &Target) -> Result<String> {
    let path = target
        .attrs
        .get("path")
        .and_then(|value| value.as_str())
        .unwrap_or(".");
    normalize_workspace_string(&source_field_workspace_root(&target.address, path)?)
}

fn normalize_workspace_string(path: &str) -> Result<String> {
    Ok(path_to_workspace_string(&workspace_relative_directory(
        path,
    )?))
}

fn target_scope_string(address: &str) -> Result<String> {
    Ok(path_to_workspace_string(&target_scope_path(address)?))
}

fn workspace_join_string(base: &str, path: &str) -> Result<String> {
    let mut parts = Vec::new();
    for part in base.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            bail!("workspace path '{base}' must not contain parent components");
        }
        parts.push(part.to_owned());
    }
    for part in path.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            if parts.pop().is_none() {
                bail!("workspace path '{base}/{path}' escapes the workspace");
            }
            continue;
        }
        parts.push(part.to_owned());
    }
    Ok(if parts.is_empty() {
        ".".to_owned()
    } else {
        parts.join("/")
    })
}

fn odin_collections_from_workspace_config(
    workspace_config: &BTreeMap<String, serde_json::Value>,
) -> Result<BTreeMap<String, String>> {
    let Some(odin) = workspace_config.get("odin") else {
        return Ok(BTreeMap::new());
    };
    odin_collections_from_value(
        odin.get("collections").unwrap_or(&serde_json::Value::Null),
        ".",
    )
}

fn odin_collections_from_target(
    target: &Target,
    targets: &BTreeMap<String, Target>,
) -> Result<BTreeMap<String, String>> {
    let mut collections = BTreeMap::new();
    if let Some(value) = target.attrs.get("collections") {
        collections.extend(odin_collections_from_value(
            value,
            &target_scope_string(&target.address)?,
        )?);
    }
    for dep in &target.dependencies {
        let Some(collection) = targets.get(&dep.address) else {
            continue;
        };
        if collection.kind != "odin-collection" {
            continue;
        }
        let Some(name) = collection
            .attrs
            .get("name")
            .and_then(|value| value.as_str())
        else {
            continue;
        };
        let Some(path) = collection
            .attrs
            .get("path")
            .and_then(|value| value.as_str())
        else {
            continue;
        };
        collections.insert(
            name.to_owned(),
            workspace_join_string(&target_scope_string(&collection.address)?, path)?,
        );
    }
    Ok(collections)
}

fn odin_collections_from_value(
    value: &serde_json::Value,
    base: &str,
) -> Result<BTreeMap<String, String>> {
    let mut collections = BTreeMap::new();
    match value {
        serde_json::Value::Null => {}
        serde_json::Value::Object(object) => {
            for (name, spec) in object {
                if spec.get("__imp_ref").is_some() {
                    continue;
                }
                let path = if let Some(path) = spec.as_str() {
                    path
                } else if let Some(path) = spec.get("path").and_then(|value| value.as_str()) {
                    path
                } else {
                    bail!("Odin collection '{name}' must be a path string or {{ path }} object");
                };
                collections.insert(name.clone(), workspace_join_string(base, path)?);
            }
        }
        serde_json::Value::Array(entries) => {
            for entry in entries {
                if entry.get("__imp_ref").is_some() {
                    continue;
                }
                let name = entry
                    .get("name")
                    .and_then(|value| value.as_str())
                    .ok_or_else(|| {
                        anyhow::anyhow!("Odin collection entries require string name")
                    })?;
                let path = entry
                    .get("path")
                    .and_then(|value| value.as_str())
                    .ok_or_else(|| {
                        anyhow::anyhow!("Odin collection entries require string path")
                    })?;
                collections.insert(name.to_owned(), workspace_join_string(base, path)?);
            }
        }
        _ => bail!("Odin collections config must be an object or array"),
    }
    Ok(collections)
}

struct OdinImport {
    path: String,
    source_file: String,
}

fn resolve_odin_import_path(
    import: &OdinImport,
    collections: &BTreeMap<String, String>,
) -> Result<Option<String>> {
    if import.path.starts_with("./") || import.path.starts_with("../") {
        let base = dirname_workspace_path(&import.source_file);
        return Ok(Some(workspace_join_string(&base, &import.path)?));
    }

    let Some((collection, relative)) = import.path.split_once(':') else {
        return Ok(None);
    };
    let Some(base) = collections.get(collection) else {
        return Ok(None);
    };
    Ok(Some(workspace_join_string(base, relative)?))
}

fn dirname_workspace_path(path: &str) -> String {
    path.rsplit_once('/')
        .map(|(dir, _)| if dir.is_empty() { "." } else { dir })
        .unwrap_or(".")
        .to_owned()
}

fn odin_imports_for_target(workspace_root: &Path, target: &Target) -> Result<Vec<OdinImport>> {
    let mut imports = Vec::new();
    for source in &target.sources {
        if source.include.is_empty() {
            continue;
        }
        let root = source_field_workspace_root(&target.address, &source.root)?;
        for file in workspace_glob_files(workspace_root, &root, &source.include, &source.exclude)
            .with_context(|| format!("expand Odin sources for {}", target.address))?
        {
            let content = std::fs::read_to_string(workspace_root.join(&file))
                .with_context(|| format!("read {file}"))?;
            for import in scan_odin_imports(&content)? {
                imports.push(OdinImport {
                    path: import,
                    source_file: file.clone(),
                });
            }
        }
    }
    Ok(imports)
}

fn scan_odin_imports(content: &str) -> Result<Vec<String>> {
    let text = strip_odin_comments(content);
    let mut imports = BTreeSet::new();
    let single = Regex::new(r#"(?m)^\s*import(?:\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s+"([^"]+)""#)
        .context("compile Odin import regex")?;
    for capture in single.captures_iter(&text) {
        if let Some(import) = capture.get(1) {
            imports.insert(import.as_str().to_owned());
        }
    }

    let block = Regex::new(r#"(?ms)^\s*import\s*\((.*?)^\s*\)"#)
        .context("compile Odin import block regex")?;
    let entry = Regex::new(r#"(?m)^\s*(?:[A-Za-z_$][A-Za-z0-9_$]*\s+)?"([^"]+)""#)
        .context("compile Odin import block entry regex")?;
    for capture in block.captures_iter(&text) {
        let Some(body) = capture.get(1) else {
            continue;
        };
        for entry_capture in entry.captures_iter(body.as_str()) {
            if let Some(import) = entry_capture.get(1) {
                imports.insert(import.as_str().to_owned());
            }
        }
    }
    Ok(imports.into_iter().collect())
}

fn strip_odin_comments(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    let mut in_string = false;
    let mut in_rune = false;
    let mut in_line_comment = false;
    let mut block_depth = 0usize;

    while i < bytes.len() {
        let ch = bytes[i] as char;
        let next = bytes.get(i + 1).map(|b| *b as char);

        if in_line_comment {
            if ch == '\n' {
                in_line_comment = false;
                out.push('\n');
            } else {
                out.push(' ');
            }
            i += 1;
            continue;
        }

        if block_depth > 0 {
            if ch == '/' && next == Some('*') {
                block_depth += 1;
                out.push_str("  ");
                i += 2;
            } else if ch == '*' && next == Some('/') {
                block_depth -= 1;
                out.push_str("  ");
                i += 2;
            } else {
                out.push(if ch == '\n' { '\n' } else { ' ' });
                i += 1;
            }
            continue;
        }

        if !in_string && !in_rune && ch == '/' && next == Some('/') {
            in_line_comment = true;
            out.push_str("  ");
            i += 2;
            continue;
        }
        if !in_string && !in_rune && ch == '/' && next == Some('*') {
            block_depth = 1;
            out.push_str("  ");
            i += 2;
            continue;
        }

        out.push(ch);
        let escaped = i > 0 && bytes[i - 1] == b'\\';
        if ch == '"' && !in_rune && !escaped {
            in_string = !in_string;
        } else if ch == '\'' && !in_string && !escaped {
            in_rune = !in_rune;
        }
        i += 1;
    }
    out
}
