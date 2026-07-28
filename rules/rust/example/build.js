// Override fixture for the Phase 4 path-addressed dispatch pilot (#52) —
// exercises `build(path)`'s override-merge path (see //rules/rust's
// `tryImportBuildOverrides`). `-v` is a harmless, observable marker: it
// shows up in cargo's own verbose rustc invocation output, confirming this
// file's `cargoArgs` reached the actual `cargo build` call.
export default {
	cargoArgs: ["-v"],
};
