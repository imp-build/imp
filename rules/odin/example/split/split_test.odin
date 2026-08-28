package split

import "core:testing"

// Names Greeting and shout, which split.odin declares. Odin compiles the
// directory as one package, so this file compiles only because the
// odinTestPackage() depends on the odinPackage() that globs the other half.
@(test)
shout_counts_the_greeting :: proc(t: ^testing.T) {
	testing.expect_value(t, shout(Greeting), len(Greeting))
}
