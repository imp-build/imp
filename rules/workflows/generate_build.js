// The `generate-build` goal: dispatches to every registered generate-build
// generator (see e.g. //rules/rust/generate_build.js) whose owning rules
// group has opted in via its own `buildGenerate` config flag, merges the
// `{ file: [{name, rule, props}, ...] }` edits every generator returns — one
// generator call may touch a BUILD.js another generator also wants to add
// targets to — then renders/writes them in one pass via applyBuildEdits()
// (imp:core), the JS entry point for the render_raw_build_file pipeline
// that preserves hand-written exports and merges imports.
//
// A generator only needs a real Target/product pair for other goals to
// select it individually; generate-build itself is driven purely off the
// registerBuildGenerator() list below rather than target selection, so a
// rules group need not declare a dedicated per-language target just to be
// eligible. The goal is declared `selection: "none"`, so selector-less
// invocations run without selecting anything.
//
// Runs through the same goal machinery as fmt/build/test/generate
// (//rules/workflows/fmt.js, //rules/workflows/generate.js) rather than a
// bespoke CLI command, so it gets a scheduler + exec_root for free — needed
// because generator products (e.g. cargo metadata) call run().
import {
	applyBuildEdits,
	configuration,
	goal,
	goalFlags,
	logInfo,
	productFor,
} from "imp:core";

export const GENERATE_BUILD = goal("generate-build", generateBuildGoal, {
	flags: {
		check: {
			description:
				"Verify generated BUILD files are up to date without writing changes",
		},
	},
	selection: "none",
});

const _registeredGenerators = [];

/**
 * Register a rules group's `generate-build` product for config-gated
 * dispatch. `namespace` is the rules group's configuration namespace (e.g.
 * "odin") — its `buildGenerate` bool config field decides whether `kind`'s
 * "generate-build" product runs on `imp goal generate-build`. Defaults to
 * off; a rules group opts in via `defineConfigSchema(namespace, {
 * buildGenerate: field.bool({ default: false }) })` plus a workspace config
 * export setting it to true.
 *
 * @param {object} opts
 * @param {string} opts.namespace Configuration namespace whose `buildGenerate` field gates this generator.
 * @param {Function|string} [opts.kind] Target kind whose legacy
 *   "generate-build" product should run.
 * @param {Function} [opts.generate] Direct async generator callback. New
 *   label-based rules should prefer this form.
 * @returns {void}
 */
export function registerBuildGenerator({ namespace, kind, generate }) {
	if (typeof namespace !== "string" || namespace === "") {
		throw new Error("registerBuildGenerator() requires a namespace");
	}
	if (generate !== undefined && typeof generate !== "function") {
		throw new Error("registerBuildGenerator() generate must be a function");
	}
	if (generate === undefined && kind === undefined) {
		throw new Error(
			"registerBuildGenerator() requires either generate or kind",
		);
	}
	const kindName =
		kind === undefined ? undefined : typeof kind === "function" ? kind.kind : kind;
	_registeredGenerators.push({ namespace, kind: kindName, generate });
}

function mergeEdits(target, edits) {
	for (const [file, targets] of Object.entries(edits || {})) {
		if (!target[file]) target[file] = [];
		target[file].push(...targets);
	}
}

export async function generateBuildGoal(selection) {
	const { check } = goalFlags();

	const edits = {};
	for (const { namespace, kind, generate } of _registeredGenerators) {
		const config = configuration(namespace, {}) || {};
		if (!config.buildGenerate) continue;
		let result;
		try {
			result = generate
				? await generate()
				: await productFor(
						{ __imp: true, kind, attrs: {} },
						GENERATE_BUILD,
					);
		} catch (e) {
			throw new Error(
				`${kind || namespace}#generate-build: ${e && e.message ? e.message : e}`,
			);
		}
		mergeEdits(edits, result);
	}

	const { changed, checked } = applyBuildEdits({ edits, check });

	if (check) {
		logInfo(
			`generate-build: ${checked.length} file(s) checked, ${changed.length} out of date`,
		);
		if (changed.length > 0) {
			throw new Error(
				`generated BUILD files are out of date: ${changed.join(", ")}`,
			);
		}
	} else if (changed.length > 0) {
		logInfo(
			`generate-build: ${changed.length} file(s) written\n${changed.map((f) => `  ${f}`).join("\n")}`,
		);
	}
}
