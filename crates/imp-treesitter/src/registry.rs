//! Process-lifetime bookkeeping for loaded grammars and parsed trees.
//!
//! Handles are opaque `u32`s, matching the small-integer-handle convention
//! used elsewhere for host-side state that can't be marshaled into JS
//! directly (see `HostState` in `imp-engine`). Loaded grammar libraries are
//! never unloaded: a live [`tree_sitter::Language`]/[`tree_sitter::Tree`]
//! still points into the shared library's mapped code, so unloading it while
//! anything references it would be undefined behavior.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::Serialize;
use tree_sitter::{Parser, Query, QueryCursor, StreamingIterator};

use crate::ffi::{self, LoadedGrammar};

struct StoredTree {
    tree: tree_sitter::Tree,
    source: String,
}

#[derive(Default)]
struct Inner {
    next_grammar_id: u32,
    next_tree_id: u32,
    grammar_by_path: BTreeMap<PathBuf, u32>,
    grammars: BTreeMap<u32, LoadedGrammar>,
    trees: BTreeMap<u32, StoredTree>,
}

/// Registry of dlopen'd grammars and the trees parsed with them. Safe to
/// share across threads; internally synchronized with a single lock, which
/// is appropriate for the call volumes this API sees (JS host-function
/// calls, not a hot inner loop).
#[derive(Default)]
pub struct GrammarRegistry {
    inner: Mutex<Inner>,
}

#[derive(Serialize)]
pub struct Position {
    pub row: usize,
    pub column: usize,
}

#[derive(Serialize)]
pub struct Capture {
    pub name: String,
    pub text: String,
    pub start_byte: usize,
    pub end_byte: usize,
    pub start_position: Position,
    pub end_position: Position,
}

#[derive(Serialize)]
pub struct Match {
    pub pattern_index: usize,
    pub captures: Vec<Capture>,
}

impl GrammarRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Load (or reuse an already-loaded) grammar from `path`. Returns a
    /// stable handle: loading the same canonicalized path twice returns the
    /// same handle rather than dlopen'ing it again.
    pub fn load_grammar(&self, path: &Path, symbol_name: Option<&str>) -> Result<u32> {
        let canonical = path
            .canonicalize()
            .with_context(|| format!("canonicalize grammar path {}", path.display()))?;

        let mut inner = self.inner.lock().unwrap();
        if let Some(&id) = inner.grammar_by_path.get(&canonical) {
            return Ok(id);
        }

        let loaded = ffi::load_grammar(&canonical, symbol_name)?;
        let id = inner.next_grammar_id;
        inner.next_grammar_id += 1;
        inner.grammar_by_path.insert(canonical, id);
        inner.grammars.insert(id, loaded);
        Ok(id)
    }

    /// Parse `source` with the given grammar, returning a handle to the
    /// resulting tree.
    pub fn parse(&self, grammar_id: u32, source: String) -> Result<u32> {
        let mut inner = self.inner.lock().unwrap();
        let language = &inner
            .grammars
            .get(&grammar_id)
            .with_context(|| format!("no grammar loaded with handle {grammar_id}"))?
            .language;

        let mut parser = Parser::new();
        parser
            .set_language(language)
            .context("set parser language")?;
        let tree = parser
            .parse(&source, None)
            .context("parse produced no tree")?;

        let id = inner.next_tree_id;
        inner.next_tree_id += 1;
        inner.trees.insert(id, StoredTree { tree, source });
        Ok(id)
    }

    /// S-expression dump of the tree's root node, for debugging/simple
    /// structural checks.
    pub fn tree_sexp(&self, tree_id: u32) -> Result<String> {
        let inner = self.inner.lock().unwrap();
        let stored = inner
            .trees
            .get(&tree_id)
            .with_context(|| format!("no tree loaded with handle {tree_id}"))?;
        Ok(stored.tree.root_node().to_sexp())
    }

    /// Run a tree-sitter query against a parsed tree, returning every match
    /// with its captures' text and position.
    pub fn run_query(
        &self,
        grammar_id: u32,
        tree_id: u32,
        query_source: &str,
    ) -> Result<Vec<Match>> {
        let inner = self.inner.lock().unwrap();
        let language = &inner
            .grammars
            .get(&grammar_id)
            .with_context(|| format!("no grammar loaded with handle {grammar_id}"))?
            .language;
        let stored = inner
            .trees
            .get(&tree_id)
            .with_context(|| format!("no tree loaded with handle {tree_id}"))?;

        let query = Query::new(language, query_source).context("compile tree-sitter query")?;
        let capture_names = query.capture_names();
        let source = stored.source.as_bytes();

        let mut cursor = QueryCursor::new();
        let mut matches_iter = cursor.matches(&query, stored.tree.root_node(), source);
        let mut out = Vec::new();
        while let Some(m) = matches_iter.next() {
            let captures = m
                .captures
                .iter()
                .map(|c| {
                    let name = capture_names
                        .get(c.index as usize)
                        .copied()
                        .unwrap_or_default()
                        .to_string();
                    let text = c.node.utf8_text(source).unwrap_or_default().to_string();
                    Capture {
                        name,
                        text,
                        start_byte: c.node.start_byte(),
                        end_byte: c.node.end_byte(),
                        start_position: c.node.start_position().into(),
                        end_position: c.node.end_position().into(),
                    }
                })
                .collect();
            out.push(Match {
                pattern_index: m.pattern_index,
                captures,
            });
        }
        Ok(out)
    }
}

impl From<tree_sitter::Point> for Position {
    fn from(p: tree_sitter::Point) -> Self {
        Position {
            row: p.row,
            column: p.column,
        }
    }
}

#[allow(dead_code)]
fn _assert_send_sync() {
    fn assert<T: Send + Sync>() {}
    assert::<GrammarRegistry>();
}
