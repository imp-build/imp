// Canonical public entrypoint for the "imp" tool token used by products
// implemented by imp's own machinery rather than an acquired toolchain.
import { toolName } from "imp:core";

/** Graph tool handle for the running imp executable. */
export const impTool = globalThis.__imp_graph_self_tool();

// Transitional product token for rulesets that have not migrated yet.
export const IMP_TOOL = toolName("imp");
