+++
title = "Getting started"
weight = 2
template = "page.html"
+++

This page is for users who have installed `imp` and want to create a workspace
and build a first target. You will create `imp.workspace.js`, declare a small C
test target, and run it from the workspace root.

You need an Imp installation and a supported compiler toolchain. The C rules
use a pinned managed toolchain by default; the first build may download it.
See [Installing Imp](../installing/) if the `imp` command is not available.

Initialize a workspace from the repository root. This command is interactive:
it detects source languages and asks which rules and capabilities to enable.
Run it directly from a terminal. It does not read answers from a pipe.

**Illustrative example**

```sh
imp init
```

The checklist detects C/C++, JavaScript/TypeScript, Odin, Python, and Rust
sources. Select the languages and capabilities the workspace needs; Imp then
creates `imp.workspace.js` importing the rules that provide them. A language's
rules bring the workflows they support with them, so the generated file names
only what the selection adds. Those rules provide pinned default toolchains.
Initialization never overwrites an existing workspace or creates a nested
workspace.

Every Imp workspace has a root marker file, `imp.workspace.js`. For a small
workspace, you can create the file manually. Import the rule modules your
`BUILD.js` files will use (see [The workspace file](../workspace-file/) for
the other configuration options):

**Illustrative example**

```js
import "//rules/c";
import "//rules/workflows/test";
```

Create a `BUILD.js` file in the same directory:

**Illustrative example**

```js
import { ccTest } from "//rules/c";

export const hello_test = ccTest({
    srcs: ["hello_test.c"],
});
```

Add the test program. A `ccTest()` target passes when its executable returns
zero:

**Illustrative example**

```c
int main(void) {
    return 2 + 3 == 5 ? 0 : 1;
}
```

Imp discovers `BUILD.js` files anywhere below the workspace root. List the
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
