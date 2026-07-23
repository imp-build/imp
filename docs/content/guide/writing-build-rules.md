+++
title = "Writing build rules"
weight = 3
template = "page.html"
+++

A rule module pairs a **target constructor** (a plain function returning `target({ kind, attrs })`) with a **product** — a memoized async function registered against that target kind and a goal name, e.g. `"build"`:

```js
import { Target, product, run, output, output_path, toolName, BUILD } from "imp:core";

export class StampFile extends Target {
    static kind = "stamp-file";
    constructor({ output, text }) {
        super({ kind: StampFile.kind, attrs: { entrypoint: output, sources: text } });
    }
}

export function stampFile(opts) {
    return new StampFile(opts);
}

// Every product names the tool implementing it; products are keyed
// (kind, product, tool), so several tools can implement the same product
// for a kind (e.g. two formatters).
const GEN_TOOL = toolName("gen");

export const file = product(StampFile, BUILD, GEN_TOOL, async function file(handle) {
    return run({
        argv: ["sh", "-c", "printf '%s\\n' \"$2\" > \"$1\"",
            "imp-stamp", output_path(handle.attrs.entrypoint), handle.attrs.sources],
        outputs: [output(handle.attrs.entrypoint)],
        display: `write ${handle.attrs.entrypoint}`,
    });
}, {
    display: "build {0}",
    level: "info",
});
```

Every real subprocess runs through `run()`, hermetically sandboxed and cached by the content-addressed digest of its declared inputs, tools, and configuration. The parent directories of declared `outputs` (and directory outputs themselves) are created in the sandbox before the command runs, so scripts don't need to `mkdir` them. See the [JS code reference](../../reference/js-api/) for the full exported implementation surface.

Memoized functions use the same metadata object:

```js
const sources = memo(async function sources(handle) {
    // ...
}, {
    display: "sources {0}",
    level: "debug",
});
```

Display templates use positional placeholders. Targets render as addresses,
scalars render plainly, and collections or objects use bounded summaries such
as `[8 targets]` and `{…}`. User-facing products and toolchain acquisition
normally use `info`; internal source, resource, and metadata computations use
`debug`. Memo failures are always reported at `error`.
