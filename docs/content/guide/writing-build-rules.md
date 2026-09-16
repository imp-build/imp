+++
title = "Writing build files"
weight = 4
template = "page.html"
+++

This page is for users who declare targets in `BUILD.js`. It explains how to
describe inputs, tools, outputs, and dependencies so Imp can build the graph
and run actions in sandboxes.

A rule module exposes factories that synchronously construct immutable graph
handles. A stamp rule is a small example: its output is a reusable file
artifact, and the `BUILD` property makes that same artifact selectable.

**Illustrative example**

```js
import { output, task } from "imp:core";
import { BUILD } from "//rules/workflows/build";

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
import { files, output, task } from "imp:core";
import { BUILD } from "//rules/workflows/build";
import { RUN } from "//rules/workflows/run";
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

An action gets one core of the `jobs` budget by default. A command that
parallelises itself across more than one core must say so with
`exec.action({ cores })`, or the scheduler admits a full lane of them and each
one fans out to the whole machine. The scheduler grants that many permits and
gives the command the same number as `IMP_CORES`, so read it back instead of
repeating the literal:

```js
await exec.action({
    argv: ["sh", "-c", 'make -j "$IMP_CORES"'],
    cores: 4,
});
```

A tool that takes its job count from the environment can read the same number
without a shell: `$IMP_CORES` (or `${IMP_CORES}`) in an `env` value is expanded
by the executor before the command starts.

```js
await exec.action({
    argv: ["cargo", "build"],
    env: ["CARGO_BUILD_JOBS=$IMP_CORES"],
    cores: 8,
});
```

`cores` is clamped to the total budget, so an action that asks for more than
`jobs` runs alone rather than waiting on permits that can never be granted. It
is not part of the action cache key, and neither is the expansion above — the
digest keeps the literal `$IMP_CORES` — so the same command stays
cache-compatible across machines with different budgets.

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

`files()` roots are workspace-relative. Rule factories that need one — `asset()`,
`cargoPackage()`, `odinPackage()`, `ccLibrary()`, `jsSources()`, and others —
default a `base`/`path` option to `packagePath()`:

```js
import { asset } from "//rules/asset";

export const sources = asset({ srcs: ["src/**/*.rs"] }).sources;
```

`packagePath()` resolves to the BUILD module actually being evaluated, not the
one nearest on the JS call stack: it walks the whole stack and keeps the
*outermost* `BUILD.js` frame, so a factory called through an imported helper
still resolves to the consuming BUILD.js, not to wherever the helper happens
to be defined (issue #71; see `spike.rs`'s
`graph_package_path_resolves_to_the_consuming_build_js_through_a_helper`
test). Inside a `task()`/`expand()` `run()`/`create()` callback, the value is
captured once at declaration time and delivered ambiently, since by execution
time the declaring module's stack frame is long gone. This is the durable
ownership contract, not a migration-era shim — helpers do not need to accept
and forward `base` defensively. Pass `base`/`path` explicitly only when a
factory's source root is genuinely not the calling module's own directory
(e.g. sources actually live in a different, hand-picked package).

Exported-root addressing (`//pkg:name`) is unrelated: a root's address is
always the *exporting* module's own scope plus the export name, regardless of
where the underlying handle was constructed — aliasing or re-exporting a
handle across packages does not change ownership or addressing.

`resourcePackage()` from `//rules/asset` still works as a legacy dependency
for Rust and Odin and also exposes its graph-native source handle as `.files`.
New graph tasks should consume that handle directly.

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

Sometimes the `BUILD.js` author cannot name the children at all — a glob's
matches, or a package list that only a metadata command knows. Export
`expansion.all(WORKFLOW)` rather than a projection of one key, and the engine
discovers each child as its own selectable root by walking that single export:

```js
import { expand, files, glob, paths } from "imp:core";
import { RUN } from "//rules/workflows/run";

export function scripts({ root, include = ["*.py"] }) {
	const expansion = expand({
		display: `expand scripts ${root}`,
		inputs: { sources: files({ root, include }) },
		create() {
			const children = {};
			for (const file of paths(glob({ root, include, exclude: [] }))) {
				children[file] = { [RUN]: runScript(root, file) };
			}
			return children;
		},
	});
	return Object.freeze({ root, [RUN]: expansion.all(RUN) });
}
```

Each child is selectable by its key beneath the owner —
`//tools:scripts#tools/hello.py`. `rules/python/source.js` uses exactly this
shape. Discovery reruns on every invocation, which is why `create()` should
stay cheap — a glob, or a read of a result some ordinary cached task already
produced. Keep the expensive part in that task, not in `create()`.

Every real subprocess runs through `run()`, hermetically sandboxed and cached by the content-addressed digest of its declared inputs, tools, and configuration. The parent directories of declared `outputs` (and directory outputs themselves) are created in the sandbox before the command runs, so scripts don't need to `mkdir` them. See the [JS code reference](../../reference/js-api/) for the full exported implementation surface.

`memo()` covers host-side work that sits outside the graph, such as toolchain
acquisition. Inside a rule's build graph, `task()` already deduplicates by
content, so reach for `memo()` only when there is no task to hold the work.
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
as `[8 targets]` and `{…}`. User-facing work and toolchain acquisition
normally use `info`; internal source, resource, and metadata computations use
`debug`. Memo failures are always reported at `error`.

`memo()`/`product()`/`expand()` identify a function by its declared name,
scoped to the module it's called from — moving a call to a different line
doesn't change its identity. A factory that calls `memo()` once per instance,
each time with a fresh closure, needs an explicit `{ id }` per instance (the
closures share a name, or have none); so does any genuinely anonymous
function:

```js
function cargoPackage(pkg) {
    return memo(async function build() { /* ... */ }, {
        display: `build ${pkg.name}`,
        level: "info",
        id: `cargoPackage:${pkg.name}`,
    });
}
```

## Report a failure the user must fix

A goal handler — the `graph` function given to `goal()` — and a task's `run()`
body both report two very different kinds of failure, and imp shows them
differently.

Use `goalError(message)` when the workspace is at fault and the user can
correct it. imp prints the message alone:

```js
import { goalError } from "imp:core";

if (stale.length > 0) {
    throw goalError(`generated files are out of date:\n${listed}`);
}
```

```text
error: generated files are out of date:
  .github/workflows/docs.yml
```

The same applies inside a task. A rule that runs a tool with
`allowFailure: true` and then reports the tool's verdict itself must use
`goalError`, so the report reaches the user without the engine's own frames
around it:

```js
if (own.length > 0) throw goalError(`unformatted: ${own.join(", ")}`);
```

An action that imp itself failed — a non-zero exit without `allowFailure` — is
already treated this way; no rule code is needed for it.

Use a plain `new Error()` when the rule or the engine is at fault. imp then
adds the goal name and keeps the JS stack, because somebody has to debug it.
The stack of a `goalError` is not lost either — run the goal again with
`imp --level debug <goal>` to see it.

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
