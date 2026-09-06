package consumer

import "core:testing"

// The `odin test` counterpart of //rules/odin/example/shared's binary case.
// A `foreign import` resolves relative to this file's own directory, so this
// reaches the same workspace-root-relative library.
foreign import lib "../../../../../build/c/librules_odin_example_shared.so"

foreign lib {
	imp_example_mul :: proc "c" (a, b: i32) -> i32 ---
}

@(test)
test_mul :: proc(t: ^testing.T) {
	testing.expect(t, imp_example_mul(6, 7) == 42)
}
