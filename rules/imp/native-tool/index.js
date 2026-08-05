// Canonical public entrypoint for serializable host-PATH tool providers.
import {
	env,
	memo,
	nativeToolArtifact,
	productFor,
	productName,
} from "imp:core";

const NATIVE_TOOL_SPEC = "native-tool";

/**
 * Declare an executable resolved lazily from the host PATH.
 *
 * The returned value is a graph tool handle. During the incremental ruleset
 * migration, nativeToolSpec() can also resolve the same handle into the
 * descriptor expected by legacy run() consumers.
 *
 * @category configuration
 * @param {string} name Executable name to look up on PATH, e.g. "cmake".
 * @returns {object} Serializable native-tool specification.
 */
export function nativeTool(name) {
	if (typeof name !== "string" || name.length === 0) {
		throw new Error("nativeTool(name) requires a non-empty executable name");
	}
	return globalThis.__imp_graph_native_tool(name);
}

function isNativeToolSpec(value) {
	return (
		value !== null &&
		typeof value === "object" &&
		value.__imp_native_tool === NATIVE_TOOL_SPEC &&
		typeof value.name === "string"
	);
}

// PATH participates in the memo key even though nativeToolArtifact() performs
// the actual lookup. A different host resolution environment must not reuse a
// persisted descriptor created for an earlier PATH.
const resolveNativeTool = memo(
	async function resolveNativeTool(name, _path) {
		const path = await nativeToolArtifact(name);
		return {
			name,
			cache: "native-tools",
			key: name,
			path,
			binDirs: ["."],
		};
	},
	{ display: "tool {0}", level: "info" },
);

/** Resolve a nativeTool() specification into a run({ tools }) descriptor. */
export function nativeToolSpec(spec) {
	if (!isNativeToolSpec(spec)) {
		throw new Error("nativeToolSpec(spec) expects a nativeTool() specification");
	}
	return resolveNativeTool(spec.name, env("PATH"));
}

// Retained for target-based providers that have not migrated away from the
// generic product role. Native tools themselves no longer register a product.
export const TOOL = productName("tool");

/**
 * Resolve either a serializable nativeTool() specification or a legacy target
 * provider implementing the generic TOOL product.
 */
export function toolSpec(provider) {
	if (isNativeToolSpec(provider)) return nativeToolSpec(provider);
	return productFor(provider, TOOL);
}
