package main

import "core:fmt"
import "core:os"

// The shared-library counterpart of //rules/odin/example/native's archive
// case. A `foreign import` resolves relative to this file's own directory, so
// this reaches the workspace-root-relative library ccLibrary({shared: true})
// produces at build/c/librules_odin_example_shared.so.
//
// The library must also travel beside this executable at run time. Odin links
// with an `$ORIGIN` rpath by default (measured: RPATH [$ORIGIN]), so the
// product is a directory that holds both — see odinPackage()'s own docstring.
foreign import lib "../../../../build/c/librules_odin_example_shared.so"

foreign lib {
	imp_example_mul :: proc "c" (a, b: i32) -> i32 ---
}

main :: proc() {
	got := imp_example_mul(6, 7)
	fmt.println("6 * 7 =", got)
	if got != 42 {
		os.exit(1)
	}
}
