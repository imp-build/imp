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

**Verified:** on 2026-10-11, `@imp/rules/workflows/build`, `codegen`, `fmt`,
`generate`, `generate_build`, `lint`, `lockfiles`, `package`, `publish`, `run`,
and `test` have Luau modules beside the JavaScript modules. JavaScript stays
the default runtime of this repository. To use the Luau modules here, select
the Luau workspace with `IMP_RUNTIME=luau`, as
`docs/design/luau-authoring-contract.md` describes.

Each module registers its goal with `core.goal` and exports the slot key:
`BUILD`, `CODEGEN`, `FMT`, `GENERATE`, `GEN_LOCKFILES`, `LINT`, `PACKAGE`,
`PUBLISH`, `RUN`, or `TEST`. A BUILD module puts a root under that slot key.
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
