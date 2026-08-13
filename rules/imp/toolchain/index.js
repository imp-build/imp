// Canonical public entrypoint for reading an installed toolchain back off
// disk. Toolchains declare their acquisition as an ordinary graph task
// (downloadToolArtifact + extractArchive from //rules/imp/lockfile and
// //rules/imp/archive, or a bespoke task() where the install needs more than
// an unpack), and publish the installed tree with output.directory()'s
// namedCache option. These helpers execute that task and hand back the real,
// absolute path the named cache holds it at.
//
// A sandboxed consumer never needs this: it declares the tool handle as a
// task input, and exec.tool() gives it a path inside the sandbox. This is for
// the callers that live outside any sandbox — `imp @tool`, which executes the
// binary directly through the user's shell, and the linker flags that must
// name an absolute path (see moldRustLinkerEnv() in //rules/c/mold).
import { cacheGet, resolveGraphHandle } from "imp:core";

// Callers pass a handle their module built when the toolchain was declared,
// never one built here: task() refuses to add graph nodes during execution
// (imp:core's graph_core.js), and these helpers are reachable from inside a
// task body — rules/rust resolves kache's RUSTC_WRAPPER while a crate build
// is already running.
async function installedCacheDir(handle, name, key, api) {
	await resolveGraphHandle(handle);
	const dir = cacheGet(name, key);
	if (!dir) {
		throw new Error(
			`${api}: named cache '${name}/${key}' is empty after its install task ran; ` +
				`the task must declare output.directory(dest, { namedCache: { name, key } })`,
		);
	}
	return dir;
}

/**
 * Install a toolchain if necessary and return the absolute host directory
 * its named cache holds.
 *
 * @param {object} handle Graph handle for the toolchain's install task.
 * @param {object} cache
 * @param {string} cache.name Named-cache name.
 * @param {string} cache.key Named-cache key.
 * @returns {Promise<string>} Absolute path to the installed toolchain root.
 */
export async function toolchainDir(handle, { name, key }) {
	return installedCacheDir(handle, name, key, "toolchainDir");
}

/**
 * The absolute host path of one executable in an installed toolchain.
 *
 * `subDir` is the directory holding the executable, relative to the cache
 * root — the same value the toolchain's tool() handle declares as its first
 * binDirs entry. Use "." for an archive that puts its binaries at the root.
 *
 * @param {object} handle Graph handle for the toolchain's install task.
 * @param {object} opts
 * @param {string} opts.name Named-cache name.
 * @param {string} opts.key Named-cache key.
 * @param {string} [opts.subDir="."] Directory holding the executable.
 * @param {string} opts.exe Executable filename, with any platform suffix.
 * @returns {Promise<string>} Absolute path to the executable.
 */
export async function toolchainBin(handle, { name, key, subDir = ".", exe }) {
	if (typeof exe !== "string" || exe.length === 0) {
		throw new Error("toolchainBin(handle, { exe }) requires an executable name");
	}
	const dir = await installedCacheDir(handle, name, key, "toolchainBin");
	return subDir === "." || subDir === "" ? `${dir}/${exe}` : `${dir}/${subDir}/${exe}`;
}

/**
 * Install a toolchain if necessary and return a run({ tools }) descriptor
 * bound to its named cache.
 *
 * For the remaining consumers that are legacy run() calls rather than graph
 * tasks: the generate-build golden path, and the dynamically resolved
 * toolchain roles (Rust's RUSTC_WRAPPER, Odin's linker).
 *
 * @param {object} handle Graph handle for the toolchain's install task.
 * @param {object} opts
 * @param {string} opts.toolName Tool name run() puts on PATH.
 * @param {string} opts.name Named-cache name.
 * @param {string} opts.key Named-cache key.
 * @param {string[]} opts.binDirs Directories holding executables, relative
 *   to the cache root.
 * @returns {Promise<object>} A run({ tools }) entry.
 */
export async function toolchainToolSpec(handle, { toolName, name, key, binDirs }) {
	await installedCacheDir(handle, name, key, "toolchainToolSpec");
	return {
		kind: "tool",
		name: toolName,
		cache: name,
		key,
		binDirs,
	};
}
