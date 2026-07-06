import { stampFile } from "//rules/gen";
import { vsWorkspace } from "//rules/workflows/vs";

export const vs = vsWorkspace();

export const generated_stamp = stampFile({
    output: "generated/imp-stamp.txt",
    text: "imp build ran",
});
