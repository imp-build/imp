+++
title = "Writing build rules"
weight = 3
template = "page.html"
+++

A rule module exposes factories that synchronously construct immutable graph
handles. A stamp rule is a small example: its output is a reusable file
artifact, and the `BUILD` property makes that same artifact selectable.

```js
import { BUILD, output, task } from "imp:core";

export function stampFile({ output: path, text }) {
    const stamp = task({
        display: `write ${path}`,
        inputs: { path, text },
        outputs: { file: output.artifact() },
        async run(exec, { path, text }) {
            const result = await exec.action({
                argv: ["sh", "-c", 'printf \'%s\\n\' "$2" > "$1"', "stamp", path, text],
                outputs: { file: output.file(path) },
            });
            return { file: result.outputs.file };
        },
    });
    return Object.freeze({ file: stamp.outputs.file, [BUILD]: stamp.outputs.file });
}
```

Export the returned object from a `BUILD.js` file to give it a selectable
workspace address. Its task does not run during module evaluation; it runs
only when that root or its `file` artifact is needed. The resulting artifact
stays in the CAS rather than being written into the workspace.

## Handle graphs

The graph API offers a more direct model for new rules: module evaluation
always constructs an immutable graph, and exported objects attach workflow
symbols to output handles. The callback of a `task()` is lazy; it runs only
when a selected root needs that handle.

```js
import { BUILD, RUN, files, output, task } from "imp:core";
import { nativeTool } from "//rules/imp/native-tool";

const sources = files({ include: ["src/**/*.rs", "Cargo.toml"] });
const compiler = nativeTool("rustc");

const binary = task({
    inputs: { sources, compiler },
    outputs: { binary: output.artifact() },
    async run(exec, { sources, compiler }) {
        const result = await exec.action({
            argv: [exec.tool(compiler, "rustc"), "src/main.rs", "-o", "bin/app"],
            inputs: [sources],
            outputs: { binary: output.file("bin/app") },
        });
        return { binary: result.outputs.binary };
    },
});

export const app = {
    [BUILD]: binary.outputs.binary,
    [RUN]: task({
        inputs: { binary: binary.outputs.binary },
        async run(exec, { binary }) {
            await exec.action({ argv: [exec.path(binary)] });
        },
    }),
};
```

Task inputs are the dependency graph. Literal JSON, source handles, artifact
handles, tool handles, and invocation-scoped `semantic` handles all use the
same named `inputs` object. A task's identity includes only the handles it
declares, so a task that does not depend on a mode or flag remains shareable
across those values.

`nativeTool(name)` and `impTool` from `//rules/imp/native-tool` and
`//rules/imp/self-tool` are lazy tool handles. Consuming them with
`exec.tool()` makes the resolved executable part of the action identity;
passing native-tool inputs through `exec.action({ tools })` also exposes them
on the sandboxed `PATH`. Acquisition helpers such as `downloadToolArtifact()`
and `extractArchive()` return artifact handles immediately when given their
graph forms, and own their standard host-tool dependencies.

Modes and configuration are equally explicit. Put `semantic.mode("opt")` or
`semantic.config("rust", "edition")` in only the tasks that read those values.
Changing unrelated invocation context then leaves shared producers untouched.

`files()` roots are workspace-relative. Capture `packagePath()` in the BUILD
module that owns the sources, then pass it explicitly through helpers:

```js
import { packagePath } from "imp:core";
import { asset } from "//rules/asset";

const here = packagePath();
const sources = asset({ base: here, srcs: ["src/**/*.rs"] }).sources;
```

The default is convenient for a direct BUILD call, but helpers should accept
and forward `base`: imported BUILD modules do not have one inferable owner.

During the ruleset migration, `resourcePackage()` from `//rules/asset` still
works as a legacy dependency and also exposes its graph-native source handle
as `.files`. New graph tasks should consume that handle directly.

An action's named files and directories are normalized into independent CAS
artifact roots. Downstream tasks consume those handles directly; action
outputs are not materialized into the workspace. Use `cache: false` for an
intentionally impure task. Calls to the same handle still join one in-flight
execution during an invocation.

A module's default export defines the directory root (`//pkg`), while named
exports define `//pkg:name`. A workflow may expose named facets; select one as
`//pkg:name@facet`. Legacy labels and graph roots can coexist, but exporting
both for the same address and workflow is an error.

Expansion is a graph node too. `expand({ inputs, create })` discovers a keyed
set of child objects after its inputs resolve; `.get(key, BUILD)` depends on
one child's build handle and `.all(BUILD)` depends on all of them. Expansion
may add tasks but cannot execute actions, keeping discovery separate from
sandbox work.

Factories whose selectable children are only known after async metadata
discovery can register them beneath a statically exported owner:

```js
import {
	build,
	discoverLabels,
	label,
	registerLabel,
} from "imp:core";

export function generatedProject(opts) {
	const project = label({ data: opts });
	discoverLabels(project, async owner => {
		for (const item of await discoverItems(owner.data)) {
			const child = label({ data: item });
			build(child, () => buildItem(child.data));
			registerLabel(child, `//generated:${item.name}`);
		}
	}, { goals: ["build"] });
	return project;
}
```

The discovery callback replays once per live runtime so registrations are
never cached away. Put expensive discovery beneath `memo()`. Addresses passed
to `registerLabel()` must be absolute and canonical; handlers remain lazy and
run only when their child is selected.

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

## Validate memo-trace inputs

`imp <goal> --trace-inputs` checks that the provenance record written for
each memoized computation covers its tracked `run({ inputs })` declarations.
FileSet inputs and explicit file, manifest, and directory inputs are
content-digested so `--changed-since` can identify stale computations.

```sh
imp build //apps/server:server --trace-inputs
```

This validates dependencies visible through the imp rule API. It does not
trace arbitrary filesystem calls made by a subprocess or direct use of
untracked JavaScript APIs.

`memo()` deduplicates calls only within the current process. Every new
invocation re-enters rule logic; expensive `run()` work is reused through the
task cache and CAS. Use `--no-cache` to bypass that action cache.

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
