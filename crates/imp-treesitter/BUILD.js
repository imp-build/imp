import { cargoPackage } from "//rules/rust";
import { resourcePackage } from "//rules/asset";

// cargoPackage's own sources() only globs Cargo.toml/Cargo.lock/**/*.rs, so
// the checked-in fixture grammar (read at test run time via
// CARGO_MANIFEST_DIR, not compiled in) needs to be declared as a resource
// dep for the sandboxed build/test to see it — same reason the top-level
// BUILD.js declares engineAssets for imp-engine's embedded JS.
export const testdataAssets = resourcePackage({
    srcs: ["testdata/**/*"],
});

export const imp_treesitter = cargoPackage({
    deps: [testdataAssets],
    workspaceMember: true,
});
