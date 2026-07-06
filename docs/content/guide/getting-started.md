+++
title = "Getting started"
weight = 1
template = "page.html"
+++

Every imp workspace has a root marker file, `imp.workspace.js`, which imports the rule modules your `BUILD.js` files will use (see [The workspace file](../workspace-file/) for what else it's for):

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
