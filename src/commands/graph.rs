use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use regex::Regex;

use crate::env::LocalEnv;
use crate::workspace;

type Tree = Arc<prodash::tree::Root>;

struct File {
    path: String,
    imports: Vec<String>,
}

struct Package {
    canonical: String,
    files: Vec<File>,
}

pub async fn cmd_graph(files_mode: bool, tree: &Tree) -> Result<()> {
    let mut p = tree.add_child("graph: scanning imports");
    let odin_files = workspace::get_odin_files();
    let import_re = Regex::new(r#"^\s*import\s*[_\w]*\s+"([^"]+)""#).unwrap();
    let project_root = workspace::root_dir();

    let mut packages: HashMap<String, Package> = HashMap::new();

    for path in &odin_files {
        let path_str = path.to_string_lossy();
        if path_str.contains("test") || path_str.contains("example") {
            continue;
        }

        let rel = path.strip_prefix(&project_root).unwrap_or(path);
        let Some(pkg_name) = canonicalize_pkg(rel.parent().unwrap_or(Path::new(""))) else {
            continue;
        };

        let pkg = packages.entry(pkg_name.clone()).or_insert_with(|| Package {
            canonical: pkg_name.clone(),
            files: Vec::new(),
        });

        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        let mut imports = Vec::new();
        for line in text.lines() {
            if let Some(cap) = import_re.captures(line) {
                if let Some(dep) = canonicalize_import(path, &cap[1]) {
                    imports.push(dep);
                }
            }
        }
        pkg.files.push(File {
            path: path.to_string_lossy().into_owned(),
            imports,
        });
    }

    let mut out = vec!["graph TD".to_owned()];

    if files_mode {
        for pkg in packages.values() {
            out.push(format!("  subgraph {}", pkg.canonical));
            for f in &pkg.files {
                let node_id = f.path.replace(std::path::MAIN_SEPARATOR, "_");
                let label = Path::new(&f.path)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                out.push(format!("    {node_id}[\"{label}\"]"));
            }
            out.push("  end".to_owned());
        }
        for pkg in packages.values() {
            for file in &pkg.files {
                let src_id = file.path.replace(std::path::MAIN_SEPARATOR, "_");
                for dep in &file.imports {
                    out.push(format!("  {src_id} --> {dep}"));
                }
            }
        }
    } else {
        let mut seen_edges: HashSet<(String, String)> = HashSet::new();
        for pkg in packages.values() {
            out.push(format!("  {}[\"{}\"]", pkg.canonical, pkg.canonical));
            for file in &pkg.files {
                for dep in &file.imports {
                    if packages.contains_key(dep) {
                        let edge = (pkg.canonical.clone(), dep.clone());
                        if seen_edges.insert(edge) {
                            out.push(format!("  {} --> {dep}", pkg.canonical));
                        }
                    }
                }
            }
        }
    }

    let mermaid = out.join("\n");
    p.set_name("graph: generating SVG");

    let tmp = tempfile::NamedTempFile::new()?;
    {
        let mut f = tmp.as_file();
        write!(f, "{mermaid}")?;
    }

    let tmp_path = tmp.path().to_string_lossy().into_owned();
    let local = LocalEnv::new();
    let (code, err) = local
        .execute(
            &["mmdc", "-i", &tmp_path, "-o", "dependencies.svg"],
            None,
            false,
        )
        .await?;
    if code != 0 {
        p.fail(format!("mmdc failed: {err}"));
        anyhow::bail!("mmdc failed: {err}");
    }
    p.done("dependencies.svg written");
    Ok(())
}

fn canonicalize_pkg(rel_dir: &Path) -> Option<String> {
    let parts: Vec<_> = rel_dir.components().collect();
    if parts.is_empty() {
        return None;
    }
    if parts.len() == 1 {
        return Some(format!("root:{}", rel_dir.display()));
    }
    if parts[0].as_os_str() == "library" {
        let rest = rel_dir.strip_prefix("library").unwrap();
        return Some(format!("lib:{}", rest.display()));
    }
    None
}

fn canonicalize_import(from_file: &Path, import: &str) -> Option<String> {
    if let Some((coll, _)) = import.split_once(':') {
        if matches!(coll, "base" | "core" | "vendor") {
            return None;
        }
        return Some(import.to_owned());
    }
    let root = workspace::root_dir();
    let resolved = from_file.parent()?.join(import);
    let rel = resolved.strip_prefix(&root).ok()?;
    let parts: Vec<_> = rel.components().collect();
    if parts.len() == 1 {
        return Some(format!("root:{}", rel.display()));
    }
    if parts.len() == 2 && parts[0].as_os_str() == "library" {
        let rest = rel.strip_prefix("library").unwrap();
        return Some(format!("lib:{}", rest.display()));
    }
    Some(rel.to_string_lossy().into_owned())
}
