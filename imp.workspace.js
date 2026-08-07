// Workspace root marker. Import plugin modules here to register their rules
// before any BUILD.js is evaluated.

export const cache = { gcMaxAgeDays: 7 };

import "//rules/c";
import "//rules/c/cmake";
import "//rules/c/generate_build";
import { defaultMoldGraphToolchain, defaultMoldToolchain } from "//rules/c/mold";
import "//rules/gen";
import { defaultBiomeToolchain } from "//rules/js/biome";
import { odinToolchain } from "//rules/odin";
import { defaultOdinfmtToolchain } from "//rules/odin/odinfmt";
import "//rules/odin/vscode";
import { defaultRuffToolchain } from "//rules/python/ruff_toolchain";
import { defaultPythonToolchain } from "//rules/python";
import "//rules/rust/generate_build";
import { defaultKacheToolchain } from "//rules/rust/kache";
import { rustToolchain } from "//rules/rust/toolchain";
import "//rules/workflows/build";
import "//rules/workflows/builtin_lockfiles";
import "//rules/workflows/fmt";
import "//rules/workflows/generate";
import "//rules/workflows/generate_build";
import "//rules/workflows/lint";
import "//rules/workflows/lockfiles";
import "//rules/workflows/package";
import "//rules/workflows/publish";
import "//rules/workflows/run";
import "//rules/workflows/test";
import "//rules/workflows/vs";
import "//rules/imp/mode";
import "//rules/imp/test";

export const biome = defaultBiomeToolchain();
export const mold = defaultMoldToolchain();
// Rust's own linker opt below needs a graph-native mold handle (see
// //rules/rust's linkerHandlesFor()); Odin's linker opt above still resolves
// mold via the legacy productFor()/MoldToolchain bridge (Odin's own build is
// still fully legacy, out of scope for #31's graph-native C/C++ migration —
// gcc's own legacy default handle is no longer declared here for the same
// reason rules/c's own legacy factory was deleted: nothing but Odin still
// needs a *legacy* gcc/mold handle, and Odin resolves gcc directly via
// //rules/c/gcc's own declared default, not through this module), so both
// mold handles are declared.
const moldGraph = defaultMoldGraphToolchain();
export const odinToolchainDefault = odinToolchain("dev-2026-03", {
	default: true,
	linker: mold,
});
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
export const rust = rustToolchain("1.93.0", {
	default: true,
	linker: moldGraph,
	kache,
});

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
