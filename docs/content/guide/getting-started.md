+++
title = "Getting started"
weight = 2
template = "page.html"
+++

This page is for users who have installed `imp` and want to create a workspace
and build a first target. You will create `imp.workspace.luau`, declare a small C
test target, and run it from the workspace root.

You need an Imp installation and a supported compiler toolchain. The C rules
use a pinned managed toolchain by default; the first build may download it.
See [Installing Imp](../installing/) if the `imp` command is not available.

Create `imp.workspace.luau` at the workspace root. Import the rule modules your
`BUILD.luau` files will use (see [The workspace file](../workspace-file/) for
the other configuration options):

**Illustrative example**

```luau
require("@imp/rules/c")
require("@imp/rules/workflows/test")
return {}
```

Create a `BUILD.luau` file in the same directory:

**Illustrative example**

```luau
local c = require("@imp/rules/c")
return { hello_test = c.cc_test({ srcs = { "hello_test.c" } }) }
```

Add the test program. A `cc_test()` target passes when its executable returns
zero:

**Illustrative example**

```c
int main(void) {
    return 2 + 3 == 5 ? 0 : 1;
}
```

Imp discovers `BUILD.luau` files anywhere below the workspace root. List the
target before running it:

**Runnable example**

```sh
# From the workspace root
imp targets //...
```

Build the test executable. Build stores the result in the cache and does not
write `hello_test` into the workspace:

**Runnable example**

```sh
imp build //:hello_test
```

Run the test goal:

**Runnable example**

```sh
imp test //:hello_test
```

The test goal runs the executable and reports one test unit. Use
[Target selection](../target-selection/) to select packages, subtrees, or
changed targets. Use [Package build outputs](../packaging/) when a build
product must be written below `dist/`.
