//! Grammar round-trip check: dlopen a real JSON grammar, parse with it, query
//! it, and assert the results — the end-to-end exercise of this crate's public
//! API against a genuine tree-sitter grammar.
//!
//! This is deliberately a plain binary, not a `cargo` test. The grammar it
//! needs is a shared library that only an `imp` build compiles
//! (`rules/treesitter`'s graph-built grammar), so the check is driven by
//! `imp test //rules/treesitter:roundtrip`, which
//! builds this binary and runs it with that library staged, passing its path
//! as the first argument. Nothing here is reachable from `cargo test
//! --workspace`, so a plain checkout with no `build/` directory still builds.
//!
//! The library is loaded from a path at run time — never embedded — so this
//! binary has no build-time dependency on the fixture and no dependency on the
//! source tree once compiled.
//!
//! Exit code 0 means every check passed; any failure prints a message and
//! exits non-zero.

use std::path::{Path, PathBuf};

use anyhow::{bail, ensure, Context, Result};
use imp_treesitter::GrammarRegistry;

fn main() -> Result<()> {
    let fixture = std::env::args_os().nth(1).map(PathBuf::from).context(
        "usage: treesitter-roundtrip <path-to-json-grammar.so>; run it via \
         `imp test //rules/treesitter:roundtrip`",
    )?;
    ensure!(
        fixture.is_file(),
        "grammar library {} does not exist or is not a file",
        fixture.display()
    );

    // `GrammarRegistry::load_grammar` infers the C entry-point symbol from the
    // file stem (`tree-sitter-json.so` -> `tree_sitter_json`). The staged
    // artifact is named after the graph output path,
    // which does not infer, so copy it once to a scratch file with a name that
    // does. This also keeps the loaded path off the source tree.
    let grammar = stage_grammar(&fixture).context("stage grammar library for loading")?;
    ensure!(
        grammar.starts_with(std::env::temp_dir()),
        "staged grammar {} is not under the temp dir",
        grammar.display()
    );

    load_parse_and_dump_sexp(&grammar)?;
    load_grammar_is_idempotent_by_path(&grammar)?;
    query_captures_matching_nodes(&grammar)?;
    explicit_symbol_name_is_honored(&grammar)?;

    println!("ok: grammar round-trip passed");
    Ok(())
}

/// Copy the grammar library to a per-process scratch file named so that
/// symbol-name inference resolves to `tree_sitter_json`.
fn stage_grammar(fixture: &Path) -> Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("imp-treesitter-roundtrip-{}", std::process::id()));
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    let staged = dir.join("tree-sitter-json.so");
    std::fs::copy(fixture, &staged)
        .with_context(|| format!("copy {} -> {}", fixture.display(), staged.display()))?;
    Ok(staged)
}

fn load_parse_and_dump_sexp(grammar_path: &Path) -> Result<()> {
    let registry = GrammarRegistry::new();
    let grammar = registry.load_grammar(grammar_path, None)?;
    let tree = registry.parse(grammar, r#"{"a": [1, 2, true]}"#.to_string())?;

    let sexp = registry.tree_sexp(tree)?;
    for expected in ["document", "object", "array"] {
        ensure!(
            sexp.contains(expected),
            "s-expression is missing {expected:?}: {sexp}"
        );
    }
    println!("ok: load, parse, s-expression dump");
    Ok(())
}

fn load_grammar_is_idempotent_by_path(grammar_path: &Path) -> Result<()> {
    let registry = GrammarRegistry::new();
    let a = registry.load_grammar(grammar_path, None)?;
    let b = registry.load_grammar(grammar_path, None)?;
    ensure!(
        a == b,
        "loading the same path twice returned different handles ({a} vs {b})"
    );
    println!("ok: repeated load reuses the handle");
    Ok(())
}

fn query_captures_matching_nodes(grammar_path: &Path) -> Result<()> {
    let registry = GrammarRegistry::new();
    let grammar = registry.load_grammar(grammar_path, None)?;
    let tree = registry.parse(grammar, r#"{"name": "imp", "ok": true}"#.to_string())?;

    let matches = registry.run_query(grammar, tree, "(string (string_content) @key)")?;
    let texts: Vec<&str> = matches
        .iter()
        .flat_map(|m| m.captures.iter().map(|c| c.text.as_str()))
        .collect();
    for expected in ["name", "imp", "ok"] {
        ensure!(
            texts.contains(&expected),
            "query captures are missing {expected:?}: {texts:?}"
        );
    }
    println!("ok: query captures matching nodes");
    Ok(())
}

fn explicit_symbol_name_is_honored(grammar_path: &Path) -> Result<()> {
    let registry = GrammarRegistry::new();
    let grammar = match registry.load_grammar(grammar_path, Some("tree_sitter_json")) {
        Ok(grammar) => grammar,
        Err(err) => bail!("load with explicit symbol tree_sitter_json: {err:?}"),
    };
    let tree = registry.parse(grammar, "null".to_string())?;
    let sexp = registry.tree_sexp(tree)?;
    ensure!(
        sexp.contains("null"),
        "s-expression is missing \"null\": {sexp}"
    );
    println!("ok: explicit symbol name honored");
    Ok(())
}
