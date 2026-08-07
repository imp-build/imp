import { cargoPackage } from "//rules/rust";
import { resourcePackage } from "//rules/asset";

// build.rs compiles proto/imp_exec_v1.proto via protox/tonic-build;
// cargoPackage's own sources() only globs Cargo.toml/Cargo.lock/**/*.rs, so
// the proto tree needs to be declared as a resource dep for the sandboxed
// build to see it too (same pattern as the root imp target's engineAssets
// dep, //BUILD.js).
export const protoAssets = resourcePackage({
    srcs: ["proto/**"],
});

export const imp_daemon = cargoPackage({
    workspaceMember: true,
    deps: [protoAssets.files],
});
