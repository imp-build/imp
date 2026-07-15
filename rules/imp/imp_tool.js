// The "imp" tool token: for products implemented by imp's own machinery
// (native-tool resolution, the rules-test runner, VS solution generation)
// rather than by an acquired toolchain.
import { toolName } from "imp:core";

export const IMP_TOOL = toolName("imp");
