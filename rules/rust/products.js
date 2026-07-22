// Product-name tokens for roles the Rust rules consume from other rule
// groups. A leaf module so providers (//rules/c/gcc, //rules/c/mold,
// //rules/rust/kache) and //rules/rust can share tokens without cycles.
import { productName } from "imp:core";

/** Role: resolve a linker toolchain target to the linker cargo builds use. */
export const RUST_LINKER = productName("rust-linker");

/** Role: resolve a toolchain target to the link-driver (compiler used as
 * `cc` by rustc) cargo builds invoke for linking. */
export const RUST_LINK_DRIVER = productName("rust-link-driver");

/** Role: resolve a build-cache toolchain target (kache) to the
 * RUSTC_WRAPPER configuration cargo builds use. */
export const RUST_BUILD_CACHE = productName("rust-build-cache");
