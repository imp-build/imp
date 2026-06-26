import { cppSources, cmakeLib } from "//rules/cpp";
import { odinPackage } from "//rules/odin";

export const joltphysics = cppSources({ srcs: ["**/*.h", "**/*.cpp"] });
export const cmake       = cmakeLib({ entrypoint: "CMakeLists.txt", deps: [joltphysics] });
export const jodin       = odinPackage({ srcs: ["*.odin"], deps: [cmake] });
