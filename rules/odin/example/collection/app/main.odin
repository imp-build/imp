package main

import "core:fmt"
import "lib:greet"

main :: proc() {
	fmt.println(greet.message())
}
