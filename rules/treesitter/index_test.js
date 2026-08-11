import { BUILD } from "//rules/workflows/build";
import { describe, expect, test } from "//rules/imp/test";
import { parseTree } from "//rules/treesitter";

const GRAMMAR_PATH = "rules/treesitter/testdata/tree-sitter-json/tree-sitter-json.so";

describe("parseTree", () => {
	test("returns a frozen graph root wired to the grammar and source", () => {
		const parsed = parseTree({
			grammarPath: GRAMMAR_PATH,
			symbolName: "tree_sitter_json",
			source: JSON.stringify({ a: [1, 2, true] }),
		});

		expect(Object.isFrozen(parsed)).toBe(true);
		expect(parsed.sexp.__imp_graph_handle).toBe(true);
		expect(parsed.matches.__imp_graph_handle).toBe(true);
		expect(parsed[BUILD]).toBe(parsed.sexp);
	});

	test("reuses the same task for matching declarations", () => {
		const opts = {
			grammarPath: GRAMMAR_PATH,
			symbolName: "tree_sitter_json",
			source: JSON.stringify({ name: "imp", ok: true }),
			query: "(string (string_content) @key)",
		};

		const first = parseTree(opts);
		const second = parseTree({ ...opts });

		expect(first.sexp).toBe(second.sexp);
		expect(first.matches).toBe(second.matches);
	});

	test("declarations with different source produce distinct tasks", () => {
		const a = parseTree({
			grammarPath: GRAMMAR_PATH,
			symbolName: "tree_sitter_json",
			source: "1",
		});
		const b = parseTree({
			grammarPath: GRAMMAR_PATH,
			symbolName: "tree_sitter_json",
			source: "2",
		});

		expect(a.sexp).not.toBe(b.sexp);
	});
});
