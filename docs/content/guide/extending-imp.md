+++
title = "Extending Imp"
weight = 20
extra = { sidebar_heading = true }
+++

Imp is extended in JavaScript. A rule package declares the factories that
construct graph handles; a workspace selects and configures those rules; and
`BUILD.js` files declare the graph that should be built.

The important distinction is that workspace and `BUILD.js` files should be
primarily declarative. Rule implementation code can be imperative, but users
should normally describe intent with exported handles and configuration
objects.

## Rule packages

A rule package has four layers. See
[Writing build rules](../writing-build-rules/) for the graph primitives
themselves; this page is about how a package puts them together.

### 1. Import the workflow symbols

A goal is a symbol, and the module that implements a goal exports it. A rule
package imports one symbol per goal it supports:

**Illustrative example**

```js
import { BUILD } from "//rules/workflows/build";
import { FMT } from "//rules/workflows/fmt";
import { LINT } from "//rules/workflows/lint";
import { PACKAGE } from "//rules/workflows/package";
import { TEST } from "//rules/workflows/test";
```

The rule package does not register goals; it implements them. A workspace
enables a goal by importing its workflow module.

### 2. Build the graph in the factory

The factory normalizes its options, then constructs `task()` and `expand()`
nodes. This happens while the module is evaluated. Nothing executes: the
factory returns handles that describe work, and only a selected root causes
that work to run.

Where several targets must share one tool invocation — one `cargo clippy` per
Cargo workspace rather than one per crate — route them through a keyed
`expand()` and project each target's own result out of it with
`expansion.get(key, WORKFLOW)`.

### 3. Return a frozen object keyed by those symbols

```js
export function stampPackage(opts) {
    const build = stampTask(opts);
    return Object.freeze({
        [BUILD]: build.outputs.file,
        [PACKAGE]: build.outputs.file,
    });
}
```

Exporting that object from a `BUILD.js` file gives each of its symbols a
selectable root. The engine finds them by walking the export's own symbol
properties; a package never registers its targets separately.

Two refinements are worth knowing:

- **Omit a symbol the package cannot serve.** Do not define an empty `BUILD`;
  define none. `cargoPackage()` in `rules/rust/index.js` adds `BUILD` and
  `PACKAGE` only for a crate that declares a `[[bin]]`, so `imp build` on a
  library crate reports what the target does provide instead of building
  nothing.
- **Use a getter when constructing the handle is expensive.** A property may be
  a lazy getter, so the work of building that part of the graph happens only if
  something asks for it.
- **A symbol may hold named facets instead of one handle.** A flat object of
  handles becomes one root per facet, selectable as `//pkg:name@facet` — this
  is how `TEST` splits into `unit` and `doctests`.

### 4. Registration on import

Importing the package is what registers its configuration schema, its default
toolchain, and any build-file generator or lockfile provider it offers. That
is why a workspace imports rule modules for their side effects.

## Toolchains

A rule package consumes a toolchain as a graph handle, so that the install task
is ordered before anything that needs the tool:

```js
import { defaultOdinToolchain } from "//rules/odin";

const odin = defaultOdinToolchain();   // a tool() handle

const compile = task({
    inputs: { sources, odin },
    // ...
});
```

Derive toolchain handles while the graph is being constructed, never inside a
`run()` body: `task()` may not be called once execution has started.

The separate `Toolchain` class described in
[the workspace file guide](../workspace-file/) backs `imp @tool` passthrough.
It is not how a rule package gets a compiler for its own tasks.

Lockfile generation is a separate mechanism again. A toolchain's declare
function attaches a `[GEN_LOCKFILES]` graph root to the value it returns. For
a toolchain like Odin, whose declare function returns a bare `tool()` handle,
the root instead comes from a sibling function, `odinGenLockfiles(version)`.
`imp goal gen-lockfiles //some:address` needs that root exported to find it.
This repo's own built-in toolchains do not need an export for this: the
`gen-builtin-lockfiles` goal already owns their lock files, with no
selection step at all.

## Configuration

A package can declare its configuration schema next to its rule
implementation:

```js
import { defineConfigSchema, field } from "imp:core";

export const odinConfigSchema = {
    buildGenerate: field.bool({ default: false }),
    collections: field.map(field.string(), field.string(), { default: {} }),
};

defineConfigSchema("odin", odinConfigSchema);
```

The schema is registered when the rule package is imported. It is also the
source used by `imp config schema` and the generated user API reference.

### Workspace configuration

The workspace selects toolchains and supplies static configuration in
`imp.workspace.js`:

```js
import { odinToolchain } from "//rules/odin";

export const odin = odinToolchain("dev-2026-05", { default: true });

export const odinConfig = {
    buildGenerate: false,
    collections: {
        vendor: "//src/odin/vendor",
    },
};
```

The export name can be the namespace itself (`odin`) or the collision-free
`<namespace>Config` form (`odinConfig`). The latter is useful when a namespace
is also used for another workspace export, such as an `odin` toolchain.

Configuration is validated while the workspace loads, before `BUILD.js`
files are evaluated. Defaults are filled at that point, so rule code can read
the resolved value through `configuration("odin")`.

Use the imperative `configure()` API for dynamic or test-only configuration.
It remains useful when one JavaScript session deliberately changes settings
between test cases, but it should not be the normal form for static workspace
configuration.

### Configuration as a graph input

`configuration()` reads a value while the graph is built, which makes every
task that was constructed from it sensitive to any change in that namespace.
To narrow that, declare the configuration as a task input instead:

```js
import { semantic } from "imp:core";

const analysis = task({
    inputs: { sources, config: semantic.config("odin") },
    // ...
});
```

Only tasks that name the value are invalidated when it changes. The same
applies to `semantic.mode()`, `semantic.flag()`, and `semantic.args()`.

## Schema fields

The schema DSL provides the following descriptors:

```js
field.int({ default: 1 });
field.string({ required: true });
field.bool({ default: false });
field.enum(["debug", "release"], { default: "debug" });
field.object({
    output: field.string({ default: "build" }),
});
field.map(field.string(), field.string(), { default: {} });
```

Objects are closed: undeclared keys are rejected. Maps are open and validate
each key and value, which is appropriate for named things such as Odin
collections. Descriptors support `default` and `required`; enums enforce a
closed set of values.

Inspect the registered schemas and the resolved workspace configuration with:

```sh
imp config schema
imp config schema --effective
```

## Declarative `BUILD.js` files

`BUILD.js` files should export handles. They describe graph nodes; they should
not perform the build themselves:

```js
import { odinPackage } from "//rules/odin";

export const app = odinPackage({
    path: "app",
    collections: { lib: "vendor" },
});
```

Package-local options are appropriate when a target needs a local override.
Workspace-wide defaults belong in the rule's configuration namespace. A
separate target should represent a real graph node or output—not merely a
container for settings.

The `BUILD.js` author declares what to build. The rule's `task()` owns the
execution details: its declared inputs and outputs, tool resolution, and the
`exec.action()` calls that run real subprocesses.

## Keeping the user API small

The high-level user API documents declarations that belong in workspace or
`BUILD.js` files: toolchain factories, configuration schemas, rule factories,
and real output/artifact handles.

Acquisition, cache, path, and default-selection helpers are implementation
APIs. They remain available to rule authors and in the exhaustive
[JS code reference](../../reference/js-api/), but should not be presented as
normal build-file building blocks.
