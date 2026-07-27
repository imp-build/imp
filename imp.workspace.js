// Workspace root marker. Import plugin modules here to register their rules
// before any BUILD.js is evaluated.

export const cache = { gcMaxAgeDays: 7 };

import "//rules/c";
import "//rules/c/cmake";
import { defaultGccToolchain } from "//rules/c/gcc/toolchain";
import { defaultMoldToolchain } from "//rules/c/mold/toolchain";
import "//rules/gen";
import { defaultBiomeToolchain } from "//rules/js/biome_toolchain";
import { odinToolchain } from "//rules/odin";
import { defaultOdinfmtToolchain } from "//rules/odin/odinfmt/toolchain";
import { defaultRuffToolchain } from "//rules/python/ruff_toolchain";
import { defaultPythonToolchain } from "//rules/python";
import { rustToolchain } from "//rules/rust";
import "//rules/rust/generate_build";
import { defaultKacheToolchain } from "//rules/rust/kache/toolchain";
import "//rules/workflows/build_workflow";
import "//rules/workflows/builtin_lockfiles";
import "//rules/workflows/fmt";
import "//rules/workflows/generate";
import "//rules/workflows/generate_build";
import "//rules/workflows/lint";
import "//rules/workflows/lockfiles";
import "//rules/workflows/package";
import "//rules/workflows/run";
import "//rules/workflows/test";
import "//rules/workflows/vs";
import "//rules/imp/mode";
import "//rules/imp/test";

export const biome = defaultBiomeToolchain();
export const gcc = defaultGccToolchain();
export const mold = defaultMoldToolchain();
export const odin = odinToolchain("dev-2026-03", { default: true, linker: mold });
export const odinfmt = defaultOdinfmtToolchain();
export const ruff = defaultRuffToolchain();
export const python = defaultPythonToolchain();
// kache wraps rustc with a content-keyed compiler cache backed by a
// host-managed persistent worker (see src/worker.rs) — sidesteps cargo's own
// mtime-based incremental compilation, which imp's fresh-per-sandbox
// builds otherwise always defeat.
export const kache = defaultKacheToolchain();
export const kacheConfig = { cacheExecutables: true };
// Rust binaries link via cargo/rustc, which shell out to a C link driver;
// the default is gcc, while mold and kache remain explicit opt-ins.
export const rust = rustToolchain("1.93.0", { default: true, linker: mold, kache });

// This repo dogfoods generate-build for all three rules groups; a fresh
// workspace defaults to none (see each package's own `buildGenerate` config
// field, off by default).
export const rustConfig = { buildGenerate: true, doctest: false };
export const cConfig = { buildGenerate: true };
export const odinConfig = { buildGenerate: true };

// GitHub-hosted standard runners give us 4 cores; sandboxed task execution
// benefits from that concurrency. jsWorkers is left at 1 (the default) since
// it only throttles JS continuation dispatch, not real work — benchmarking
// showed no measurable effect on this workspace's build times.
export const imp = { jobs: 4, jsWorkers: 1 };
