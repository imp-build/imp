import { cmakeLib } from "//rules/c/cmake";
import { zigToolchain } from "//rules/c/zig";
import { ccBinary, ccLibrary } from "//rules/c";
import { jsSources } from "//rules/js";

const zig = zigToolchain("0.16.0");

export const hello = cmakeLib({
	compiler: zig,
	cmakeArgs: ["-DCMAKE_BUILD_TYPE=Debug"],
	outputs: ["libhello_cmake.so"],
});
export const raw_hello = ccLibrary({
	srcs: ["hello.c"],
	toolchain: zig,
});
export const raw_main = ccBinary({
	srcs: ["main.c"],
	deps: [raw_hello],
	toolchain: zig,
});
export const js = jsSources({});
