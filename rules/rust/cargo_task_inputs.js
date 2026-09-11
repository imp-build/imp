import { files } from "imp:core";

// Keep package-owned inputs grouped by the workflows that consume them. A new
// per-package input can be assigned here once instead of being threaded
// through every Cargo task builder.
const INPUT_ROLES = {
	compile: ["dep"],
	runtime: ["dep", "testDep"],
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

export function cargoTaskInputs({
	deps = [],
	testDeps = [],
	testTools = [],
} = {}) {
	const groups = { dep: deps, testDep: testDeps, tool: testTools };
	return {
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
	};
}
