import {
	run,
	output,
	file_set,
	digestOf,
	diffDigests,
	writeWorkspace,
} from "imp:core";

/**
 * Run a generator and report which of its declared output paths changed,
 * optionally writing the result into the real workspace.
 *
 * This is the codegen analog of the in-place-formatting pattern in
 * //rules/odin/odinfmt (`runOdinFmt`): that helper diffs a file's digest
 * before/after a sandboxed `run()` because its output paths equal its input
 * paths (the same file, reformatted). Codegen output paths differ from input
 * paths (generator sources/tool in, e.g. `kernels_gen.h` out), and may not
 * exist on disk yet on a first run, so the "before" digest is captured
 * directly from `outputPaths` via `file_set.literal()` instead.
 *
 * `run()` itself is always called with `materialize: false` — the generator
 * only ever runs sandboxed, producing a CAS-only `outputDigest`. Writing to
 * the workspace, when requested, goes through `writeWorkspace()` per output
 * path instead of `run()`'s own `materialize: true` path: `writeWorkspace`
 * publishes exactly the file at that path, leaving any hand-written siblings
 * in the same directory untouched, whereas `run({materialize:true})` prints
 * its own "prefer materialize:false" warning and is meant for the dist/
 * package pattern, not for scattered per-file codegen outputs.
 *
 * Call this once with `materialize: true` for a target's `generate` product
 * (writes into the workspace) and once with `materialize: false` for its
 * `generate-check` product (CAS-only, safe for CI drift checks):
 *
 * ```js
 * export const generate = product(SomeKind, GENERATE, MY_TOOL, async (handle) => {
 *     const built = await buildGenerator(handle);
 *     const { changed } = await generatedFiles({
 *         display: `generate ${handle.label.address}`,
 *         argv: [built.path, ...args],
 *         tools: [built],
 *         inputs: [...],
 *         outputPaths: ["src/kernels/kernels_gen.h", "src/kernels/kernels_gen.rs"],
 *         materialize: true,
 *     });
 *     return { generated: changed.length };
 * });
 *
 * export const generateCheck = product(SomeKind, GENERATE_CHECK, MY_TOOL, async (handle) => {
 *     const built = await buildGenerator(handle);
 *     const { changed } = await generatedFiles({
 *         display: `generate --check ${handle.label.address}`,
 *         argv: [built.path, ...args],
 *         tools: [built],
 *         inputs: [...],
 *         outputPaths: ["src/kernels/kernels_gen.h", "src/kernels/kernels_gen.rs"],
 *         materialize: false,
 *     });
 *     return { checked: 2, stale: changed };
 * });
 * ```
 *
 * @param {object} opts
 * @param {string} [opts.display] Human-readable action label.
 * @param {string[]} opts.argv Generator command line.
 * @param {object[]} [opts.tools] Tools required by argv[0] (see run()).
 * @param {object[]} [opts.inputs] Inputs the generator reads (see run()).
 * @param {string[]} opts.outputPaths Workspace-relative paths the generator writes.
 * @param {boolean} opts.materialize `true` writes outputPaths into the workspace;
 *   `false` keeps the result CAS-only for a check/CI mode.
 * @returns {Promise<{changed: string[], result: object}>} `changed` is the
 *   subset of outputPaths whose content differs from what's currently on disk
 *   (missing paths count as changed).
 */
export async function generatedFiles({
	display,
	argv,
	tools,
	inputs,
	outputPaths,
	materialize,
}) {
	if (!Array.isArray(outputPaths) || outputPaths.length === 0) {
		throw new Error("generatedFiles() requires a non-empty outputPaths array");
	}
	if (materialize !== true && materialize !== false) {
		throw new Error("generatedFiles() requires materialize: true or false");
	}

	const before = digestOf(file_set.literal(outputPaths));
	const result = await run({
		argv,
		tools,
		inputs,
		outputs: outputPaths.map((p) => output(p)),
		materialize: false,
		display,
	});
	const changes = diffDigests(before, result.outputDigest);

	// diffDigests stops descending once a whole subtree is uniformly added or
	// removed (e.g. the destination directory didn't exist at all before a
	// first run), reporting that shallow ancestor rather than each leaf file
	// under it. Since outputPaths are already the exact leaves we care about,
	// treat a path as changed if any diff entry is that path itself or an
	// ancestor of it.
	const changed = outputPaths.filter((p) =>
		changes.some((c) => c.path === p || p.startsWith(`${c.path}/`)),
	);

	if (materialize) {
		for (const p of outputPaths) {
			writeWorkspace(p, result.outputDigest, { from: p });
		}
	}

	return { changed, result };
}
