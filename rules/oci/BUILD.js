import { jsSources } from "//rules/js";
import { rulesTest } from "//rules/imp/test";

export const rules_test = rulesTest({ root: "//rules/oci" });
export const js = jsSources({ base: "rules/oci" });
