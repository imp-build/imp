import { stampFile } from "//rules/gen";
import { odinToolchain } from "//rules/odin";
import { vsWorkspace } from "//rules/workflows/vs";

export const odin_toolchain = odinToolchain("dev-2026-03", { default: true });

export const vs = vsWorkspace();

export const generated_stamp = stampFile({
    output: "generated/imp-stamp.txt",
    text: "imp build ran",
});
