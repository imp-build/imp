# Luau authoring and module contract

**Status: Pilot.** This document describes the Luau runtime slice available in
the current Imp source tree. The existing JavaScript runtime remains the
default. Select Luau by adding `imp.workspace.luau` to the workspace root. A
workspace cannot contain both `imp.workspace.js` and `imp.workspace.luau`.

The pilot loads workspace `BUILD.luau` files and installed Luau rules. It
provides the `asset` and `resource_package` rules and runs their `build` tasks
through Imp's hermetic executor. The pilot does not migrate the complete rule
catalog, implement toolchain downloads, or provide all JavaScript workspace
configuration and introspection features. Treat other APIs and behavior in
this document as planned unless this section or a later section marks them
available.

## Current host capabilities

**Verified:** The current implementation is in
`crates/imp-engine/src/luau.rs`. This table records its public host surface and
the gaps that block catalog migration.

| Area | Current Luau behavior | Migration gap |
| --- | --- | --- |
| Module loading | Loads `@imp/core`, `@imp/rules/...`, and `@workspace/...`; caches canonical module values and rejects namespace escapes. | The full catalog and its loader-dependent workspace features are not migrated. |
| Workspace configuration | Loads `imp.workspace.luau`; on GitHub Actions it deep-merges `imp.workspace.ci.luau`. Luau rule modules can register schemas, read or write configuration, and expose schemas and resolved values to the CLI. | JavaScript and Luau use different field spellings. Luau configuration uses `snake_case`; the JavaScript runtime remains the default. |
| BUILD discovery | Walks the workspace for `BUILD.luau` files and evaluates returned tables. The `generate-build` goal of `@imp/rules/workflows/generate_build` writes and checks generated `BUILD.luau` files from registered Luau generators. | Language-specific generators must be ported to Luau before a Luau workspace can use them. |
| Graph construction | Exposes `files`, `glob`, `task`, `expand`, `output`, `native_tool`, `self_tool`, `tool`, `path`, `platform_info`, `package_path`, `goal`, `test_root`, and opaque handles. Tasks declare named `value` or `artifact` outputs. Expansions derive keyed children with goal slots such as `BUILD`, `PACKAGE`, and `TEST` from resolved inputs; `get()` selects one child and `all()` selects every child. `register_build_rule` and `register_build_generator` provide the Luau BUILD renderer interface. | Workspace graph introspection remains outside this slice. |
| Action execution | Runs hermetic argv actions with captured file-set and task-artifact inputs, declared file and directory outputs, native and acquired PATH tools, explicit environment settings, path resolution, fileset paths and digests (`exec.paths`, `exec.digest`), a cache toggle, and allow-failure actions with exit code, stdout, and stderr. Captured artifacts can flow to downstream tasks through named outputs. The `run` workflow can start one interactive program. | Broader toolchain conveniences are not available. |
| Tests and workflows | One generic driver runs every goal through the Luau workflow module that registers it with `core.goal`. Luau BUILD modules expose roots under the slot key of a registered goal. `imp package` publishes selected artifact roots under `dist/`, and `imp test` reports through `@imp/rules/workflows/test`. `@imp/rules/workflows/codegen`, `fmt`, `generate`, `generate_build`, `lint`, `lockfiles`, `publish`, and `run` register the `codegen`, `fmt` (with `--check`), `generate` (with `--check`), `generate-build` (with `--check`), `lint` (with `--fix`), `gen-lockfiles`, `publish`, and `run` goals. A `TEST` root can discover package-local `.test.luau` modules and run named cases and suites in fresh Luau runtimes. Test cases can resolve tasks and fake action runs, programs, the toolchain platform, goal flags, workspace writes, and digest diffs. | Mixed JavaScript/Luau test discovery is not available: one invocation runs one runtime. Luau has no label handles, target address API, or memo trace records (see "Not provided" below). |
| Installed rules | The tree contains Luau `asset`, `c`, `c/toolchain`, `c/gcc`, `c/cmake`, `c/generate_build`, `c/mold`, `c/msvc`, `c/zig`, `resource_package`, `oci`, `oci/toolchain`, `rust`, `rust/toolchain`, `rust/kache`, `rust/cargo_task_inputs`, `rust/workspace_expansion`, `rust/generate_build`, `workflows/build`, `workflows/codegen`, `workflows/fmt`, `workflows/generate`, `workflows/generate_build`, `workflows/lint`, `workflows/lockfiles`, `workflows/package`, `workflows/publish`, `workflows/run`, `workflows/test`, `workflows/report`, `imp/archive`, `imp/codegen`, `imp/generate`, `imp/lockfile`, `imp/native-tool`, `imp/self-tool`, and `imp/toolchain` modules. | Other packages, such as the Odin build generator, remain JavaScript; Luau workspaces cannot import those modules through the Luau loader. |

The shared C toolchain is the first consumer of `platform_info()`. C compiler
toolchains and Imp host rules are the first consumers of acquired tool handles,
path handles, and explicit action environment settings. The broader Tree-sitter
rule remains a later capability probe; its test and workspace requirements are
outside this host task.

The contract keeps Imp's graph values explicit across workspace files, BUILD
files, and rule modules. Every imported source has one stable identity, and
module ownership is clear from its address.

### Luau tests

A Luau BUILD module declares a test root by using the `TEST` slot of
`@imp/rules/workflows/test` in the exported value table:

```luau
local core = require("@imp/core")
local test = require("@imp/rules/workflows/test")

return {
    rule_tests = { [test.TEST] = core.test_root() },
}
```

