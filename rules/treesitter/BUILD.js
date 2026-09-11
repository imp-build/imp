import { rulesTest } from "//rules/imp/test";
import { roundtrip } from "//rules/treesitter";

export const rules_test = rulesTest({
	root: "//rules/treesitter",
});

export { roundtrip };
