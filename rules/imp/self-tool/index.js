// Canonical public entrypoint for the "imp" tool token used by products
// implemented by imp's own machinery rather than an acquired toolchain.

/** Graph tool handle for the running imp executable. */
export const impTool = globalThis.__imp_graph_self_tool();