The root discovers `.test.luau` files directly inside its BUILD package. A
nested package owns its test modules through its own BUILD module and test
root. Each test module returns an array of `core.test.case(name, fn)` values or
`core.test.suite(name, cases)` values. Imp runs each case in a fresh Luau
runtime in the Imp process. Imp evaluates each test module once to discover its
cases and again for each selected case, so keep module-level code declarative
and free of side effects. Test modules and cases do not run inside action
sandboxes. The case and suite structure follows the [Lute test guide](https://lute.luau.org/guide/writing-tests/),
but Imp uses its embedded host and does not invoke the Lute CLI.

Select a Luau test root with `imp test //pkg:rule_tests`. Add `--case NAME` to
run a named case or `--suite NAME` to run a named suite. These flags apply only
to Luau workspaces. A test root resolves to one `{ name, ok, output }` unit
for each case, and `@imp/rules/workflows/test` aggregates and reports the
units. Failures include the test module's canonical workspace address and
source location. If a filter matches no tests in the selected test roots, the
goal fails before the workflow runs.

A workspace root can contain `imp.workspace.js`, `imp.workspace.luau`, or
both. When it contains both, JavaScript is the default runtime. Set
`IMP_RUNTIME=luau` to select the Luau runtime, or `IMP_RUNTIME=js` to select
JavaScript. A selected runtime must have its workspace file, and another
value fails. One invocation uses one runtime: the JavaScript runtime loads
only `BUILD.js` modules, and the Luau runtime loads only `BUILD.luau`
modules. Luau test roots discover only `.test.luau` modules. JavaScript test
roots retain their existing `_test.js` discovery path.

**Verified:** this repository contains both workspace files. A port task adds
the `BUILD.luau` and `.test.luau` modules of its package and runs them from the
repository root:

```sh
# From the repository root, after `cargo build -p imp`:
IMP_RUNTIME=luau target/debug/imp test //rules/...
```

A Cargo build in the checkout reads `@imp/rules` from the checkout's `rules/`
directory. It finds that directory from the executable path, not from the
workspace. Set `IMP_RULES_DIR="$PWD/rules"` only for a build in a different
`CARGO_TARGET_DIR`. A workspace cannot supply `@imp/rules` modules. The
`luau::tests::repository_luau_workspace_tests_pass` test runs every Luau rule
test root (`core.test_root()`) of the repository, so
`imp test //crates/imp-engine:imp_engine` covers them. Product test roots that
need real toolchains, such as the CMake example ctest roots, run with
`IMP_RUNTIME=luau imp test //...`.

### Test host fakes

**Verified:** A running test case can replace host functions with test fakes,
so that it can run rule code without downloads, process runs, or workspace
writes. The `core.test` table provides these functions:

| Function | Effect | Replaces in JavaScript |
| --- | --- | --- |
| `core.test.resolve(handle)` | Runs a task or task output handle and returns its result table or output value. | `resolveGraphHandle(handle)` and the toolchain host `resolve(handle)` method |
| `core.test.with_fake_run(fn)` | Records each `exec.action` call instead of running it. | `withFakeRun`, and `globalThis.__host_run` patches such as `withFakeGraphRun` |
| `core.test.with_fake_toolchain_host([platform,] fn)` | Fakes `exec.action` as `with_fake_run` does, and replaces `platform_info()`. `platform` defaults to `{ os = "linux", arch = "x86_64" }`. | `withFakeToolchainHost` |
| `core.test.with_fake_write_workspace(fn)` | Records each `write_workspace` call instead of writing to the workspace. | `withFakeWriteWorkspace` |
| `core.test.with_fake_goal_flags(flags, fn)` | Makes `core.goal_flags()` return `flags`, a table of flag names to booleans. Calls `fn` with `flags`. | `withFakeGoalFlags` and `globalThis.__host_current_goal_flags` patches |
| `core.test.with_fake_diff(changes, fn)` | Makes `core.diff_digests` return a copy of `changes`, a list of `{ type, path }` entries, and records each call. | `withFakeDiff` and `globalThis.__host_diff_digests` patches |

Each `with_fake_*` function installs its fake, calls `fn` with a recorder
table, removes the fake, and returns the values that `fn` returns. Imp removes
the fake also when `fn` fails. A fake therefore applies only inside `fn`.
Later code in the same case, and every later case, uses the real host.

The recorder tables contain these fields:

- `runs`: one entry for each faked action, in call order. An entry has `argv`,
  `display`, `cache`, `allow_failure`, `env` (the action `env` table only),
  `input_count` (the number of `inputs` handles), `tools` (sorted tool names
  from the task inputs), and `outputs` (output name to declared path). A faked
  `core.run_program` call adds an entry with `program = true`, `argv` (with
  the program arguments), `display`, `env`, `inputs` (digests), and the run
  policy fields `impure`, `sandbox`, `workspace_cwd`, and `stream`.
- `set_run_stdout(display, text)`, `set_run_stderr(display, text)`, and
  `set_run_exit_code(display, code)` (run and toolchain host fakes only): set
  the status that a faked action or program with that `display` returns. The
  default is exit code 0 and empty output. A nonzero exit code fails the
  action, as the real host does, unless the action sets `allow_failure`.
- `calls` (toolchain host only): entries in call order. Imp records
  `{ "platform_info" }` for each `platform_info()` call. It records
  `{ "native_tool", name }` when a faked action receives a `native_tool()`
  handle through its task inputs, not when the handle is declared. It records
  `{ "named_cache", name, key }` for each faked action output that declares a
  named cache. The JavaScript `namedCache` entry records a cache lookup
  instead. It records `{ "self_tool" }` when a faked action receives the
  `self_tool()` handle through its task inputs. It records
  `{ "tool_dir", name, key }` for each `exec.tool_dir` call, with the named
  cache of the tool.
- `calls` (workspace writes): entries with `path`, `digest`, and `from`.
- `changes` and `calls` (digest diffs): `changes` is the list that each
  `core.diff_digests` call returns. `calls` has one `{ before, after }` entry
  for each call. A list with holes or other keys, a `type` that is not `added`,
  `removed`, or `modified`, or an entry without a `path` string, fails with `core.test.with_fake_diff changes
  must be a list of ...`.

A faked action does not stage inputs, look up native tools on `PATH`, read a
named cache, or call the execution service. It applies the same checks as the
real host to input handles, tool names, tool source artifacts, outputs, and
`env` values, in the same order. It returns placeholder artifact handles for
the declared outputs. `exec.path()` returns the declared path of a placeholder.
Inside a run or toolchain host fake, `exec.tool_dir(tool)` returns
`/cache/<name>/<key>` for the named cache of the tool, and does not read the
cache.
Downstream tasks in the same scope can use placeholders as inputs and tools.

Imp clears cached task and expansion results when a fake scope starts and when
it ends. Thus a task resolved inside the scope runs again against the fake, and
a task resolved after the scope runs again against the real host. Imp does not
clear values that `fn` returns. Do not give a placeholder artifact handle from
a fake scope to the real host.

**Illustrative example:** a `.test.luau` module in a package whose BUILD module declares a `TEST` root.

```luau
local core = require("@imp/core")
local output = core.output

local install = core.task({
    inputs = { cmake = core.native_tool("cmake") },
    outputs = { root = output.artifact() },
    run = function(exec)
        local platform = core.platform_info()
        local result = exec.action({
            argv = { "cmake", "--install", "build" },
            outputs = {
                root = output.directory(".imp/cmake", {
                    named_cache = { name = "cmake", key = platform.os .. "-" .. platform.arch },
                }),
            },
        })
        return { root = result.outputs.root }
    end,
})

return {
    core.test.case("installs cmake", function()
        core.test.with_fake_toolchain_host({ os = "linux", arch = "aarch64" }, function(host)
            core.test.resolve(install)
            assert(#host.runs == 1)
            assert(host.runs[1].tools[1] == "cmake")
            assert(host.calls[3][3] == "linux-aarch64")
        end)
    end),
}
```

Each function fails with a deterministic message when it is used incorrectly:

- A call outside a running `core.test.case`, for example at module level,
  fails with `<function> can only run inside a running core.test.case`.
- A fake that replaces a host function that another active fake already
  replaces fails with `<function> cannot run while another fake replaces the
  same host function`. `with_fake_run` and `with_fake_toolchain_host` replace
  the same action runner.
- A call from inside a task `run` callback or an expansion `create` callback
  fails with `<function> cannot run inside a task run or expansion create
  callback`. Install the fake in the case body, around `core.test.resolve`.
- A toolchain platform without non-empty `os` and `arch` strings fails and
  names the missing field. A platform table without a function fails with
  `core.test.with_fake_toolchain_host expects ([platform,] fn)`.
- `core.test.resolve` with a handle that is not a task or task output fails
  and names the handle kind. An argument that is not a handle, or a fake body
  that is not a function, fails with the Luau argument conversion error.

**Limits:** The fakes do not provide the JavaScript `setRunOutputFiles`
control. Placeholder artifacts of a faked action have no content that
`core.read_file_in_digest` can read. The JavaScript toolchain host also replaces
download, archive, checksum, cache, and worker host functions. Luau rules
express these steps as graph tasks and actions, so `with_fake_toolchain_host`
covers them through the action fake.

**Not provided:** Luau has no label handles, no target address API, and no
memo trace records. `core.memo` returns its function unchanged. Luau declares
graph roots with opaque handles, and a root gets its address from the BUILD
field that exports it, so rule code does not look up addresses. A rule that
needs its package directory uses the package context that the handle captures,
or `core.package_path()`. Memo trace records serve `--changed-since` only for
the JavaScript `memo()` and `target()` model; graph-native roots use graph
staleness instead. Thus there is no Luau replacement for
`__host_target_address` or `__host_memo_trace_write`, and the JavaScript
`label_test.js` and `memo_test.js` modules are not ported. There is no plan to
add `withFakeSelectedTargets` or `withFakeMergeDigests`, because no rule test
uses them.

### Goals and workflows

**Verified:** Goal policy is Luau rule code. The Rust host selects roots,
schedules and resolves them, and runs actions. It has no list of goal names.

A workflow module registers a goal with `core.goal(name, fn, options)` and
exports the slot key that the call returns. The slot key is the goal name in
upper case, with `-` changed to `_`. For example, `core.goal("build", fn)`
returns `"BUILD"`. A goal name uses lowercase letters, digits, and `-`, and a
runtime can register a name once. `options.flags` declares boolean CLI flags.
A flag cannot use the name of an option that every goal accepts, such as
`jobs`, `no-cache`, `case`, or `suite`. `options.selection = "none"` declares
a goal that takes no target selector, such as `generate-build`. Another
`selection` value fails with `core.goal('x') selection must be "none"`.

**Illustrative example:** a workflow module that declares a `check` flag,
similar to `@imp/rules/workflows/fmt`.

```luau
local core = require("@imp/core")

local function graph_fmt_goal(roots)
    local check = core.goal_flags().check
    -- ...
end

return {
    FMT = core.goal("fmt", graph_fmt_goal, {
        flags = { check = { description = "Verify formatting without writing changes" } },
    }),
}
```

A BUILD module exposes a root under a slot key in a target table, or as a bare
handle for `BUILD`. A slot holds a task, task output, or expansion handle. A
slot does not discover a table of named handles. Use one handle per slot;
a task may return named outputs, and a TEST task may combine unit and
doctest result lists. Named workflow-facet selection is tracked by
`2026-10-17-add-luau-named-workflow-facets`.
A `TEST` slot can also hold `core.test_root()`. Other values, such as tool
handles, are not roots. A Luau workspace offers only the goals that its loaded
modules register, so require each workflow module from `imp.workspace.luau` or
from the rule module that uses its slot key. Imp resolves slot keys after it
loads all BUILD modules, so the order of the modules does not change the
result. Imp reports these errors:

- A root under the slot of a goal that no module registers fails at load time
  with `<address> exports slot 'X', but no goal registers it; require
  @imp/rules/workflows/x`.
- A goal with no registered workflow fails with `goal 'x' has no registered
  Luau workflow; require @imp/rules/workflows/x`.

For each goal invocation, the driver resolves every selected root and calls the
goal function once with an array of `{ address, result }` entries. When no root
is selected, the driver does not call the goal function. A goal with
`selection = "none"` is the exception: the driver calls it once with an empty
array.

- A task output resolves to its value. A task with exactly one output resolves
  to the value of that output. Another task resolves to its output table.
- A `TEST` root resolves to its `{ name, ok, output }` units.
- Artifact handles in a result become `{ type = "artifact", digest, path }`
  tables.

A string that the goal function returns is the goal report, which Imp prints
after the progress display stops. These `@imp/core` functions serve workflow
modules:

| Function | Effect | JavaScript equivalent |
| --- | --- | --- |
| `core.goal_flags()` | Returns the flags of the running goal. Declared flags are booleans. For `test`, the table also holds the `case` and `suite` strings when they are set. Fails outside a goal invocation with `core.goal_flags() can only run while a goal executes`. | `goalFlags()` |
| `core.goal_error(message)` | Fails the goal with `message` as the full user-facing error, without a stack trace or engine context. If the goal catches this error and then raises a different error, Imp reports the different error with its full context. | `throw goalError(message)` |
| `core.run_args()` | Returns the CLI arguments after `--`, or an empty array outside a goal invocation. | `runArgs()` |
| `core.read_file_in_digest(digest, path)` | Reads one file from a CAS tree digest. | `readFileInDigest(digest, path)` |
| `core.diff_digests(before, after)` | Compares two CAS tree digests and returns a list of `{ type, path }` entries. `type` is `added`, `removed`, or `modified`. When all of a directory is added or removed, the list has one entry for the directory and no entries for its files. When a path changes between a file, a directory, and a symbolic link, the list has one `modified` entry for that path. | `diffDigests(before, after)` |
| `core.generate_build(check)` | Requires an active goal callback in both check and write modes; otherwise fails with `core.generate_build() can only run in a goal callback`. Runs the registered BUILD generators. When `check` is false, writes the changed `BUILD.luau` files. Returns `{ changed, checked }`: the paths that changed or are stale, and the paths that the generators produced. The workflow reports the result. In check mode, the workflow fails the goal when a path is stale. | None. The JavaScript runtime runs BUILD generators in its host. |
| `core.write_workspace(path, digest, { from? }?)` | Publishes a CAS artifact to the workspace. Requires an active goal callback; otherwise fails with `core.write_workspace() can only run in a goal callback`. A `core.test.with_fake_write_workspace` scope records calls outside goal callbacks without writing files. | `writeWorkspace` |
| `core.run_program({ argv, display?, env?, inputs?, tools? })` | Runs one interactive program and returns `{ exit_code, stdout, stderr }`. `inputs` holds digests or artifact tables to stage, and `tools` holds tool handles. The host sets the `run` policy: the program is impure and sandboxed, starts in the real workspace, streams its output, and receives `core.run_args()` after `argv`. A nonzero exit fails the call. Outside a goal function, the call fails with `core.run_program() can only run in a goal callback`, except in a `core.test.with_fake_run` scope. | `runFromTemplate(runTemplate(opts), { args: runArgs(), sandbox: true, workspaceCwd: true, impure: true, stream: true })` |

`exec.action({ allow_failure = true })` reports a nonzero exit code instead of
failing the task. When the task declares outputs, the result of `exec.action`
contains `outputs`, `exit_code`, `stdout`, and `stderr`. When the task declares
no outputs, `exec.action` returns `nil`. A failed action that allows failure
must still create its declared outputs, or the action fails.

A task can catch a failed action with `pcall(exec.action, request)`. When the
task then returns, the task succeeds. When the task raises an error, Imp
reports that error. Thus a rule can add context to an action failure, such as
the `imp goal gen-lockfiles` hint of `@imp/rules/imp/lockfile`.

### Task options

`core.task({ run, inputs?, outputs?, display?, cache? })` accepts only these
five keys. Unknown keys fail at declaration and the error names the key.
Option keys must be strings. `run` is the required callback; `inputs` and
`outputs` retain their graph contracts described below.

`display` is an optional string, including an empty string. An action uses
its own `display` when set, then the task's `display`, then its argv label.
Task labels do not add scheduler events or change graph identity.

`cache` is an optional boolean that defaults to true. Task `cache = false`
disables action caching for every action called through that task's `exec`.
An action's `cache = true` cannot override it. Action `cache = false`
disables caching even when the task permits it. The same effective options
apply in host fakes and real execution.

Task results remain reusable within an invocation and mode scope, including
when `cache = false`. Resolving multiple outputs does not repeat the task
callback. Task options do not change dependency tasks or interactive programs.

### Task and action outputs

Read the `output` table from `@imp/core`. A task declares named `output.value()` or
`output.artifact()` slots. Its `run(exec, inputs)` callback returns a table
with the same names. Value slots carry JSON-compatible data. Artifact slots
carry artifact handles returned by an action.

An action declares workspace-relative paths with `output.file(path)` or
`output.directory(path)`. A directory may also declare a named cache with
`output.directory(path, { named_cache = { name, key } })`. The execution
service captures outputs in CAS, writes named-cache outputs to the tool cache,
and returns artifact handles under `result.outputs`. A Luau named cache is
shared: every workspace on the computer uses one slot for each `name` and
`key`, as a JavaScript `namedCache({ shared: true })` does. Thus the key must
identify the contents, for example a version and a platform. A task may return one of
those handles from its matching artifact slot. A downstream task may declare
that task output in `inputs`; Imp executes the producer first and supplies the
resolved value or artifact handle to the consumer. When an action consumes an
artifact or path handle, Imp stages its CAS digest as an action input. Graph
actions keep outputs in CAS and do not write them into the workspace.

### Fileset paths and digests

A task reads a files handle from its `inputs` with these `exec` functions:

| Function | Effect | JavaScript equivalent |
| --- | --- | --- |
| `exec.paths(files)` | Returns the sorted workspace-relative paths of the fileset. | `exec.paths(fileset)` |
| `exec.digest(files)` | Returns the CAS tree digest of the fileset. The tree holds each file at its workspace-relative path. | `digestOf(fileset)` |
| `exec.digest(artifact)` | Returns the CAS tree digest of an artifact handle, for example a resolved task input or an output of an `exec.action` call in this task. The tree holds the artifact at its captured path, so `core.read_file_in_digest` can read files that the action wrote. | `artifact.digest` |

Imp captures each fileset one time in a task run. `exec.paths`, `exec.digest`,
and `exec.action({ inputs = ... })` use the same capture. Thus the paths and
the digest agree with the files that the action stages. The handle must be a
declared task input, or the call fails with `exec.paths(handle) requires a
declared task input`. A graph handle that is not a files handle fails with
`exec.paths(handle) requires a files handle`. `exec.digest` fails with the same
messages, with the prefix `exec.digest(handle)`, except that it also accepts
an artifact handle. An artifact handle needs no declaration as a task input.
A placeholder artifact of a faked action has no content in the CAS, so do
not read it with `core.read_file_in_digest`. In a `core.test.with_fake_run` scope, these functions still capture
the real workspace files.

A formatter for the `fmt` workflow uses these functions to fill its `FMT`
result. The task declares `paths`, `sources_digest`, `check`, and `output` as
`output.value()` slots and `formatted` as an `output.artifact()` slot. It sets
`paths` to `exec.paths(inputs.sources)` and `sources_digest` to
`exec.digest(inputs.sources)`. The action formats the sources in place and
declares the source root as an `output.directory()`. Thus `formatted.digest`
holds the same workspace-relative paths as `sources_digest`.

### Dynamic graph expansion

Use `expand()` when task output names graph children that Imp must select
separately. The `create` callback receives resolved inputs and returns a table
keyed by child name. Each child table may contain graph handles under goal
slot keys such as `BUILD`, `PACKAGE`, or `TEST`. Use `get()` to select one
child or `all()` to select the children as a group:

**Illustrative example:**

```luau
local expansion = core.expand({
    inputs = { metadata = discovery.outputs.metadata },
    create = function(inputs)
        local children = {}
        for name in pairs(inputs.metadata.targets) do
            children[name] = {
                BUILD = buildTarget(name),
                PACKAGE = packageTarget(name),
            }
        end
        return children
    end,
})

return {
    targets = {
        BUILD = expansion:all(core.BUILD),
        PACKAGE = expansion:get("app", core.PACKAGE),
    },
}
```

A task can also declare an `expansion:get(key, workflow, facet?)` handle
as an input. Before the task runs, Imp resolves the expansion, runs the
selected child, and gives the task the value of the child, as it does for a
task output. For example, `@imp/rules/c/cmake` gives a discovered CMake
library to `cc_binary` this way. Only a top-level input of the task is resolved, and the child must be a
task or task output. A missing child fails the task with
`expansion has no child '<key>'`. An `expansion:all()` handle fails as a task
input.

Selecting an aggregate root also makes each child addressable as
`<target-address>#<child-key>`. Imp resolves only expansions reachable from
selected targets. It resolves expansion inputs before it dispatches child
tasks, so children that use the same producer share its result during one
goal invocation. `imp package` publishes artifact outputs from selected
`PACKAGE` roots under `dist/`, using the JavaScript package workflow's naming
rules.

### Tool, path, platform, and environment APIs

`platform_info()` returns the host `os` and `arch` values used for toolchain
selection. `native_tool(name)` returns a tool handle for an executable on the
host `PATH`. `self_tool()` returns a tool handle for the running Imp
executable, with the tool name `imp`. Imp resolves both when an action runs,
and keys the tool on the canonical path and content digest of the
executable. `path(artifact_output)` and `tool(artifact_output, options)` create
opaque handles from declared task artifact outputs. Each handle captures the
active BUILD package context and has a stable graph identity for equivalent
declarations in that package. Tool options require `name` and may set
`bin_dirs`, which defaults to `{ "." }`. A tool source must be a directory
artifact with a named-cache declaration.

Pass tool and path handles through a task's `inputs`. The tool handle makes the
cached tool available on the sandbox action's `PATH`. `exec.path(path_handle)`
returns the artifact's workspace-relative path inside the sandbox; include the
same path handle in `exec.action({ inputs = ... })` to stage the artifact.
`exec.tool_dir(tool_handle)` returns the absolute host directory of the named
cache that holds the tool. The task must declare the tool handle as an input,
and the call fails for another handle. Use it only when a program needs an
absolute host path, for example a linker directory in compiler flags. An
action that runs the tool needs only the tool handle in its inputs.
`exec.action({ env = { NAME = "value" } })` adds explicit environment values
to the action. These values are part of the action environment and cache key.
Lockfile selection, checksum verification, downloads, and archive extraction
remain rule-module policy built from graph tasks and actions.

`@imp/rules/imp/toolchain` keeps the declared versions and the default
version of each toolchain kind (`define(name)`), and `bin(exec, tool, {
sub_dir, exe })` joins an executable name onto `exec.tool_dir`.
`@imp/rules/imp/lockfile` `lockfile_for(kind, version, fallback)` returns the
lockfile address of a declared version. `@imp/rules/c/mold` is the first
toolchain module that uses them. `@imp/rules/c/gcc`, `@imp/rules/c/zig`, and
`@imp/rules/c/msvc` use them too. Their compiler providers pass tool handles
through `task_inputs()`. The gcc and NASM path functions read absolute paths
with `exec.tool_dir`. The
MSVC provider runs the host programs where Visual Studio installed them: its
action `env` puts their directories on `PATH`.

**Not provided:** Luau has no general handle resolution outside test cases
and no `cache_get`. A task gets an installed toolchain path through a declared
tool input and `exec.tool_dir`. There is no `Toolchain` class with a `bin()`
product, so `imp @tool` does not dispatch to a Luau workspace. There is no
`toolchainToolSpec`: a tool handle is the `tools` entry of `exec.action` and
`core.run_program`.

These `@imp/core` functions serve rule modules at declaration time and in task
callbacks:

| Function | Effect | JavaScript equivalent |
| --- | --- | --- |
| `core.read_file(address)` | Returns the text of a file, or `nil` when the file does not exist. The address must start with `@workspace/` or `@imp/rules/`. Another address fails with `core.read_file('x') requires an @imp/rules/ or @workspace/ address`. Imp removes `.` and `..` parts from the path. An absolute path, or a path that resolves outside its namespace root, fails. This includes a symbolic link to a file outside the root. There is no override: a workspace file does not replace an `@imp/rules/` file. | `readAddressedFile(address)` |
| `core.json_decode(text)` | Decodes JSON text to a Luau value. Arrays become tables with indexes from 1, and JSON `null` becomes `nil`. Text that is not JSON fails with `core.json_decode: <reason>`. | `JSON.parse(text)` |
| `core.log_warn(message)` | Writes `message` as a warning to the Imp log. | `logWarn(message)` |

**Illustrative example:**

```luau
local core = require("@imp/core")
local output = core.output
local install = core.task({
    inputs = {
        sh = core.native_tool("sh"),
        mkdir = core.native_tool("mkdir"),
        chmod = core.native_tool("chmod"),
    },
    outputs = { root = output.artifact() },
    run = function(exec)
        local result = exec.action({
            argv = {
                "sh", "-c",
                "mkdir -p .imp/tool && printf '#!/bin/sh\\nexit 0\\n' > .imp/tool/example && chmod +x .imp/tool/example",
            },
            outputs = {
                root = output.directory(".imp/tool", {
                    named_cache = { name = "example-tools", key = "1.0/linux-x86_64" },
                }),
            },
        })
        return { root = result.outputs.root }
    end,
})
local tool = core.tool(install.outputs.root, { name = "example" })
local root_path = core.path(install.outputs.root)
local check = core.task({
    inputs = { example = tool, root = root_path },
    run = function(exec, inputs)
        assert(exec.path(inputs.root) == ".imp/tool")
        exec.action({
            argv = { "example" },
            inputs = { inputs.root },
        })
    end,
})
```

The example shows host handle declarations. A rule module must build or
acquire the tool directory and name the cache key from its pinned version and
platform data before it declares the tool handle.

**Illustrative example:**

```luau
local core = require("@imp/core")
local output = core.output

local generate = core.task({
	outputs = { source = output.artifact() },
	run = function(exec)
		local result = exec.action({
			argv = { "sh", "-c", "printf generated > generated.txt" },
			outputs = { source = output.file("generated.txt") },
		})
		return { source = result.outputs.source }
	end,
})

local consume = core.task({
	inputs = { source = generate.outputs.source },
	outputs = { status = output.value() },
	run = function(exec, inputs)
		exec.action({
			argv = { "sh", "-c", "test -s generated.txt" },
			inputs = { inputs.source },
		})
		return { status = "ok" }
	end,
})
```

## Module addresses

Luau modules use `require()` with one of three absolute address namespaces:

| Address | Owner | Source |
| --- | --- | --- |
| `@imp/core` | Imp runtime | Host APIs and opaque graph handles |
| `@imp/rules/<path>` | Imp distribution | The installed rule tree beside the executable |
| `@workspace/<path>` | Current workspace | A source below the workspace root |

The namespaces do not overlap. `@imp/rules/...` always resolves in the
installed rule tree. This changes the current JavaScript loader, where a
workspace file at `//rules/...` takes precedence over the installed rule. A
workspace that needs different behavior must use its own `@workspace/...`
module and import or wrap the installed rule explicitly. It cannot replace the
installed source by copying a file to the same relative path.

The root workspace BUILD module is `@workspace/BUILD`. Other workspace BUILD
modules use `@workspace/<package>/BUILD`. The workspace configuration module
is `@workspace/imp.workspace`. On GitHub Actions, the loader also evaluates
`@workspace/imp.workspace.ci` when `imp.workspace.ci.luau` exists. Both
modules may return a table keyed by registered configuration namespace; the
CI table deep-merges over the workspace table. Rule modules register their
namespaces before the workspace configuration is validated.

## Build modes

Rule authors can declare mode axes and named profiles through `@imp/core`.
Require `@imp/rules/imp/mode` from the workspace module to register the `opt`
axis and the `default` and `release` profiles.

| API | Arguments | Result |
| --- | --- | --- |
| `define_mode_axis(name, options)` | A namespace name and the option table below. | Registers an axis. |
| `define_profile(name, values)` | A namespace name and a table of axis names to string values. The optional `odin` entry contains a `defines` table of non-empty names to strings. | Registers a named profile. Profiles may precede their axes. |
| `semantic.mode(name)` | A non-empty axis name. | Declares a task, expansion, or program input. The input resolves to the axis value during invocation. An undeclared axis resolves to `nil`. |
| `configured(handle, overrides)` | A graph handle and a non-empty table of declared rebuild axes to valid string values. | Pins the axes on that dependency and forwards its named outputs. |

The `define_mode_axis` option table has these fields:

| Field | Required | Value |
| --- | --- | --- |
| `kind` | Yes | `"rebuild"` or `"output-select"`. `configured()` accepts rebuild axes only. |
| `["default"]` | Yes | A string. Use brackets to match the JavaScript option name. |
| `values` | No | A list of allowed strings. When present, it must include the default. |

From a workspace that declares these modes, use `imp build //:app --profile
release` or `imp build //:app --axis opt=release`. CLI axis values override
the selected profile. The selected profile overrides axis defaults. No
profile is selected when `--profile` is absent. Repeated `--axis` entries use
the last value for each axis. Imp validates all declared profiles before
selection or discovery. The `imp.mode` configuration namespace is reserved;
use axis declarations instead of `configure("imp.mode", ...)`.

`configured()` applies its overrides to the dependency subtree. Nested calls
use the outer value when both calls set the same axis. A task runs once for
each distinct set of effective values of the axes its inputs read. A task
that reads no axes stays shared. Pinned axes do not make consumers vary with
the invocation's value of those axes. Action cache keys use the same axis
values. Expansion discovery reads its own inputs; selected children can read
additional axes. Discovery and goal execution share results within one
invocation.

Task and program callbacks can pass declared tool and path handles to their
`exec` helpers. Imp binds those handles to the callback's effective mode.
Configured test roots pass their pinned modes to discovery and each test
case. Each case receives an independent copy of the workspace configuration
and profile overrides.

**Illustrative example** for a rule module:

```lua
local core = require("@imp/core")
require("@imp/rules/imp/mode")

local leaf = core.task({
    inputs = { opt = core.semantic.mode("opt") },
    outputs = { text = core.output.value() },
    run = function(_exec, input)
        return { text = input.opt }
    end,
})
local release = core.configured(leaf, { opt = "release" })
```

From this repository's root, run `IMP_RUNTIME=luau imp build
//rules/imp/config/example:probe`. The probe combines the ambient leaf, a
release leaf, and a task that reads no axes. With the default mode, its report
is `leaf:debug|leaf:release|shared:none`. The leaf runs twice and the shared
task runs once. With `--profile release`, the two leaf dependencies share one
execution.

## Workspace configuration

Luau rule modules use `define_config_schema(namespace, shape)` to register a
namespace. The `field` table provides `int`, `string`, `bool`, `enum`,
`object`, `map`, and `array` descriptors. Descriptor options are `default` and
`required`. Configuration fields use `snake_case`, even when the matching
JavaScript field uses `camelCase`.

The Imp-owned `imp` namespace accepts `js_workers` (JavaScript workers),
`jobs`, `fs_jobs`, `passthrough_env`, and `log_level`. The `cache` namespace
accepts `gc_max_age_days`. These retain the JavaScript runtime's behavior.
The JavaScript runtime continues to use `jsWorkers`, `fsJobs`,
`passthroughEnv`, `logLevel`, and `gcMaxAgeDays`.

Workspace configuration returns one table with namespace names as keys. The
loader validates declared fields, applies defaults, and reports the source
module address and field path for invalid values. `configure(namespace,
value)` merges a value into a namespace. `configuration(namespace, fallback)`
reads it. `configuration_schemas()` returns the schemas registered by loaded
rule modules.

Run `imp config schema` to print registered schemas. Add `--effective` to
include the resolved workspace configuration. CLI option names use
`kebab-case`; existing option names remain unchanged.

An address is a slash-separated path. It may omit `.luau`; if present, the
resolver removes that suffix before checking these source forms in order:

1. `<path>.luau`
2. `<path>/index.luau`
3. `<path>/BUILD.luau`

The empty workspace path resolves to the root `BUILD.luau`. The `@imp/core`
module is provided by the host and does not resolve to a file.

Relative `./` and `../` imports resolve from the importing source file. They
retain its namespace: a relative import from `@workspace/app/main` stays under
`@workspace`, and one from `@imp/rules/rust` stays under `@imp/rules`. The
resolver removes `.` segments and resolves `..` segments before loading. It
rejects an import that escapes its namespace root, an absolute filesystem path,
or an unsupported bare module name.

## Canonical identity and cache

The resolver first maps an address to one source file. It then forms the
canonical module address from the namespace and the resolved, root-relative
source path, without the `.luau` suffix. Thus a directory import and an
explicit relative import that select the same `index.luau` share one module
value. A direct source, an index source, and a BUILD source remain distinct
when they are different files.

The canonical module address is also the module cache key. Equivalent
spellings, including optional `.luau` suffixes and normalized relative paths,
must return the same module value within one runtime. Workspace and installed
rule sources remain distinct even when their relative paths match. The cache
uses logical addresses, not absolute host paths, so it does not change when a
checkout moves.

## Generated BUILD modules

Luau rule modules may register a BUILD renderer with
`core.register_build_rule({ rule, module, export })`. `module` must name a
file-backed `@imp/rules/...` or `@workspace/...` module. `export` defaults to
`rule`.

Register a generator with
`core.register_build_generator({ namespace, generate })`. The namespace must
have a `build_generate` boolean configuration field. Imp runs the generator
only when that value is true. The callback returns a table keyed by
workspace-relative `BUILD.luau` paths. Each value is an array of
`{ name, rule, props }` targets. A callback may instead return a task
value-output handle. Imp resolves that output through the task executor and
uses its value as the same declaration table. This lets a generator use
sandboxed discovery tools with declared toolchains and inputs. A task handle,
artifact output, or other handle fails before rendering. A failed discovery
task stops generation before any BUILD file is written. Imp merges targets
from all enabled generators before it renders each file.

Require `@imp/rules/workflows/generate_build` from `imp.workspace.luau` to
register the `generate-build` goal. Run `imp goal generate-build` to write
generated files. Run `imp goal generate-build --check` to report stale files
without writing. The goal fails when a file is stale.
Generated files have an Imp header and Imp refuses to replace a hand-written
file at the same path. Target names and registered exports must be Luau
identifiers. The loader discovers generated files through the same canonical
`@workspace/<package>/BUILD` addresses as hand-written BUILD modules.

Resolution errors identify the importing canonical address, requested
specifier, and the import call's source location when available. Source
locations use the canonical source address with line and column. Parse and
runtime errors identify the address and line and column in the source that
failed. Errors must name the namespace root that was searched. A missing
installed rule is reported as an installed rule lookup failure; the resolver
does not silently substitute a workspace module.

## Module values and graph declarations

Each module returns exactly one value. A module with named exports returns a
table. Rule modules expose public functions, configuration, and intentional
registration values as named fields in that table. Private helpers remain
private to their source module.

Workspace and BUILD modules return tables whose named fields declare graph
roots. A graph root is an opaque userdata value created by `@imp/core` or a
rule factory. The host reads the field name as the exported target name; it
does not inspect or serialize the userdata. A module may also export ordinary
values used to configure other declarations, but those values are not graph
roots.

Each BUILD module evaluates with a package context set to its own workspace
directory. An imported BUILD module uses its own context while it evaluates;
after it returns, the importing module's context is restored. An ordinary
workspace or rule module has no package context by itself. A helper called
during BUILD evaluation sees the active BUILD caller's context, regardless of
which module defines the helper. A graph factory captures that context when it
creates a handle, so deferred behavior keeps its declaration context after
module evaluation and across async calls. Code outside BUILD evaluation or a
recorded callback cannot query the active BUILD package context.

Target addresses are derived from the BUILD module that exports a graph root,
not from the module that created the handle. Re-exporting a handle under a
different BUILD module therefore changes its target address, while source
paths already captured by the handle keep their original package context.

Closures are Luau functions. Rule APIs may accept a closure for deferred graph
behavior, and the closure may capture graph userdata created during module
evaluation. Inline custom rule behavior is written as a Luau closure and passed
to the rule API that consumes it. The contract does not evaluate source strings
as code.

Relative imports are the supported way to share workspace-owned helpers or
private rule implementation modules. Rule implementations import other
installed rules through `@imp/rules/...`; workspace code imports selected
installed rules through that same address form.

## Option tables and language boundary

APIs that take a group of optional or named arguments use one Luau table.
Public option keys use `snake_case`. Each API documents which fields are
required and which defaults it applies.

The migration preserves Imp's graph model, rule ownership, loader boundaries,
and asynchronous host operations. It does not preserve JavaScript or ESM
language semantics. Authors must convert JavaScript source to Luau. In
particular, the contract provides no JavaScript globals, prototypes,
`import`/`export` syntax, or JavaScript Promise interop. Luau modules use
`require()` and return values; asynchronous host operations use the Luau
runtime's supported async calls. Imp does not add npm-style bare-package
lookup; imports use the explicit Imp and workspace addresses defined above.

## Available asset API

The installed module `@imp/rules/asset` exports `asset(options)` and
`resource_package(options)`. Both accept `srcs`, with optional `base`, `path`,
and `exclude` fields. The module returns `sources`, `BUILD`, and (for
`resource_package`) `files`. `srcs` contains workspace-relative glob patterns.
`asset` accepts an empty source list at declaration time; `resource_package`
requires at least one pattern.

The `BUILD` task declares the host `sh` executable and runs `sh -c true` with
the matched files as inputs. This verifies graph loading and hermetic action
execution. It does not create a bundle or output file. The asset rule disables
action caching. `native_tool("sh")` resolves an executable already on `PATH`;
it does not download or provision a toolchain.

```lua
local asset = require("@imp/rules/asset")

return {
	assets = asset.asset({ srcs = { "*.png", "*.svg" } }),
}
```

## Planned behavior

The following example shows planned APIs. It is not runnable with the current
pilot.

```lua
local imp = require("@imp/core")
local rust = require("@imp/rules/rust")
local shared = require("./shared")

local app = rust.cargo_package({
	path = "app",
	toolchain = shared.toolchain,
})

return {
	app = app,
	check = imp.task({
		inputs = { app = app },
		run = function(ctx)
			return shared.check(ctx, app)
		end,
	}),
}
```

The host API spellings in this example are illustrative. The pilot currently
provides only the APIs needed by the asset rule and build workflow.

In this example, `app` and `check` are graph roots because their values are
opaque graph handles. `shared` is workspace-owned because the relative import
inherits the importing module's `@workspace` namespace. Option-table keys use
`snake_case`; the Luau closure is passed as a function value.

### Rust toolchains and persistent workers

`@imp/rules/rust/toolchain` declares Rust with
`rust_toolchain(version, options)`. Versions must be exact `MAJOR.MINOR.PATCH`
pins. `graph_toolchain(version)` returns `tool`, `cargo_home_tool`,
`rustup_home`, `cargo_home`, `toolchain_id`, and `version`. Declare both tool
handles as task inputs. `graph_tool_env(exec, rustup_tool, cargo_tool, id,
version, kache_active)` returns an `env` table. Kache mode uses stable absolute
named-cache paths. Options include `default`, `unverified`, `lockfile`,
`link_driver`, `linker`, and `kache`.

`@imp/rules/rust/kache` declares Kache with `kache_toolchain(version, options)`.
Its graph value has `tool` and `data_tool`. Declare both as task inputs before
calling `build_cache_env(exec, tool, data_tool, options)`. This function starts
the persistent daemon and returns the Cargo environment. `cache_size` defaults
to `4GiB`. The `kache.cache_executables` configuration field defaults to false.
Both daemon and client use local caching only. The downloaded tool is shared;
the mutable data cache belongs to the workspace. `script_preamble()` sets
`KACHE_BASE_DIR` from the caller's `imp_sandbox_root` shell variable.

`exec.worker_start(name, { argv, env, health_check_argv })` starts or reuses a
worker through the execution service. Call it only in a task or cache-details
callback. The executable and health-check executable must be absolute paths
inside declared tool inputs. Worker names use ASCII letters, digits, `-`, and
`_`. `env` maps names to strings. The result has `home_dir`, `tmp_dir`, and
`port`. The worker uses stable workspace directories and can outlive Imp.
Startup and health-check failures fail the caller.

`core.named_cache_details({ name, inputs, caches, run })` registers statistics
for `imp cache stats --details`. `inputs` maps names to acquired tool handles.
For each input, `caches` gives `{ name, key, shared }`; `shared` defaults to true.
These bindings permit a fresh runtime to inspect installed tools without
executing acquisition tasks. Imp skips the callback if any bound cache is
absent. `run(exec, inputs)` returns a string or `nil`. Its actions disable
caching and permit failure, so the callback must check `exit_code`. Callback
errors produce warnings. Kache starts its daemon before it queries statistics.

The toolchain fake records `worker_start` calls in `calls`. Both run and
toolchain fakes record them in `workers`; setting `worker_error` makes startup
fail. `core.test.cache_details(name, seeded)` invokes a callback inside a
running test with a toolchain fake. False simulates missing caches; true binds
all inputs to fake cache directories. These fakes do not start a worker.

`core.output.directory(path, { named_cache = { name, key, shared } })` accepts
`shared = false` for workspace-owned mutable state. The default remains true.
`core.builtin_files({ root, include, exclude })` captures files from the
installed rules directory. Its paths are relative to that directory. Workspace
files do not replace installed files. The Cargo input module uses this API for
`builtin_cargo_manifest_sources`; ordinary `cargo_manifest_sources` reads the
workspace. Cargo input bindings use one-based suffixes, for example `dep1`.

These Luau modules omit local cache imports, legacy `run` tool descriptors,
and `imp @tool` dispatch. The Rust graph rules and BUILD generator remain a
separate migration task.

## Graph-backed programs

For rule authors, `core.program({ inputs, describe })` declares an interactive
program for a `RUN` slot. The host resolves its input tasks before it calls
`describe(exec, inputs)` with the captured package context. The callback returns
`{ argv, env?, display?, inputs?, tools? }`. `argv` is non-empty; `env` maps
names to strings; description `inputs` contains digest strings. `tools` contains
live tool handles declared in the program inputs. Omitted description `inputs`
and `tools` default to empty lists. The host rejects a missing or empty `argv`
and invalid field types before the run goal can launch the program. Handles do not pass
through JSON task outputs.

The callback can use `exec.path`, `exec.paths`, `exec.digest`, and
`exec.tool_dir` to inspect resolved inputs. It cannot execute actions, start
workers, declare graph nodes, or launch a program. A program is a run root;
it cannot be an ordinary task input or another workflow root. It has no named
outputs. `core.test.resolve(program)` returns its description without launching
it, for focused tests.

The run goal launches the program after description resolution. It stages all
input digests, mounts the declared tools, streams output, passes CLI arguments,
and propagates failure. The interactive program is not action-cached. Existing
executable artifacts and single-digest descriptions remain valid run roots.

### OCI images and Crane

`@imp/rules/oci` provides `oci_pull`, `oci_build`, `oci_push`, and
`oci_mirror`. Images expose `image.layout`, `image.digest`, `BUILD`, and
`PACKAGE`; publication exposes only `PUBLISH`. Registry tag lookup and
publication use uncached actions. Layer and layout artifacts are explicit
action inputs. Local composition retains the single `linux/amd64` image
format and requires POSIX tools, GNU tar, `jq`, and `sha256sum`.

`@imp/rules/oci/toolchain` follows the version declaration, graph tool, and
`GEN_LOCKFILES` contract. Crane defaults to `0.22.1`; `crane_bin(exec, tool)`
returns its installed executable path inside a task. See the
[OCI guide](../../rules/oci/DOC.md) for options and validation commands.
Generated Luau reference extraction remains part of workspace integration.
