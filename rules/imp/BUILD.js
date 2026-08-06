import { jsSources } from "//rules/js";
import { rulesTest } from "//rules/imp/test";
import { nativeTool } from "//rules/imp/native-tool";

export const rules_test = rulesTest({
	root: "//rules/imp",
	tools: [nativeTool("sh")],
});
export const js = jsSources({ base: "rules/imp" });
