import { jsSources } from "//rules/js";
import { rulesTest } from "//rules/imp/test";
import { nativeTool } from "//rules/imp/native-tool";

export const rules_test = rulesTest({
	root: "//rules/c/cmake",
	tools: ["sh", "ninja", "sed", "mkdir"].map(nativeTool),
});
export const js = jsSources({ base: "rules/c/cmake" });
