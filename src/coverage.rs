use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::Write;
use std::path::Path;

use anyhow::{Context, Result};
use serde::Deserialize;

use crate::workspace;

#[derive(Deserialize, Debug)]
pub struct FileCoverage {
    pub file: String,
    #[serde(deserialize_with = "de_float_or_str")]
    pub percent_covered: f64,
    #[serde(deserialize_with = "de_u64_or_str")]
    pub covered_lines: u64,
    #[serde(deserialize_with = "de_u64_or_str")]
    pub total_lines: u64,
}

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
pub struct CoverageData {
    pub files: Vec<FileCoverage>,
    #[serde(deserialize_with = "de_float_or_str")]
    pub percent_covered: f64,
    #[serde(deserialize_with = "de_u64_or_str")]
    pub covered_lines: u64,
    #[serde(deserialize_with = "de_u64_or_str")]
    pub total_lines: u64,
    pub command: Option<String>,
    pub date: Option<String>,
}

pub fn load_coverage(json_path: &Path) -> Result<CoverageData> {
    let text = std::fs::read_to_string(json_path)
        .with_context(|| format!("read {}", json_path.display()))?;
    serde_json::from_str(&text).context("parse coverage JSON")
}

/// Merge kcov JSON with all discovered Odin files and write a markdown report.
pub fn generate_report(json_path: &Path, output_path: &Path) -> Result<()> {
    let data = load_coverage(json_path)?;
    let odin_files = list_non_test_odin_files();

    let file_map: HashMap<&str, &FileCoverage> =
        data.files.iter().map(|f| (f.file.as_str(), f)).collect();

    let mut covered_lines = 0u64;
    let mut total_lines = 0u64;
    let mut merged_files: Vec<FileCoverage> = Vec::new();

    for file_path in &odin_files {
        let key = file_path.as_str();
        if let Some(fc) = file_map.get(key) {
            covered_lines += fc.covered_lines;
            total_lines += fc.total_lines;
            merged_files.push(FileCoverage {
                file: fc.file.clone(),
                percent_covered: fc.percent_covered,
                covered_lines: fc.covered_lines,
                total_lines: fc.total_lines,
            });
        } else {
            let actual_lines = count_non_blank_lines(Path::new(key));
            total_lines += actual_lines;
            merged_files.push(FileCoverage {
                file: file_path.clone(),
                percent_covered: 0.0,
                covered_lines: 0,
                total_lines: actual_lines,
            });
        }
    }

    let percent = if total_lines > 0 {
        covered_lines as f64 / total_lines as f64 * 100.0
    } else {
        0.0
    };

    let root = workspace::root_dir().to_string_lossy().into_owned();
    let mut f = std::fs::File::create(output_path)
        .with_context(|| format!("create {}", output_path.display()))?;

    writeln!(f, "# Coverage Report\n")?;
    writeln!(f, "## Overall Coverage\n")?;
    writeln!(f, "**Percent Covered**: {percent:.2}%    ")?;
    writeln!(f, "**Covered Lines**: {covered_lines}    ")?;
    writeln!(f, "**Total Lines**: {total_lines} |")?;
    writeln!(f, "\n\n## File Coverage Details\n")?;
    writeln!(
        f,
        "| **File** | **Percent Covered** | **Covered Lines** | **Total Lines** |"
    )?;
    writeln!(f, "| --- | --- | --- | --- |")?;
    for fc in &merged_files {
        let clean = fc.file.trim_start_matches(&*root).trim_start_matches('/');
        writeln!(
            f,
            "| {clean} | {:.2}% | {} | {} |",
            fc.percent_covered, fc.covered_lines, fc.total_lines
        )?;
    }

    Ok(())
}

fn list_non_test_odin_files() -> Vec<String> {
    let root = workspace::root_dir();
    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(&root) {
        let Ok(e) = entry else { continue };
        let path = e.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !name.ends_with(".odin") || name.ends_with("_test.odin") {
            continue;
        }
        let path_str = path.to_string_lossy();
        if path_str.contains("imgui_impl") {
            continue;
        }
        if let Some(parent) = path.parent() {
            let parent_name = parent.file_name().and_then(OsStr::to_str).unwrap_or("");
            if parent_name == "test" || parent_name == "tests" {
                continue;
            }
        }
        files.push(path.to_string_lossy().into_owned());
    }
    files
}

fn count_non_blank_lines(path: &Path) -> u64 {
    let Ok(text) = std::fs::read_to_string(path) else {
        return 0;
    };
    text.lines()
        .filter(|l| !l.trim().is_empty() && !l.trim().starts_with("//"))
        .count() as u64
}

// ---------------------------------------------------------------------------
// serde helpers for fields that may be string or number in the JSON
// ---------------------------------------------------------------------------

fn de_float_or_str<'de, D: serde::Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    use serde::de::Error;
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum FloatOrStr {
        F(f64),
        S(String),
    }
    match FloatOrStr::deserialize(d)? {
        FloatOrStr::F(f) => Ok(f),
        FloatOrStr::S(s) => s.parse().map_err(D::Error::custom),
    }
}

fn de_u64_or_str<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    use serde::de::Error;
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum U64OrStr {
        N(u64),
        S(String),
    }
    match U64OrStr::deserialize(d)? {
        U64OrStr::N(n) => Ok(n),
        U64OrStr::S(s) => s.parse().map_err(D::Error::custom),
    }
}
