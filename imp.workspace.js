// Workspace root marker. Import plugin modules here to register their rules
// before any BUILD.js is evaluated.
import "//rules/c/cmake";
import { gccToolchain } from "//rules/c/gcc/toolchain";
import "//rules/gen";
import { odinToolchain } from "//rules/odin";
import { odinfmtToolchain } from "//rules/odin/odinfmt/toolchain";
import { rustToolchain } from "//rules/rust";
import "//rules/workflows/build_workflow";
import "//rules/workflows/fmt";
import "//rules/workflows/lint";
import "//rules/workflows/lockfiles";
import "//rules/workflows/package";
import "//rules/workflows/run";
import "//rules/workflows/test";
import "//rules/workflows/vs";
import "//rules/imp/test";

export const odin = odinToolchain("dev-2026-03", { default: true });
export const odinfmt = odinfmtToolchain();
export const rust = rustToolchain("1.93.0", { default: true });
// Rust binaries link via cargo/rustc, which shell out to a C linker; see
// rules/rust/index.js's rustLinkerTools for why this reuses Odin's gcc setup.
export const gcc = gccToolchain("2025.08-1", { default: true });
