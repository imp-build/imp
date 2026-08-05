+++
title = "Getting started"
weight = 1
template = "page.html"
+++

Initialize a workspace from the repository root:

```sh
imp init
```

The interactive checklist detects C/C++, JavaScript/TypeScript, Odin, Python,
and Rust sources. Select the languages and capabilities the workspace needs;
imp then creates `imp.workspace.js` with the matching rule and workflow
imports. Those rules provide pinned default toolchains; initialization never
overwrites an existing workspace or creates a nested workspace.

Every imp workspace has a root marker file, `imp.workspace.js`. To create
one manually, import the rule modules your `BUILD.js` files will use (see [The
workspace file](../workspace-file/) for what else it's for):

```js
import "//rules/c/cmake";
import "//rules/workflows/build";
```

Targets are declared in `BUILD.js` files anywhere in the workspace tree — imp discovers them automatically:

```js
import { stampFile } from "//rules/gen";

export const hello = stampFile({
    output: "generated/hello.txt",
    text: "hello from imp",
});
```

Build it with:

```sh
imp build //:hello
```

This produces a cached artifact for other build tasks to consume; it does not
write `generated/hello.txt` into the workspace.
