+++
title = "Extending Imp"
weight = 20
extra = { sidebar_heading = true }
+++

Imp is extended in JavaScript. A rule package declares the targets and
products it supports; a workspace selects and configures those rules; and
`BUILD.js` files declare the graph that should be built.

The important distinction is that workspace and `BUILD.js` files should be
primarily declarative. Rule implementation code can be imperative, but users
should normally describe intent with exported target handles and configuration
objects.

## Rule packages

A rule package usually contains three layers:

- target constructors, such as `odinPackage()` or `cargoPackage()`;
- products, which implement operations such as `build`, `test`, or `package`;
- optional configuration schemas for workspace-wide settings.

For example, a package can declare its configuration schema next to its rule
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

## Workspace configuration

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

`BUILD.js` files should export target handles. They describe graph nodes; they
should not perform the build themselves:

```js
import { odinPackage } from "//rules/odin";

export const app = odinPackage({
    path: ".",
    srcs: ["**/*.odin"],
    collections: [
        { name: "vendor", path: "vendor" },
    ],
});
```

Package-local options are appropriate when a target needs a local override.
Workspace-wide defaults belong in the rule’s configuration namespace. A
separate target should represent a real graph node or output—not merely a
container for settings.

Products consume target handles and resolved configuration. The product owns
execution details such as `run()`, tool resolution, inputs, and outputs; the
`BUILD.js` author only declares the target.

## Keeping the user API small

The high-level user API documents declarations that belong in workspace or
`BUILD.js` files: toolchain factories, configuration schemas, target
constructors, and real output/artifact targets.

Acquisition, cache, path, default-selection, and product helper functions are
implementation APIs. They remain available to rule authors and in the
exhaustive JS reference, but should not be presented as normal build-file
building blocks.
