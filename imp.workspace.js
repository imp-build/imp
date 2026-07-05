// Workspace root marker. Import plugin modules here to register their rules
// before any BUILD.js is evaluated.
import "//rules/c/cmake";
import "//rules/gen";
import "//rules/odin";
import "//rules/rust/toolchain";
import "//rules/workflows/build";
import "//rules/workflows/fmt";
import "//rules/workflows/lint";
import "//rules/workflows/lockfiles";
import "//rules/workflows/package";
import "//rules/workflows/run";
import "//rules/workflows/test";
import "//rules/workflows/vs";
import "//rules/imp/test";
