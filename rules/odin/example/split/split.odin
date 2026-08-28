package split

Greeting :: "hello from the package under test"

shout :: proc(text: string) -> int {
	return len(text)
}
