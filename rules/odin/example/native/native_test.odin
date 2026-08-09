package native

import "core:testing"

// Issue #100: foreign import resolves relative to this file's own directory
// (rules/odin/example/native), not the `odin build`/`odin test` invocation
// directory — so this reaches the workspace-root-relative archive ccLibrary()
// produces at build/c/rules_odin_example_native.a.
foreign import lib "../../../../build/c/rules_odin_example_native.a"

foreign lib {
	imp_example_add :: proc "c" (a, b: i32) -> i32 ---
}

@(test)
test_add :: proc(t: ^testing.T) {
	testing.expect(t, imp_example_add(2, 3) == 5)
}
