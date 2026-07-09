// The "package" goal is seeded by default in HostState::default() (src/spike.rs).
// Declared explicitly here so it's documented; goal registration is
// first-registration-wins, so this is a no-op today and stays correct if
// that default is ever dropped.
//
// A `package` product is the one blessed way to publish a build result under
// dist/: run its build product(s) with materialize:false, then hand the
// resulting digest to writeWorkspace() (imp:core) — no sandbox, no cache
// record, no run()-level materialize:true warning. distPathFor() below picks
// the destination for you, so packaging locations stay predictable instead
// of each rule hand-picking a dist/ path. See docs/BUILD.js's site_package
// for the reference implementation.
//
// odin-package has a stub product (odinPackageStub, rules/odin/index.js)
// that throws "not yet implemented" rather than silently succeeding —
// imp package fails loudly for odin-package targets. The legacy Rust
// command (src/commands/package.rs, no longer wired into the binary) built
// a content pak, copied game binaries and license files into a per-platform
// dist/ directory, and zipped the result. Platforms and version were CLI
// arguments.
//
// TODO: define the actual packaging products, composing the content-pack
// and binary build products into a distributable zip, e.g.:
//   product("<some-kind>", "package", async (handle) => { ... });

import { goal, targetAddress } from "imp:core";

goal("package");

/**
 * Derive a target's dist/ destination from its workspace address (e.g.
 * "//docs:site" → "dist/docs/site"), so package products don't each pick
 * their own ad hoc path.
 *
 * @param {object} handle A target handle returned by target().
 * @returns {string} Workspace-relative dist/ path.
 */
export function distPathFor(handle) {
    const address = targetAddress(handle);
    const withoutSlashes = address.replace(/^\/\//, "");
    const [dir, name] = withoutSlashes.split(":");
    return dir ? `dist/${dir}/${name}` : `dist/${name}`;
}
