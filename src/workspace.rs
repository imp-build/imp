use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use anyhow::Result;
use walkdir::WalkDir;

// ---------------------------------------------------------------------------
// Root-relative paths
// ---------------------------------------------------------------------------

pub fn root_dir() -> PathBuf {
    // Crate lives at <root>/tools/imp/
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_owned()
}

pub fn build_dir() -> PathBuf {
    root_dir().join("build")
}
pub fn dist_dir() -> PathBuf {
    root_dir().join("dist")
}
pub fn coverage_dir() -> PathBuf {
    root_dir().join("coverage")
}
pub fn ottar_dir() -> PathBuf {
    root_dir().join("ottar")
}
#[allow(dead_code)]
pub fn test_main_dir() -> PathBuf {
    root_dir().join("test_main")
}
pub fn toolchain_dir() -> PathBuf {
    root_dir().join(".toolchain")
}
pub fn jodin_dir() -> PathBuf {
    root_dir().join("vendor/jodin")
}

// ---------------------------------------------------------------------------
// Odin toolchain version (read from .odin-version)
// ---------------------------------------------------------------------------

pub fn odin_version() -> String {
    let path = root_dir().join(".odin-version");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|_| "dev-2026-03".to_owned())
        .trim()
        .to_owned()
}

pub fn odin_bin() -> PathBuf {
    toolchain_dir()
        .join(odin_version())
        .join("odin")
        .join("odin")
}

pub fn odin_bin_windows() -> PathBuf {
    toolchain_dir()
        .join(odin_version())
        .join("odin-windows")
        .join("odin.exe")
}

pub fn odinfmt_bin() -> PathBuf {
    if let Ok(v) = std::env::var("ODINFMT_BIN") {
        return PathBuf::from(v);
    }
    // Prefer the version pinned by `imp setup` (installed alongside Odin),
    // so local and CI format identically.
    let exe = if cfg!(windows) {
        "odinfmt.exe"
    } else {
        "odinfmt"
    };
    let managed = toolchain_dir()
        .join(odin_version())
        .join("odinfmt")
        .join(exe);
    if managed.is_file() {
        return managed;
    }
    // fall back to system PATH
    PathBuf::from("odinfmt")
}

pub fn kcov_bin() -> PathBuf {
    if let Ok(v) = std::env::var("KCOV_BIN") {
        return PathBuf::from(v);
    }
    PathBuf::from("kcov")
}

// ---------------------------------------------------------------------------
// Build target
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Target {
    pub name: String,
    pub path: PathBuf,
    pub file: bool,
    pub options: Vec<String>,
}

// Per-target extra flags
fn target_overrides() -> HashMap<String, Vec<String>> {
    HashMap::new()
}

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct TestConfig {
    pub package: PathBuf,
    pub options: Vec<String>,
}

fn test_overrides() -> HashMap<String, Vec<String>> {
    let mut m = HashMap::new();
    m.insert(
        "engine".to_owned(),
        vec!["-define:ODIN_TEST_THREADS=1".to_owned()],
    );
    m.insert(
        "vfs".to_owned(),
        vec!["-define:ODIN_TEST_LOG_LEVEL=fatal".to_owned()],
    );
    m
}

// ---------------------------------------------------------------------------
// .odin file discovery
// ---------------------------------------------------------------------------

static EXCLUDED: &[&str] = &["ols-temp", ".git", ".toolchain", "build", "dist", "vendor"];

pub fn get_odin_files() -> Vec<PathBuf> {
    let root = root_dir();
    let mut files = Vec::new();
    for entry in WalkDir::new(&root).into_iter().filter_entry(|e| {
        let s = e.path().to_string_lossy();
        !EXCLUDED.iter().any(|ex| s.contains(ex))
    }) {
        let Ok(entry) = entry else { continue };
        if entry.path().extension() == Some(OsStr::new("odin")) {
            files.push(entry.path().to_owned());
        }
    }
    // WalkDir yields entries in filesystem order, which differs across
    // platforms; sort so downstream codegen output is deterministic.
    files.sort();
    files
}

// ---------------------------------------------------------------------------
// Target discovery
// ---------------------------------------------------------------------------

pub fn get_targets() -> Result<Vec<Target>> {
    let root = root_dir();
    let overrides = target_overrides();
    let odin_files = get_odin_files();

    let mut dir_map: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    for path in &odin_files {
        let content = std::fs::read_to_string(path)?;
        if content.contains("\nmain :: proc") {
            dir_map
                .entry(path.parent().unwrap().to_owned())
                .or_default()
                .push(path.clone());
        }
    }

    let mut targets = Vec::new();
    for (dir, files) in dir_map {
        let rel_dir = dir.strip_prefix(&root).unwrap_or(&dir).to_owned();
        let name = rel_dir
            .file_name()
            .unwrap_or(OsStr::new("unnamed"))
            .to_string_lossy()
            .into_owned();
        let options = overrides.get(&name).cloned().unwrap_or_default();

        if files.len() > 1 {
            for file in files {
                let rel_file = file.strip_prefix(&root).unwrap_or(&file).to_owned();
                let fname = rel_file
                    .file_name()
                    .unwrap_or(OsStr::new("unnamed"))
                    .to_string_lossy()
                    .into_owned();
                targets.push(Target {
                    name: fname,
                    path: rel_file,
                    file: true,
                    options: options.clone(),
                });
            }
        } else {
            targets.push(Target {
                name,
                path: rel_dir,
                file: false,
                options,
            });
        }
    }
    Ok(targets)
}

// ---------------------------------------------------------------------------
// Test suite discovery
// ---------------------------------------------------------------------------

pub fn get_test_configs() -> Result<Vec<TestConfig>> {
    let root = root_dir();
    let overrides = test_overrides();
    let odin_files = get_odin_files();

    let mut dirs = std::collections::HashSet::new();
    for path in &odin_files {
        let content = std::fs::read_to_string(path)?;
        if content.contains("@(test)") {
            if let Some(parent) = path.parent() {
                dirs.insert(parent.to_owned());
            }
        }
    }

    let mut configs = Vec::new();
    for dir in dirs {
        let rel = dir.strip_prefix(&root).unwrap_or(&dir).to_owned();
        let key = rel
            .file_name()
            .unwrap_or(OsStr::new(""))
            .to_string_lossy()
            .into_owned();
        let options = overrides.get(&key).cloned().unwrap_or_default();
        configs.push(TestConfig {
            package: rel,
            options,
        });
    }
    Ok(configs)
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

#[allow(dead_code)]
pub fn relative_to_workspace(path: &Path) -> &Path {
    let root = root_dir();
    path.strip_prefix(&root).unwrap_or(path)
}
