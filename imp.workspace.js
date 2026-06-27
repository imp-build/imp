// Workspace root marker. Import plugin modules here to register their rules
// before any BUILD.js is evaluated.
import "//rules/c/cmake";
import "//rules/gen";
import { odinToolchain } from "//rules/odin";

// Declare the workspace Odin toolchain version from .odin-version.
// (A real production version would read the file; for now we read the same
//  version the Rust side uses — see workspace::odin_version().)
odinToolchain("dev-2026-03", { default: true });
