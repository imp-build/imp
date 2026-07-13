+++
title = "Writing build rules"
weight = 3
template = "page.html"
+++

A rule module pairs a **target constructor** (a plain function returning `target({ kind, attrs })`) with a **product** — a memoized async function registered against that target kind and a goal name, e.g. `"build"`:

```js
import { target, product, run, output, output_path } from "imp:core";

export function stampFile({ output, text }) {
    return target({ kind: "stamp-file", attrs: { entrypoint: output, sources: text } });
}

export const file = product("stamp-file", "build", async function file(handle) {
    return run({
        argv: ["sh", "-c", "printf '%s\\n' \"$2\" > \"$1\"",
            "imp-stamp", output_path(handle.attrs.entrypoint), handle.attrs.sources],
        outputs: [output(handle.attrs.entrypoint)],
        display: `write ${handle.attrs.entrypoint}`,
    });
});
```

Every real subprocess runs through `run()`, hermetically sandboxed and cached by the content-addressed digest of its declared inputs, tools, and configuration. The parent directories of declared `outputs` (and directory outputs themselves) are created in the sandbox before the command runs, so scripts don't need to `mkdir` them. See the [JS code reference](../../reference/js-api/) for the full exported implementation surface.
