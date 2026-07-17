import { jsSources } from "//rules/js";
import { rulesTest } from "//rules/imp/test";
import { nativeTool } from "//rules/imp/native_tool";

export const rules_test = rulesTest({
	root: "//rules/odin",
	tools: [
		nativeTool("mkdir"),
		nativeTool("dirname"),
		nativeTool("curl"),
		nativeTool("tar"),
		nativeTool("gzip"),
	],
});
export const js = jsSources({});
