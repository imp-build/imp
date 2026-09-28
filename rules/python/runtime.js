let defaultVersion = null;

/**
 * Set the default CPython version for pythonApp(), pythonTest(),
 * pythonSources(), and pythonWorkspace(). Each call replaces the previous
 * default; app and test targets can still set their own pythonVersion.
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

// Importing this rule sets the pinned default. A workspace can replace it by
// calling pythonRuntime(...) again.
pythonRuntime("3.13.0");
