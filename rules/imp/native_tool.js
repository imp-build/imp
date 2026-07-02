import { target, product, nativeToolArtifact } from "imp:core";

/**
 * Declare a native-tool target: resolves `name` from the host PATH and
 * exposes it to run({ tools: [...] }) via a symlink, not a copy. Declare
 * once at BUILD.js top level (target addresses are only assigned at
 * workspace-load time); call nativeToolSpec(handle) from a product body to
 * get the resolved descriptor.
 *
 * @param {string} name Executable name to look up on PATH, e.g. "cmake".
 * @returns {object} Target handle.
 */
export function nativeTool(name) {
    return target({ kind: "native-tool", attrs: { name } });
}

/**
 * Resolve a nativeTool() handle into a run({ tools: [...] }) descriptor.
 * Memoized via product() — repeated resolution within one evaluation is free
 * and the PATH lookup + symlink materialization runs once.
 */
export const nativeToolSpec = product(
    "native-tool",
    "tool",
    async function nativeToolSpec(handle) {
        const path = await nativeToolArtifact(handle.attrs.name);
        return {
            name: handle.attrs.name,
            cache: "native-tools",
            key: handle.attrs.name,
            path,
            binDirs: ["."],
        };
    },
);
