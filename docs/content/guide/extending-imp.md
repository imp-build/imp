+++
title = "Extending Imp"
weight = 20
extra = { sidebar_heading = true }
+++

This page is for rule authors who add reusable Luau graph declarations.
A rule module returns functions and values. BUILD modules call its public
factories and keep the returned handles as explicit dependencies.

## Return workflow roots

**Illustrative example**

```luau
local core = require("@imp/core")
local build = require("@imp/rules/workflows/build")
local function bundle(options)
    local sources = core.files({ include = options.srcs })
    local task = core.task({ inputs = { sources = sources }, run = function(exec, input)
        exec.digest(input.sources)
    end })
    return table.freeze({ sources = sources, [build.BUILD] = task })
end
return { bundle = bundle }
```

Construct handles when the rule is declared. Task callbacks resolve declared
inputs and run sandboxed actions. They do not register new graph declarations.
Use `core.expand` when resolved inputs must determine child declarations.
Do not expose an empty workflow slot. Keep optional workflows in an expansion
whose child membership represents whether that workflow exists.

## Declare configuration

**Illustrative example**

```luau
local core = require("@imp/core")
core.define_config_schema("bundle", {
    enabled = core.field.bool({ default = true }),
})
local settings = core.configuration("bundle")
return { enabled = settings.enabled }
```

Schemas support strings, integers, booleans, enums, objects, maps, and arrays.
Read configuration before constructing tasks. Put values that affect a task's
result in its declared inputs or action description.

## Use toolchain handles

Use `core.native_tool(name)` for an explicit host prerequisite. Use
`core.self_tool()` to invoke Imp. Acquired tools use `core.tool(artifact, { name,
bin_dirs })`; the artifact must come from a declared named cache. Put the tool
handle in task inputs. The action environment includes its declared bin
paths. See [Toolchains and caches](../toolchains-and-caches/).

The helpers in `@imp/rules/imp/toolchain`, `@imp/rules/imp/lockfile`, and
`@imp/rules/imp/archive` declare versions, verify locked downloads, and extract
tools. Register CLI resolution through the toolchain helper's registry.

## Register BUILD generation

Use `core.register_build_rule` to associate a rule name with its public module
and export. Use `core.register_build_generator` for the namespace and generator
callback. Generators return declarations, not source strings. Keep generation
separate from the rule factory.

Document public functions with `---` comments and `@param`, `@returns`, and
`@category` tags. Use `target` or `configuration` for user-facing declarations;
use `api` for implementation exports. Re-exports retain the definition's docs.
See [Rule module structure](../rule-module-structure/).
