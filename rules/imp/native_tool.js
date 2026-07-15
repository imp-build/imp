import { Target, product, productName, nativeToolArtifact } from "imp:core";
import { IMP_TOOL } from "//rules/imp/imp_tool";

export class NativeTool extends Target {
	static kind = "native-tool";
	constructor(name) {
		super({ kind: NativeTool.kind, attrs: { name } });
	}
}

/**
 * Declare a native-tool target: resolves `name` from the host PATH and
 * exposes it to run({ tools: [...] }) via a symlink, not a copy. Declare
 * once at BUILD.js top level (target addresses are only assigned at
 * workspace-load time); call nativeToolSpec(handle) from a product body to
 * get the resolved descriptor.
 *
 * @category target
 * @param {string} name Executable name to look up on PATH, e.g. "cmake".
 * @returns {object} Target handle.
 */
export function nativeTool(name) {
	return new NativeTool(name);
}

/**
 * Resolve a nativeTool() handle into a run({ tools: [...] }) descriptor.
 * Memoized via product() — repeated resolution within one evaluation is free
 * and the PATH lookup + symlink materialization runs once.
 */
export const TOOL = productName("tool");

export const nativeToolSpec = product(
	NativeTool,
	TOOL,
	IMP_TOOL,
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
