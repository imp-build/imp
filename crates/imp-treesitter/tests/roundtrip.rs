//! End-to-end test of the dlopen -> parse -> query round trip, using a real
//! grammar (JSON) compiled from vendored tree-sitter source at test time.

mod common;

use imp_treesitter::GrammarRegistry;

#[test]
fn load_parse_and_dump_sexp() {
    let registry = GrammarRegistry::new();
    let grammar = registry
        .load_grammar(common::json_grammar_library(), None)
        .expect("load json grammar");

    let tree = registry
        .parse(grammar, r#"{"a": [1, 2, true]}"#.to_string())
        .expect("parse json source");

    let sexp = registry.tree_sexp(tree).expect("dump s-expression");
    assert!(sexp.contains("document"), "unexpected s-expression: {sexp}");
    assert!(sexp.contains("object"), "unexpected s-expression: {sexp}");
    assert!(sexp.contains("array"), "unexpected s-expression: {sexp}");
}

#[test]
fn load_grammar_is_idempotent_by_path() {
    let registry = GrammarRegistry::new();
    let path = common::json_grammar_library();
    let a = registry.load_grammar(path, None).expect("load grammar");
    let b = registry
        .load_grammar(path, None)
        .expect("load grammar again");
    assert_eq!(a, b, "loading the same path twice should reuse the handle");
}

#[test]
fn query_captures_matching_nodes() {
    let registry = GrammarRegistry::new();
    let grammar = registry
        .load_grammar(common::json_grammar_library(), None)
        .expect("load json grammar");
    let tree = registry
        .parse(grammar, r#"{"name": "imp", "ok": true}"#.to_string())
        .expect("parse json source");

    let matches = registry
        .run_query(grammar, tree, "(string (string_content) @key)")
        .expect("run query");

    let texts: Vec<&str> = matches
        .iter()
        .flat_map(|m| m.captures.iter().map(|c| c.text.as_str()))
        .collect();
    assert!(texts.contains(&"name"), "captures were: {texts:?}");
    assert!(texts.contains(&"imp"), "captures were: {texts:?}");
    assert!(texts.contains(&"ok"), "captures were: {texts:?}");
}

#[test]
fn explicit_symbol_name_is_honored() {
    let registry = GrammarRegistry::new();
    let grammar = registry
        .load_grammar(common::json_grammar_library(), Some("tree_sitter_json"))
        .expect("load json grammar with explicit symbol");
    let tree = registry
        .parse(grammar, "null".to_string())
        .expect("parse json source");
    let sexp = registry.tree_sexp(tree).expect("dump s-expression");
    assert!(sexp.contains("null"), "unexpected s-expression: {sexp}");
}

// Regression test for the actual constraint the whole common::mod.rs rewrite
// exists to satisfy: imp's own Rust-test execution runs a compiled test
// binary as an isolated action whose only declared input is that binary's
// own build output — never the source tree. A path built from
// CARGO_MANIFEST_DIR at runtime (the previous, broken approach) resolves
// just fine in any normal dev shell, since the source checkout is right
// there on disk — it only fails once the specific build sandbox directory
// it was compiled under is gone, which is exactly the CI failure mode this
// replaced. That means the meaningful assertion has to be about where the
// fixture path *points*, not just "does it work here" — the checkout never
// disappears in a local run, so a test that only re-executes the binary
// locally passes on both the fixed and the broken version.
#[test]
fn grammar_path_is_not_inside_the_source_tree() {
    let path = common::json_grammar_library();
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    assert!(
        !path.starts_with(manifest_dir),
        "grammar path {path:?} lives under CARGO_MANIFEST_DIR ({manifest_dir}) — \
         it must come from the embedded bytes, written to a scratch location, \
         not read from the source tree at runtime (see common/mod.rs's docs)"
    );
}

// Complementary check: the compiled binary should need nothing beyond
// itself at run time — no ambient PATH, no cwd inside the checkout. This
// doesn't by itself prove the CARGO_MANIFEST_DIR bug is fixed (see above),
// but it is a real property worth guarding and would catch, e.g., a
// regression that shells out to a PATH-resolved tool at test time.
#[test]
fn compiled_binary_runs_without_path_or_source_tree_cwd() {
    let exe = std::env::current_exe().expect("resolve path to this test binary");
    let scratch = std::env::temp_dir().join(format!(
        "imp-treesitter-relocated-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&scratch).expect("create scratch dir");
    let relocated = scratch.join("roundtrip-relocated");
    std::fs::copy(&exe, &relocated).expect("copy test binary into scratch dir");

    // Filter to a single real test (by name substring) rather than
    // re-running the whole binary, which would re-enter this very test and
    // recurse forever.
    let output = std::process::Command::new(&relocated)
        .arg("--test-threads=1")
        .arg("load_parse_and_dump_sexp")
        .env_clear()
        .current_dir(&scratch)
        .output()
        .expect("spawn relocated test binary");

    let _ = std::fs::remove_dir_all(&scratch);

    assert!(
        output.status.success(),
        "relocated test binary failed outside the source tree with an empty \
         environment:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("1 passed"),
        "expected the relocated binary to actually run and pass the filtered \
         test, not silently match nothing:\nstdout: {}",
        String::from_utf8_lossy(&output.stdout),
    );
}
