# Workflow rules

Workflow rules connect graph roots to Imp goals. They define the behavior of
`build`, `codegen`, `fmt`, `generate`, `generate-build`, `gen-lockfiles`,
`lint`, `package`, `publish`, `run`, `test`, and `vs`.

## Public API

Users select these workflows with the `imp` command and target selectors. Rule
authors normally consume the goal symbols indirectly through the computed
workflow properties on a target. The graph callback exports and status-report
helpers are implementation APIs, not BUILD constructors.

Important boundaries:

- `build` warms the graph and task cache. It writes no files into the workspace.
- `codegen` publishes selected `codegen()` outputs under `dist/codegen/`.
- `package` publishes graph artifacts under `dist/`.
- `fmt`, `lint`, and `generate` publish workspace changes only at their goal
  boundary; their graph tasks remain sandboxed.
- `publish` is explicitly registry-mutating and must be selected by the user.

See the guide pages for command procedures and the rule-family guides for the
workflow handles each target provides.

## Luau workflow modules

**Verified:** on 2026-10-24, `@imp/rules/workflows/build`, `codegen`, `fmt`,
`generate`, `generate_build`, `lint`, `lockfiles`, `package`, `publish`, `run`,
`test`, and `vs` have Luau modules beside the JavaScript modules. JavaScript stays
the default runtime of this repository. To use the Luau modules here, select
the Luau workspace with `IMP_RUNTIME=luau`, as
`docs/design/luau-authoring-contract.md` describes.

Each module registers its goal with `core.goal` and exports the slot key:
`BUILD`, `CODEGEN`, `FMT`, `GENERATE`, `GEN_LOCKFILES`, `LINT`, `PACKAGE`,
`PUBLISH`, `RUN`, `TEST`, or `VSCODE`. A BUILD module puts a root under that slot key.
Rule modules give these result shapes. Luau result fields use `snake_case`:

| Slot | Root result |
| --- | --- |
| `CODEGEN` | The generator task of a `codegen()` result. It resolves to one artifact for each output path. |
| `GENERATE` | A `generated_files()` result. It resolves to one artifact for each output path and a `before` workspace digest. |
| `FMT` | `{ paths, sources_digest?, formatted?, check?, output? }`. `check` is `{ requested, failed }`. `formatted` is an artifact. |
| `GEN_LOCKFILES` | A `graph_generate_tool_lockfile()` task. It resolves to `{ lock, path, lockfile }`: the lock contents, the workspace path, and the lockfile artifact. A Python project lock resolves to `{ kind = "python-project-lock", project, path, lockfile }`. |
| `LINT` | `{ ok, output?, paths?, fixed?, fix_applied? }`, or a table with that table in its `result` field. `fixed` is an artifact with the fixed sources under `fixed/`. |
| `PACKAGE` | One artifact. The goal writes it to `dist/<package>/<target>`, or to `dist/<package>/<filename>` for a shared library. |
| `PUBLISH` | A task whose actions change a registry. The goal reports the selected roots. |
| `RUN` | `{ argv, env?, display?, tools?, digest }` for a full program, one executable artifact, or `{ executable, executable_path }`, such as the `run` task of `binary_product()`. |
| `VSCODE` | Odin metadata with `has_main`, `is_test`, and an optional bundle-relative `executable_path`. |
| `TEST` | A list of `{ name, ok, output? }` units. `core.test_root()` makes this list from `.test.luau` modules. |

`imp fmt --check`, `imp generate --check`, `imp goal generate-build --check`,
and `imp lint --fix` are goal flags. `generate-build` has no slot key: it
takes no target selector, and it runs the BUILD generators that
`core.register_build_generator` registers. Its module registers the goal with
`selection = "none"`. The `fmt`, `generate`, `gen-lockfiles`, `lint`, and
`package` goals write workspace files only at the goal boundary; their graph
tasks stay sandboxed. A `gen-lockfiles` task downloads and hashes each
artifact in an uncached action. Two selected roots must not write the same
lockfile, because each root merges with the lockfile that it read when the
graph was declared. Toolchain modules register their shipped lockfiles with
`register_toolchain_lockfile(spec, versions)`.
`test_vehicle(name, result)` converts one action result with `exit_code`,
`stdout`, and `stderr` into a `TEST` unit list. Run the action with
`allow_failure = true`, so that a failing test does not stop the task.

**Illustrative example:** a BUILD module whose `.test.luau` modules sit in the
same directory.

```luau
local core = require("@imp/core")
local test = require("@imp/rules/workflows/test")

return {
	rules_test = { [test.TEST] = core.test_root() },
}
```

## Generate text and publish it

Rule authors can encode a JSON value with `core.json_encode(value)`. It returns
pretty JSON with a final newline. Use `core.json_decode("[]")` to make an empty
array, so that it stays an array when encoded. An ordinary empty table encodes
as an object.

`core.digest_from_text(files)` stores a map of relative file paths to UTF-8
strings in CAS and returns its directory digest. It writes no workspace files.
Paths must be normalized and relative. File and directory paths must not
conflict. Paths and directory prefixes that differ only in case are rejected
on every host.

**Illustrative example:** inside a goal callback, publish text under a prefix.

```luau
local digest = core.digest_from_text({
    ["launch.json"] = launch_text,
    ["tasks.json"] = tasks_text,
})
core.write_workspace(".vscode", digest, { merge = true })
```

`merge = true` publishes the digest's files and preserves unrelated files.
An optional `from` selects a directory inside the digest. The merge rejects
existing symlink destinations and file/directory conflicts before it writes.
Each file is published atomically; a multi-file write is not one transaction.
Without `merge`, `write_workspace` keeps its existing replacement behavior.
Workspace writes are permitted only in goal callbacks.

The `vs` goal aggregates the selected Odin metadata and uses these operations
to publish two VS Code files. Visual Studio output is deferred. See the [Odin guide](../odin/)
for imports, package commands, modes, and debugger requirements.

## Regenerate shipped toolchain lockfiles

**Verified:** on 2026-10-24, the Luau `gen-builtin-lockfiles` goal is available when the
workspace requires `@imp/rules/workflows/builtin_lockfiles`. It imports each
shipped toolchain module and regenerates all registered versions, independent
of workspace toolchain targets. Existing versions outside that list are removed.

> **Warning:** This command downloads toolchain artifacts and replaces shipped
> lockfiles in the workspace.

From this repository root, with the Luau workspace:

```sh
IMP_RUNTIME=luau imp goal gen-builtin-lockfiles
```

The goal declares graph tasks through its `roots` provider. Imp resolves all
roots before the goal callback publishes their artifacts. A download failure
stops the invocation before publication. Publication uses the existing lockfile
goal behavior; writes across multiple lockfiles are not one transaction.
