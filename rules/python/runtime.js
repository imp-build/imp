let defaultVersion = null;

/**
 * Register the version of Python that `uv run --managed-python` should
 * launch when pythonApp() isn't given an explicit pythonVersion. Last call
 * wins, mirroring uvToolchain()/pexToolchain()'s { default: true } intent,
 * but there is no non-default variant to register — nothing else ever looks
 * up a python version by name, so this is a single overwritable default.
 *
 * @param {string} version
 */
export function pythonRuntime(version) {
	if (typeof version !== "string" || version === "")
		throw new Error(
			"pythonRuntime(version) requires a non-empty version string",
		);
	defaultVersion = version;
}

/** @returns {string|null} */
export function defaultPythonRuntimeVersion() {
	return defaultVersion;
}

// Importing this rule provisions the pinned default. A workspace can replace
// it by calling pythonRuntime(...) again.
pythonRuntime("3.13.0");
