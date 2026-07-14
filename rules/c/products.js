// Product-name tokens for roles the C/C++ rules define for other rule groups
// (and for themselves). A leaf module so toolchain providers and consumers
// can import a token without importing //rules/c wholesale.
import { productName } from "imp:core";

/** Role: resolve a toolchain target to the CcToolchain adapter used by
 * cc_library/cc_binary/cc_test builds (see ccToolchainFor in //rules/c). */
export const CC_TOOLCHAIN = productName("cc-toolchain");
