import { jsSources } from "//rules/js";
import { rulesTest } from "//rules/imp/test";

export const rules_test = rulesTest({ root: "//rules/js/node" });
export const js = jsSources({ base: "rules/js/node" });
