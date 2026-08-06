import { jsSources } from "//rules/js";
import { rulesTest } from "//rules/imp/test";

export const rules_test = rulesTest({ root: "//rules/c/cmake" });
export const js = jsSources({ base: "rules/c/cmake" });
