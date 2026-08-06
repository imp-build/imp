import { BUILD, files, packagePath, registerBuildRule } from "imp:core";

// Kept until generated legacy BUILD files have migrated (#39).
registerBuildRule({ rule: "jsSources", importFrom: "//rules/js" });

const JS_SOURCE_INCLUDES = [
	"package.json",
	"*.js",
	"*.jsx",
	"*.ts",
	"*.tsx",
	"*.json",
];

const sourceHooks = [];

/** Register an internal facet hook enabled by importing a JS rules extension. */
export function registerJsSourcesHook(hook) {
	if (typeof hook !== "function")
		throw new Error("registerJsSourcesHook(hook) expects a function");
	if (!sourceHooks.includes(hook)) sourceHooks.push(hook);
}

function workspacePath(base, src) {
	if (typeof src !== "string")
		throw new Error("jsSources({ src }) expects a string");
	const parts = [...base.split("/"), ...src.split("/")].filter(
		(part) => part && part !== ".",
	);
	if (parts.includes(".."))
		throw new Error(`js paths must stay within the workspace: ${src}`);
	return parts.join("/") || ".";
}

/**
 * Declare JavaScript/TypeScript sources and their exported graph roots.
 * Importing an extension such as //rules/js/biome adds its facets at
 * construction time, without mutating this object after the fact.
 */
export function jsSources({ src = ".", base = packagePath() } = {}) {
	const root = workspacePath(base, src);
	const sources = files({ root, include: JS_SOURCE_INCLUDES });
	const value = { sources, root, [BUILD]: sources };
	for (const hook of sourceHooks)
		Object.assign(value, hook(Object.freeze({ ...value })));
	return Object.freeze(value);
}
