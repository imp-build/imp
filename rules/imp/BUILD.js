import { jsSources } from "//rules/js";
import { rulesTest } from "//rules/imp/test";
import { nativeTool } from "//rules/imp/native_tool";

export const rules_test = rulesTest({
	root: "//rules/imp",
	tools: [nativeTool("sh")],
});
export const js = jsSources({});
