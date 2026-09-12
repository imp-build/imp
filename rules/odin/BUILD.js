import { jsSources } from "//rules/js";
import { rulesTest } from "//rules/imp/test";
import { nativeTool } from "//rules/imp/native-tool";
import { defaultGccGraphToolchain } from "//rules/c/gcc";

const gccToolchain = defaultGccGraphToolchain();

export const rules_test = rulesTest({
	root: "//rules/odin",
	tools: [
		gccToolchain.tool,
		nativeTool("chmod"),
		nativeTool("cp"),
		nativeTool("xz"),
		nativeTool("mv"),
		nativeTool("unzip"),
		nativeTool("sh"),
		nativeTool("mkdir"),
		nativeTool("dirname"),
		nativeTool("curl"),
		nativeTool("tar"),
		nativeTool("gzip"),
		nativeTool("wc"),
		nativeTool("sha256sum"),
	],
});
export const js = jsSources({ base: "rules/odin" });
