// A Python resolve is the locked project environment used by Python targets.
// uv owns the lockfile format and resolver; imp only selects one declared
// optional-dependency flavor when it synchronizes that environment.

import { Target, defineModeAxis, modeAxis, sourcesField } from "imp:core";

// Unlike a platform axis, dependency flavors are project-defined. Keep this
// free-form so a workspace may name them cpu, cu124, rocm, internal, etc.
// Targets only read it when their resolve declares more than one flavor, so
// ordinary Python projects do not gain an unnecessary cache-key dimension.
defineModeAxis("python", {
	kind: "rebuild",
	default: "default",
});

function normalize_workspace_path(path) {
	if (typeof path !== "string" || path === "") {
		throw new Error(
			"pythonResolve({ path }) requires a workspace-relative path",
		);
	}
	const parts = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			throw new Error(
				`python resolve path must stay within the workspace: ${path}`,
			);
		}
		parts.push(part);
	}
	return parts.length === 0 ? "." : parts.join("/");
}

function normalize_flavors(flavors) {
	if (!flavors || typeof flavors !== "object" || Array.isArray(flavors)) {
		throw new Error("pythonResolve({ flavors }) must be an object");
	}
	if (!("default" in flavors)) {
		throw new Error("pythonResolve({ flavors }) must define a default flavor");
	}
	const normalized = {};
	for (const [name, config] of Object.entries(flavors)) {
		if (typeof name !== "string" || name === "") {
			throw new Error("python resolve flavor names must be non-empty strings");
		}
		if (!config || typeof config !== "object" || Array.isArray(config)) {
			throw new Error(`python resolve flavor '${name}' must be an object`);
		}
		if (
			config.extra !== undefined &&
			(typeof config.extra !== "string" || config.extra === "")
		) {
			throw new Error(
				`python resolve flavor '${name}' extra must be a non-empty string`,
			);
		}
		const keys = Object.keys(config);
		if (keys.some((key) => key !== "extra")) {
			throw new Error(
				`python resolve flavor '${name}' only supports the 'extra' setting`,
			);
		}
		normalized[name] =
			config.extra === undefined ? {} : { extra: config.extra };
	}
	return normalized;
}

export class PythonResolve extends Target {
	static kind = "python-resolve";
	constructor({ path = ".", flavors = { default: {} } } = {}) {
		const normalizedPath = normalize_workspace_path(path);
		super({
			kind: PythonResolve.kind,
			attrs: { path: normalizedPath, flavors: normalize_flavors(flavors) },
			sources: sourcesField({
				root: normalizedPath,
				include: ["pyproject.toml", "uv.lock"],
			}),
		});
	}
}

/**
 * Declare a locked uv project and its selectable optional-dependency flavors.
 *
 * The selected flavor is `default` unless the resolve declares more than one
 * flavor, in which case `--axis python=<name>` (or a named profile) selects it.
 */
export function pythonResolve({ path, flavors } = {}) {
	return new PythonResolve({ path, flavors });
}

/** Return the uv sync arguments for this resolve under the active mode. */
export function pythonResolveSyncArgs(resolve) {
	if (!resolve) return [];
	const flavors = resolve.attrs?.flavors;
	if (!flavors || typeof flavors !== "object") {
		throw new Error("python target resolve must be a pythonResolve() target");
	}
	const flavor =
		Object.keys(flavors).length === 1 ? "default" : modeAxis("python");
	const config = flavors[flavor];
	if (!config) {
		throw new Error(
			`python resolve at '${resolve.attrs.path}' does not define flavor '${flavor}' (available: ${Object.keys(flavors).join(", ")})`,
		);
	}
	return config.extra ? ["--extra", config.extra] : [];
}
