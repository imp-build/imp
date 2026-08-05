import { jsSources } from "//rules/js";
import { rulesTest } from "//rules/imp/test";
import { nativeTool } from "//rules/imp/native-tool";

export const rules_test = rulesTest({
	root: "//rules/odin/odinfmt",
	tools: [
		nativeTool("mkdir"),
		nativeTool("dirname"),
		nativeTool("curl"),
		nativeTool("tar"),
		nativeTool("wc"),
		nativeTool("sha256sum"),
	],
});
export const js = jsSources({ base: "rules/odin/odinfmt" });
