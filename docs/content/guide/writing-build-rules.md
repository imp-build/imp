+++
title = "Writing build rules"
weight = 3
template = "page.html"
+++

A rule module exposes factories that synchronously return exported labels.
Goals attach lazy handlers to those labels, while memoized functions and
`run()` perform the actual work beneath each handler:

```js
import {
    build,
    extensible,
    label,
    memo,
    output,
    output_path,
    run,
} from "imp:core";

const writeStampFile = memo(async function writeStampFile(stamp) {
    const { output: outputPath, text } = stamp.data;
    return run({
        argv: [
            "sh",
            "-c",
            'printf \'%s\\n\' "$2" > "$1"',
            "imp-stamp",
            output_path(outputPath),
            text,
        ],
        outputs: [output(outputPath)],
        materialize: true,
        display: `write ${outputPath}`,
    });
});

export const stampFile = extensible(function stampFile({ output, text }) {
    const stamp = label({ data: { output, text } });
    build(stamp, () => writeStampFile(stamp));
    return stamp;
});
```

Export the returned label from a `BUILD.js` file to give it a selectable
workspace address. The attached build handler does not run during module
evaluation; it runs only when that label is selected for `imp build`.
`extensible()` lets integrations attach additional handlers replayably.

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

## Validate persisted memo inputs

`imp <goal> --trace-inputs` re-runs memoized computations instead of serving
persisted memo hits, then checks that the record written for each computation
covers its tracked `run({ inputs })` declarations. FileSet inputs and explicit
file, manifest, and directory inputs are content-digested; changing one
invalidates the persisted result on a later invocation.

```sh
imp build //apps/server:server --trace-inputs
```

This validates dependencies visible through the imp rule API. It does not
trace arbitrary filesystem calls made by a subprocess or direct use of
untracked JavaScript APIs.

## Parsing source with tree-sitter

`loadGrammar`/`parseSource`/`treeSexp`/`tsQuery` let rule code parse source
files with a [tree-sitter](https://tree-sitter.github.io/tree-sitter/) grammar
— e.g. to extract `use`/`import` paths for dependency discovery, or to run
custom analysis over a target's sources:

```js
import { loadGrammar, parseSource, tsQuery, read_file } from "imp:core";

const grammar = loadGrammar("/path/to/tree-sitter-rust.so");
const tree = parseSource(grammar, read_file(rustFilePath));
const matches = tsQuery(grammar, tree, "(use_declaration argument: (_) @import)");
const imports = matches.flatMap((m) => m.captures.map((c) => c.text));
```

**Trust tradeoff:** unlike every other native integration in this codebase
(which shells out to a subprocess via `run()`), a loaded grammar is dlopen'd
directly into the `imp` process — there is no subprocess boundary. A
malicious or buggy grammar library runs with `imp`'s own privileges and can
corrupt or crash the whole process. Only load grammars you trust, the same
standard you'd apply to any binary passed to `run()`.

`loadGrammar` currently takes a local path to an already-compiled grammar
shared library (`.so`/`.dylib`/`.dll`); acquiring one (downloading or
compiling it from source) is left to the caller for now.
