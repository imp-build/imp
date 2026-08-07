// Canonical CMake rule entrypoint (graph-native, issue #31/#62 + #63
// cutover). cmakeProject() builds one expand()-based per-target discovery
// per project — see expansion.js's own docstring for the `{get, all}` shape
// and its known raw-ccBinary()-interop gap (issue #67). The heavier I/O
// layer (configure/replay via exec.action(), ninja/ctest parsing) lives in
// separate internal modules this file doesn't re-export: graph_replay.js,
// ninja_graph.js, ctest_testfile.js.
export {
	cmakeProject,
	cmakeProjectExpansion,
	cmakeProjectSpecs,
} from "//rules/c/cmake/expansion";

// CMake's own toolchain (the `cmake` binary itself, distinct from the C/C++
// compiler toolchain a project builds with) lives in its own module — same
// split the legacy rule used.
export {
	__resetCmakeToolchainStateForTest,
	acquireCmakeToolchain,
	cmakeBin,
	cmakeCacheKey,
	cmakeGraphTool,
	cmakeGraphToolSpec,
	cmakeGraphToolchain,
	cmakeSupportedPlatforms,
	cmakeToolchain,
	defaultCmakeGraphToolchain,
	defaultCmakeToolchainVersion,
	installCmakeToolchain,
	resolveCmakeToolchainVersion,
} from "//rules/c/cmake/toolchain";
