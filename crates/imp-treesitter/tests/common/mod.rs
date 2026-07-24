//! Path to the checked-in `tree-sitter-json` fixture grammar (see
//! `testdata/tree-sitter-json/README.md` for provenance and how to rebuild
//! it).
//!
//! The bytes are embedded into the test binary at compile time
//! (`include_bytes!`) rather than read from `testdata/` at test-run time:
//! imp's own Rust-test execution runs a compiled test binary as its own
//! sandboxed action whose declared inputs are just that binary's build
//! output digest — never the source tree — so a path built from
//! `CARGO_MANIFEST_DIR` at runtime doesn't resolve to anything in that
//! sandbox. Embedding the bytes makes the fixture part of the binary itself,
//! which the run action already has; we just need to spill it to a real file
//! on disk once, since `load_grammar` dlopens a path.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static GRAMMAR_BYTES: &[u8] = include_bytes!("../../testdata/tree-sitter-json/tree-sitter-json.so");

/// Write the embedded fixture grammar to a scratch file (once per test
/// binary run) and return its path.
///
/// Kept named `tree-sitter-json.so` (in a per-process scratch directory, to
/// avoid collisions between concurrently running test binaries) so
/// `load_grammar`'s symbol-name inference from the file name still applies —
/// tests exercising that inference (as opposed to an explicit symbol name)
/// depend on it.
pub fn json_grammar_library() -> &'static Path {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!(
            "imp-treesitter-test-fixture-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create scratch dir for embedded fixture grammar");
        let path = dir.join("tree-sitter-json.so");
        std::fs::write(&path, GRAMMAR_BYTES).expect("write embedded fixture grammar to disk");
        path
    })
}
