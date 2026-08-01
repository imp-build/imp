// Canonical public entrypoint for the "imp" tool token used by products
// implemented by imp's own machinery rather than an acquired toolchain.
import { toolName } from "imp:core";

export const IMP_TOOL = toolName("imp");
