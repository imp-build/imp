import { jsSources } from "//rules/js";
import { rulesTest } from "//rules/imp/test";

export const rules_test = rulesTest({ root: "//rules/zola" });
export const js = jsSources({ base: "rules/zola" });
