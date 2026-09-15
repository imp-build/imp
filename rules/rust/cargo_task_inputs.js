import { builtinFiles, files } from "imp:core";
import { assertGeneratedSrcPath } from "//rules/imp/codegen";

// Keep package-owned inputs grouped by the workflows that consume them. A new
// per-package input can be assigned here once instead of being threaded
// through every Cargo task builder.
const INPUT_ROLES = {
	compile: ["dep", "generated"],
	runtime: ["dep", "testDep", "generated"],
	tools: ["tool"],
};

function namedInputs(prefix, values) {
	return Object.fromEntries(
		values.map((value, index) => [`${prefix}${index}`, value]),
	);
}

export function cargoManifestSources(root) {
	return files({
		root,
		include: ["**/Cargo.toml", "Cargo.lock", "**/*.rs"],
		exclude: ["target/**"],
	});
}

export function builtinCargoManifestSources(root) {
	return builtinFiles({
		root,
		include: ["Cargo.toml", "Cargo.lock", "**/*.rs"],
		exclude: ["target/**"],
	});
}

export function cargoTaskInputs({
	deps = [],
	testDeps = [],
	testTools = [],
	generatedSrcs = [],
} = {}) {
	const groups = {
		dep: deps,
		testDep: testDeps,
		tool: testTools,
		generated: generatedSrcs.map(({ artifact }) => artifact),
	};
	return {
		generatedSrcs,
		bindings(role) {
			return Object.fromEntries(
				INPUT_ROLES[role].flatMap((prefix) =>
					Object.entries(namedInputs(prefix, groups[prefix])),
				),
			);
		},
		resolved(input, role) {
			return INPUT_ROLES[role].flatMap((prefix) =>
				groups[prefix].map((_, index) => input[`${prefix}${index}`]),
			);
		},
		validateGeneratedSrcs(exec, input, rule = "cargoPackage") {
			for (const [index, generated] of generatedSrcs.entries()) {
				assertGeneratedSrcPath(
					rule,
					index,
					exec.path(input[`generated${index}`]),
					generated.expectedPath,
				);
			}
		},
	};
}
