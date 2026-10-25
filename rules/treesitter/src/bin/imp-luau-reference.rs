//! Read Luau syntax with the graph-provided grammar. Never execute source.
use anyhow::{bail, Context, Result};
use imp_treesitter::GrammarRegistry;
use serde::Serialize;
use std::{collections::BTreeMap, fs, path::PathBuf};
use tree_sitter::Node;

#[derive(Serialize)]
struct Syntax {
    kind: String,
    text: String,
    line: usize,
    end_line: usize,
    fields: BTreeMap<String, usize>,
    children: Vec<Syntax>,
}
fn syntax(node: Node<'_>, source: &str) -> Syntax {
    let mut children = Vec::new();
    let mut fields = BTreeMap::new();
    for i in 0..node.child_count() {
        let child = node.child(i as u32).unwrap();
        if !child.is_named() {
            continue;
        }
        // Function bodies cannot declare module exports. Keep their source in
        // the enclosing function, but do not duplicate every internal node.
        if child.kind() == "block" && node.kind().starts_with("function_") {
            continue;
        }
        if let Some(field) = node.field_name_for_child(i as u32) {
            fields.insert(field.to_owned(), children.len());
        }
        children.push(syntax(child, source));
    }
    Syntax {
        kind: node.kind().to_owned(),
        text: source[node.byte_range()].to_owned(),
        line: node.start_position().row + 1,
        end_line: node.end_position().row + 1,
        fields,
        children,
    }
}
fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let grammar = PathBuf::from(
        args.next()
            .context("usage: imp-luau-reference <grammar> <manifest.json>")?,
    );
    let manifest = PathBuf::from(args.next().context("missing source manifest")?);
    if args.next().is_some() {
        bail!("unexpected argument");
    }
    let paths: Vec<String> = serde_json::from_slice(&fs::read(manifest)?)?;
    let registry = GrammarRegistry::new();
    let id = registry.load_grammar(&grammar, Some("tree_sitter_luau"))?;
    let mut modules = BTreeMap::new();
    for path in paths {
        let source = fs::read_to_string(&path).with_context(|| format!("read {path}"))?;
        let tree = registry.parse(id, source)?;
        let parsed = registry.inspect_tree(tree, |node, source| {
            if node.has_error() {
                bail!("{path}: Luau syntax error: {}", node.to_sexp());
            }
            Ok(syntax(node, source))
        })?;
        modules.insert(path, parsed);
    }
    serde_json::to_writer(std::io::stdout().lock(), &modules)?;
    Ok(())
}
