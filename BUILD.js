import { cargoPackage } from "//rules/rust";
import { resourcePackage } from "//rules/asset";
import { protoAssets } from "//crates/imp-daemon";

import { stampFile } from "//rules/gen";
import { vsWorkspace } from "//rules/workflows/vs";

export const vs = vsWorkspace();

export const generated_stamp = stampFile({
    output: "generated/imp-stamp.txt",
    text: "imp build ran",
});

// src/loader.rs embeds these at compile time (CORE_JS via include_str!, the
// whole rules/ tree via include_dir!) so the built binary can run standalone
// without the workspace on disk — cargoPackage's own sources() only globs
// Cargo.toml/Cargo.lock/**/*.rs, so these need to be declared as a resource
// dep for the sandboxed build to see them too.
export const engineAssets = resourcePackage({
    srcs: ["src/imp_core.js", "rules/**/*"],
});

export const imp = cargoPackage({
    bin: "imp",
    deps: [engineAssets, protoAssets],
});
