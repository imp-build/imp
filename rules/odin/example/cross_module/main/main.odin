package main

import "../gen"
import "core:fmt"

main :: proc() {
	fmt.println("value:", gen.Double)
}
