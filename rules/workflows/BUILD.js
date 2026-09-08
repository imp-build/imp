import { rulesTest } from "//rules/imp/test";
import { jsSources } from "//rules/js";

export const rules_test = rulesTest({ root: "//rules/workflows" });
export const js = jsSources({ base: "rules/workflows" });
