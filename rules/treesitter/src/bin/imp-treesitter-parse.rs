//! Parse source files with a graph-provided Tree-sitter grammar.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use imp_treesitter::GrammarRegistry;
use serde::Serialize;

#[derive(Serialize)]
struct FileAnalysis {
    imports: Vec<String>,
    #[serde(rename = "hasMainEntrypoint")]
    has_main_entrypoint: bool,
}

#[derive(Serialize)]
struct Analysis {
    files: std::collections::BTreeMap<String, FileAnalysis>,
}

fn decode_import(text: &str) -> Option<String> {
    if text.starts_with('`') && text.ends_with('`') {
        return Some(text[1..text.len() - 1].to_string());
    }
    serde_json::from_str(text).ok()
}

fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let grammar = PathBuf::from(
        args.next()
            .context("usage: imp-treesitter-parse <grammar.so> <file>...")?,
    );
    let files: Vec<PathBuf> = args.map(PathBuf::from).collect();
    let registry = GrammarRegistry::new();
    let grammar_id = registry
        .load_grammar(&grammar, Some("tree_sitter_odin"))
        .with_context(|| format!("load Odin grammar {}", grammar.display()))?;
    let mut analyzed = std::collections::BTreeMap::new();

    for path in files {
        let source = fs::read_to_string(&path)
            .with_context(|| format!("read Odin source {}", path.display()))?;
        let tree = registry.parse(grammar_id, source)?;
        let import_matches = registry.run_query(
            grammar_id,
            tree,
            "(import_declaration (string) @path) @declaration",
        )?;
        let imports: Vec<String> = import_matches
            .into_iter()
            .filter_map(|m| {
                let declaration = m
                    .captures
                    .iter()
                    .find(|capture| capture.name == "declaration")?;
                // The Odin grammar represents `foreign import` with the same
                // declaration node as a package import. Keep the graph edge
                // only when the declaration itself starts with `import`.
                if !declaration.text.trim_start().starts_with("import") {
                    return None;
                }
                m.captures
                    .into_iter()
                    .find(|capture| capture.name == "path")
                    .and_then(|capture| decode_import(&capture.text))
            })
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let main_matches = registry.run_query(
            grammar_id,
            tree,
            "(procedure_declaration (identifier) @name (#eq? @name \"main\"))",
        )?;
        analyzed.insert(
            path.to_string_lossy().into_owned(),
            FileAnalysis {
                imports,
                has_main_entrypoint: !main_matches.is_empty(),
            },
        );
    }

    println!("{}", serde_json::to_string(&Analysis { files: analyzed })?);
    Ok(())
}
