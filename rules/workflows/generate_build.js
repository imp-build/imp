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
// eligible. Selector-less invocations still need *something* selectable for
// the goal machinery, so this module declares one dummy, always-present
// target type/kind ("build-generate") for that purpose; its own product is a
// no-op and its selection is ignored by generateBuildGoal.
//
// Runs through the same goal machinery as fmt/build/test/generate
// (//rules/workflows/fmt.js, //rules/workflows/generate.js) rather than a
// bespoke CLI command, so it gets a scheduler + exec_root for free — needed
// because generator products (e.g. cargo metadata) call run().
import { applyBuildEdits, configuration, goal, goalFlags, logInfo, product, productFor, Target } from "imp:core";

class BuildGenerateRoot extends Target {
    static kind = "build-generate";
    constructor(opts = {}) {
        super({ kind: BuildGenerateRoot.kind, attrs: {} });
    }
}

/**
 * Declare the dummy `generate-build` selection root. Exactly one instance
 * should exist in the workspace (see imp.workspace.js) so selector-less
 * `imp goal generate-build` invocations have a target to select — the
 * actual fan-out to per-language generators happens via
 * registerBuildGenerator(), independent of this target.
 *
 * @returns {object} Target handle.
 */
export function buildGenerateRoot(opts = {}) {
    return new BuildGenerateRoot(opts);
}

export const GENERATE_BUILD = goal(
    "generate-build",
    generateBuildGoal,
    {
        flags: {
            check: { description: "Verify generated BUILD files are up to date without writing changes" },
        },
    },
);

product(BuildGenerateRoot, GENERATE_BUILD, async () => ({}));

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
 * @param {Function} opts.kind Target subclass the "generate-build" product is registered under.
 * @returns {void}
 */
export function registerBuildGenerator({ namespace, kind }) {
    const kindName = typeof kind === "function" ? kind.kind : kind;
    _registeredGenerators.push({ namespace, kind: kindName });
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
    for (const { namespace, kind } of _registeredGenerators) {
        const config = configuration(namespace, {}) || {};
        if (!config.buildGenerate) continue;
        let result;
        try {
            result = await productFor({ __imp: true, kind, attrs: {} }, GENERATE_BUILD);
        } catch (e) {
            throw new Error(`${kind}#generate-build: ${e && e.message ? e.message : e}`);
        }
        mergeEdits(edits, result);
    }

    const { changed, checked } = applyBuildEdits({ edits, check });

    if (check) {
        logInfo(`generate-build: ${checked.length} file(s) checked, ${changed.length} out of date`);
        if (changed.length > 0) {
            throw new Error(`generated BUILD files are out of date: ${changed.join(", ")}`);
        }
    } else if (changed.length > 0) {
        logInfo(`generate-build: ${changed.length} file(s) written\n${changed.map((f) => `  ${f}`).join("\n")}`);
    }
}
