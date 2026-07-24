import { describe, expect, test } from "//rules/imp/test";
import { loadGrammar, parseSource, treeSexp, tsQuery } from "imp:core";

// Prebuilt fixture, not compiled by this test — see
// testdata/tree-sitter-json/README.md for why (this test's own sandboxed
// action has no C toolchain available, unlike the earlier build step).
const GRAMMAR_PATH = "rules/treesitter/testdata/tree-sitter-json/tree-sitter-json.so";

describe("tree-sitter JS API", () => {
	test("loadGrammar + parseSource + treeSexp round trip", async () => {
		const grammar = loadGrammar(GRAMMAR_PATH, "tree_sitter_json");
		const tree = parseSource(grammar, JSON.stringify({ a: [1, 2, true] }));
		const sexp = treeSexp(tree);
		expect(sexp).toContain("document");
		expect(sexp).toContain("object");
		expect(sexp).toContain("array");
	});

	test("loadGrammar reuses the handle for the same path", async () => {
		const a = loadGrammar(GRAMMAR_PATH, "tree_sitter_json");
		const b = loadGrammar(GRAMMAR_PATH, "tree_sitter_json");
		expect(a).toBe(b);
	});

	test("tsQuery captures matching nodes", async () => {
		const grammar = loadGrammar(GRAMMAR_PATH, "tree_sitter_json");
		const tree = parseSource(
			grammar,
			JSON.stringify({ name: "imp", ok: true }),
		);
		const matches = tsQuery(grammar, tree, "(string (string_content) @key)");
		const texts = matches.flatMap((m) => m.captures.map((c) => c.text));
		expect(texts).toContain("name");
		expect(texts).toContain("imp");
		expect(texts).toContain("ok");
	});
});
