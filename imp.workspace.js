// Workspace root marker. Import plugin modules here to register their rules
// before any BUILD.js is evaluated.
import "//rules/c";
import "//rules/c/cmake";
import { gccToolchain } from "//rules/c/gcc/toolchain";
import { moldToolchain } from "//rules/c/mold/toolchain";
import "//rules/gen";
import { odinToolchain } from "//rules/odin";
import { odinfmtToolchain } from "//rules/odin/odinfmt/toolchain";
import { ruffToolchain } from "//rules/python/ruff_toolchain";
import { rustToolchain } from "//rules/rust";
import "//rules/rust/generate_build";
import { sccacheToolchain } from "//rules/rust/sccache/toolchain";
import "//rules/workflows/build_workflow";
import "//rules/workflows/fmt";
import "//rules/workflows/generate";
import { buildGenerateRoot } from "//rules/workflows/generate_build";
import "//rules/workflows/lint";
import "//rules/workflows/lockfiles";
import "//rules/workflows/package";
import "//rules/workflows/run";
import "//rules/workflows/test";
import "//rules/workflows/vs";
import "//rules/imp/test";

export const gcc = gccToolchain("2025.08-1", { default: true });
// Not the default — purely opt-in as a faster linker for Odin/Rust; both
// fall back to gcc's bundled ld when no linker is configured.
export const mold = moldToolchain("2.41.0");
export const odin = odinToolchain("dev-2026-03", { default: true, linker: mold });
export const odinfmt = odinfmtToolchain();
export const ruff = ruffToolchain("0.15.21", { default: true });
// sccache wraps rustc with a content-keyed compiler cache backed by a
// host-managed persistent worker (see src/worker.rs) — sidesteps cargo's own
// mtime-based incremental compilation, which imp's fresh-per-sandbox
// builds otherwise always defeat.
export const sccache = sccacheToolchain("0.10.0", { default: true });
// Rust binaries link via cargo/rustc, which shell out to a C link driver;
// see rules/rust/index.js's rustLinkerTools for why this reuses gcc.
export const rust = rustToolchain("1.93.0", { default: true, linkDriver: gcc, linker: mold, sccache });

// Dummy selection root for `imp goal generate-build` (see
// //rules/workflows/generate_build.js) — a selector-less run needs one
// selectable target to exist; which languages actually get scanned is
// decided per rules group by their own `buildGenerate` config flag below.
export const buildGenerateTarget = buildGenerateRoot({});

// This repo dogfoods generate-build for all three rules groups; a fresh
// workspace defaults to none (see each package's own `buildGenerate` config
// field, off by default).
export const rustConfig = { buildGenerate: true };
export const cConfig = { buildGenerate: true };
export const odinConfig = { buildGenerate: true };
