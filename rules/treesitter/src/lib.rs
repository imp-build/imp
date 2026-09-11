//! In-process tree-sitter grammar loading and parsing.
//!
//! Grammar shared libraries (`.so`/`.dylib`/`.dll`, as produced by the
//! Tree-sitter CLI) are dlopen'd directly into this process — see
//! [`ffi`] for the trust tradeoff this implies. Everything above the `ffi`
//! module is ordinary, safe tree-sitter usage.

mod ffi;
mod registry;

pub use registry::{Capture, GrammarRegistry, Match, Position};
