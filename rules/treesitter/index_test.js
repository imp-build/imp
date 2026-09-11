import { BUILD } from "//rules/workflows/build";
import { describe, expect, test } from "//rules/imp/test";
import {
	odinAnalyzer,
	odinGrammarFixture,
	jsonGrammarFixture,
	impTreesitter,
} from "//rules/treesitter";

describe("builtin Tree-sitter package", () => {
	test("exposes graph-backed Odin analyzer inputs", () => {
		expect(odinGrammarFixture.archive.__imp_graph_handle).toBe(true);
		expect(odinAnalyzer[BUILD]["imp-treesitter-parse"]
			.__imp_graph_handle).toBe(true);
	});

	test("keeps the round-trip binary and JSON grammar graph-backed", () => {
		expect(impTreesitter[BUILD]["treesitter-roundtrip"]
			.__imp_graph_handle).toBe(true);
		expect(jsonGrammarFixture.archive.__imp_graph_handle).toBe(true);
	});
});
