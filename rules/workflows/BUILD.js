import { rulesTest } from "//rules/imp/test";
import { jsSources } from "//rules/js";
import { nativeTool } from "//rules/imp/native-tool";

export const rules_test = rulesTest({
	root: "//rules/workflows",
	tools: [nativeTool("sh")],
});
export const js = jsSources({ base: "rules/workflows" });
