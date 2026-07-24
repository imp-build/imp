//! The single `unsafe` boundary in this crate: loading a tree-sitter grammar
//! shared library and turning its exported `tree_sitter_<language>()` C
//! function into a safe [`tree_sitter::Language`].
//!
//! # Trust model
//!
//! A loaded grammar runs fully in-process, with the same privileges as the
//! `imp` process itself. Unlike every other native integration in this
//! codebase (which shells out to a subprocess via `run()`), there is no OS
//! process boundary here: a malicious or buggy grammar library can corrupt or
//! crash the whole process, including the embedded QuickJS heap. Only load
//! grammars you trust, exactly as you would only `run()` a trusted binary.

use std::path::Path;

use anyhow::{Context, Result};
use tree_sitter::Language;
use tree_sitter_language::LanguageFn;

/// A grammar shared library kept alive for the lifetime of the process.
///
/// The `Library` must never be dropped while `language` (or anything parsed
/// with it) is still in use: the returned [`Language`]'s internal function
/// table points into the shared library's mapped code, so unloading the
/// library after resolving the symbol is undefined behavior.
pub struct LoadedGrammar {
    pub language: Language,
    #[allow(dead_code)] // kept only to hold the library open; never read
    library: libloading::Library,
}

/// Derive the grammar's `tree_sitter_<name>` C symbol from its shared library
/// path, e.g. `libtree-sitter-json.so` / `tree-sitter-json.so` -> `tree_sitter_json`.
fn infer_symbol_name(path: &Path) -> Result<String> {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .with_context(|| format!("grammar path has no file stem: {}", path.display()))?;
    let stem = stem.strip_prefix("lib").unwrap_or(stem);
    let name = stem
        .strip_prefix("tree-sitter-")
        .or_else(|| stem.strip_prefix("tree_sitter_"))
        .unwrap_or(stem);
    Ok(format!("tree_sitter_{}", name.replace('-', "_")))
}

/// Load a grammar shared library from `path` and resolve its language.
///
/// `symbol_name` overrides the inferred `tree_sitter_<name>` C symbol; pass
/// `None` to infer it from the file name (e.g. `tree-sitter-json.so` ->
/// `tree_sitter_json`).
///
/// # Safety-relevant behavior
///
/// This dlopens `path` and calls its exported symbol. Only call this with
/// grammar libraries built by the Tree-sitter CLI from trusted sources — see
/// the module docs above.
pub fn load_grammar(path: &Path, symbol_name: Option<&str>) -> Result<LoadedGrammar> {
    let symbol_name = match symbol_name {
        Some(name) => name.to_string(),
        None => infer_symbol_name(path)?,
    };

    // SAFETY: dlopen'ing arbitrary native code is inherently unsafe — its
    // static initializers/constructors run immediately. This is the accepted
    // trust boundary documented in the module docs.
    let library = unsafe { libloading::Library::new(path) }
        .with_context(|| format!("load grammar library {}", path.display()))?;

    // SAFETY: we require the resolved symbol to have the C ABI signature
    // `unsafe extern "C" fn() -> *const ()` that the Tree-sitter CLI generates
    // for every grammar's language-accessor function. A wrong or malicious
    // symbol violates this contract and is the caller's responsibility to
    // avoid, per `LanguageFn::from_raw`'s own safety contract.
    let language = unsafe {
        let symbol: libloading::Symbol<unsafe extern "C" fn() -> *const ()> = library
            .get(symbol_name.as_bytes())
            .with_context(|| format!("resolve symbol {symbol_name} in {}", path.display()))?;
        Language::new(LanguageFn::from_raw(*symbol))
    };

    Ok(LoadedGrammar { language, library })
}
