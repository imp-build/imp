import { resourcePackage } from "//rules/asset";
import { nativeTool } from "//rules/imp/native_tool";

import { stampFile } from "//rules/gen";
import { vsWorkspace } from "//rules/workflows/vs";

export const vs = vsWorkspace();

export const generated_stamp = stampFile({
    output: "generated/imp-stamp.txt",
    text: "imp build ran",
});

// crates/imp-engine/src/loader.rs embeds these at compile time (CORE_JS
// via include_str!, the whole rules/ tree via include_dir!) so the built
// binary can run standalone without the workspace on disk — cargoPackage's
// own sources() only globs Cargo.toml/Cargo.lock/**/*.rs, so these need to be
// declared as a resource dep for the sandboxed build to see them too.
export const engineAssets = resourcePackage({
    srcs: ["crates/imp-engine/src/imp_core.js", "rules/**/*"],
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
