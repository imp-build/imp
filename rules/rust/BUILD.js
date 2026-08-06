import { jsSources } from "//rules/js";
import { rulesTest } from "//rules/imp/test";

export const rules_test = rulesTest({ root: "//rules/rust" });
export const js = jsSources({ base: "rules/rust" });
