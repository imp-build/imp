import { cmakeLib } from "//rules/c/cmake";
import { zigToolchain } from "//rules/c/zig/toolchain";
import { jsSources } from "//rules/js";

const zig = zigToolchain("0.16.0");

export const hello = cmakeLib({
	compiler: zig,
	cmakeArgs: ["-DCMAKE_BUILD_TYPE=Debug"],
	outputs: ["libhello_cmake.so"],
});
export const js = jsSources({});
