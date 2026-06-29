import { odinPackage } from "//rules/odin";

export const hello = odinPackage({
    srcs: ["*.odin"],
    toolchain: "dev-2026-03",
});
