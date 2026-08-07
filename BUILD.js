import { resourcePackage } from "//rules/asset";
import { nativeTool } from "//rules/imp/native-tool";

import { stampFile } from "//rules/gen";

export const generated_stamp = stampFile({
	output: "generated/imp-stamp.txt",
	text: "imp build ran",
});

// crates/imp-engine/src/loader.rs embeds the core JS files at compile time via
// include_str! — cargoPackage's own sources() only globs
// Cargo.toml/Cargo.lock/**/*.rs, so it needs declaring as a resource dep for
// the sandboxed build to see it too.
export const engineAssets = resourcePackage({
	srcs: [
		"crates/imp-engine/src/imp_core.js",
		"crates/imp-engine/src/graph_core.js",
	],
});

// The rule library is NOT compiled into the binary — it ships beside it and is
// resolved from disk at runtime. It's still declared here because
// imp-engine's *tests* resolve real rules from tempdir workspaces, so the
// tree has to exist inside their sandbox. Deliberately kept off
// //crates/imp, so a rule edit no longer invalidates the release binary.
export const rulesTree = resourcePackage({
	srcs: ["rules/**/*"],
});

export const testTar = nativeTool("tar");
export const testGzip = nativeTool("gzip");
export const testCmake = nativeTool("cmake");
export const testCc = nativeTool("cc");
export const testAs = nativeTool("as");
export const testLd = nativeTool("ld");
export const testAr = nativeTool("ar");
export const testMkdir = nativeTool("mkdir");
export const testNinja = nativeTool("ninja");
export const testDirname = nativeTool("dirname");
export const testCp = nativeTool("cp");
export const testCtest = nativeTool("ctest");
export const testFind = nativeTool("find");
export const testSed = nativeTool("sed");
export const testSha256sum = nativeTool("sha256sum");
export const testCurl = nativeTool("curl");
export const testWc = nativeTool("wc");
export const testXz = nativeTool("xz");
export const testChmod = nativeTool("chmod");
// changed.rs's tests shell out to `git` directly (Command::new("git")), so
// it needs the same hermetic sandbox mount as tar/gzip — without it those
// tests fail inside `imp test`'s sandbox with "run git (is git
// installed?)", even though git is on the host PATH.
export const testGit = nativeTool("git");
