import {
	BUILD,
	file,
	loadGrammar,
	output,
	parseSource,
	task,
	treeSexp,
	tsQuery,
} from "imp:core";

/**
 * Load a grammar, parse source text, and (optionally) run a tree-sitter
 * query against the result, as one coarse graph task.
 *
 * `loadGrammar`/`parseSource`/`treeSexp`/`tsQuery` are native, in-process
 * calls (`dlopen`, no subprocess boundary, no engine read tracking of their
 * own) — they run as ordinary calls inside this task's `run()` rather than
 * as separate graph nodes. The compiled grammar is still declared as a
 * `file()` input so cache invalidation reacts to it.
 *
 * @category graph
 * @param {object} opts
 * @param {string} opts.grammarPath Workspace-relative path to a compiled
 *   tree-sitter grammar shared library.
 * @param {string} [opts.symbolName] The grammar's C symbol, e.g.
 *   "tree_sitter_json". Inferred from `grammarPath`'s file name when omitted.
 * @param {string} opts.source Source text to parse.
 * @param {string} [opts.query] Tree-sitter query source to run against the
 *   parsed tree. Omit to skip querying.
 * @returns {{sexp: object, matches: object, [BUILD]: object}} Graph value
 *   handles for the tree's s-expression dump and query captures, and the
 *   build root.
 */
export function parseTree({ grammarPath, symbolName, source, query, display }) {
	const grammar = file(grammarPath);
	const parse = task({
		display: display ?? `tree-sitter parse ${grammarPath}`,
		inputs: { grammar, symbolName: symbolName ?? null, source, query: query ?? null },
		outputs: { sexp: output.value(), matches: output.value() },
		run(exec, input) {
			const handle = loadGrammar(exec.path(input.grammar), input.symbolName);
			const tree = parseSource(handle, input.source);
			return {
				sexp: treeSexp(tree),
				matches: input.query ? tsQuery(handle, tree, input.query) : [],
			};
		},
	});
	return Object.freeze({
		sexp: parse.outputs.sexp,
		matches: parse.outputs.matches,
		[BUILD]: parse.outputs.sexp,
	});
}
