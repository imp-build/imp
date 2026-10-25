+++
title = "Writing build files"
weight = 4
template = "page.html"
+++

This page is for BUILD authors who declare targets and sandboxed actions.
Each `BUILD.luau` module returns a table. Its keys become target names.

## Declare a target

**Illustrative example**

```luau
local c = require("@imp/rules/c")
return { app = c.cc_binary({ srcs = { "main.c" } }) }
```

The target above has address `//:app` in the root package, or `//pkg:app` in
`pkg/BUILD.luau`. Import an existing target with `require("@workspace/pkg/BUILD").app`.
Graph dependencies are explicit handles. There is no global product registry.

## Declare an action graph

**Illustrative example**

```luau
local core = require("@imp/core")
local build = require("@imp/rules/workflows/build")
local copy = core.task({
    inputs = {
        source = core.files({ paths = { "input.txt" } }),
        cp = core.native_tool("cp"),
    },
    outputs = { file = core.output.artifact() },
    run = function(exec, input)
        local result = exec.action({
            argv = { "cp", "input.txt", "output.txt" },
            inputs = { input.source },
            outputs = { file = core.output.file("output.txt") },
        })
        return { file = result.outputs.file }
    end,
})
return { copied = { [build.BUILD] = copy.outputs.file } }
```

Declare source and tool handles in task inputs. The callback receives their
resolved values. Declare every action output, then return captured artifacts
through matching task outputs. `exec.paths` lists a file set, `exec.digest`
gets its captured digest, and `exec.path` resolves an artifact or path handle.

Tasks are cached. An action runs in a sandbox with declared inputs and tools.
Its working directory is the sandbox root. `build` warms the cache; `package`
publishes declared artifacts under `dist/`. Do not write repository files from
a task callback. Use the generate workflow for committed generated files.

A task accepts `inputs`, `outputs`, `run`, `display`, and `cache`. Unknown
options fail at declaration. `exec.action({ cores = n })` requests a core
budget; the default is one. Action results use `exit_code`, `stdout`, and
`stderr`. `allow_failure = true` permits a nonzero exit, but declared outputs
must still exist.

## Select dynamic children

`core.expand({ inputs, create })` creates named children from resolved graph
inputs. Use `expansion:get(key, workflow)` for one child or
`expansion:all(workflow)` for every child. An all-child projection is a workflow
root, not an ordinary task input. Children must supply the requested workflow
handles. Use separate child membership for optional workflows.

## Report failures

Raise `error(message)` for an action or rule error. Workflow callbacks can use
`core.goal_error(message)` for a complete user-facing diagnostic without an
engine stack trace. Preserve useful output from a failed tool.

See the [Luau code reference](/reference/luau-api/) for host methods and the
[User API reference](/reference/user-api/) for public rule declarations.
