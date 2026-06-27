import { cppSources, cmakeLib } from "//rules/c/cmake";
import { stampFile } from "//rules/gen";
import { odinPackage } from "//rules/odin";

export const joltphysics = cppSources({ srcs: ["**/*.h", "**/*.cpp"] });
export const cmake       = cmakeLib({ entrypoint: "CMakeLists.txt", deps: [joltphysics] });
export const jodin       = odinPackage({ srcs: ["*.odin"], deps: [cmake] });

export const generated_stamp = stampFile({
    output: "generated/imp-stamp.txt",
    text: "planned executor ran",
});
