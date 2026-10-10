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

- `build` warms the graph and task cache but does not publish ordinary files.
- `codegen` publishes selected `codegen()` outputs under `dist/codegen/`.
- `package` publishes graph artifacts under `dist/`.
- `fmt`, `lint`, and `generate` publish workspace changes only at their goal
  boundary; their graph tasks remain sandboxed.
- `publish` is explicitly registry-mutating and must be selected by the user.

See the guide pages for command procedures and the rule-family guides for the
workflow handles each target provides.

## Luau workflow modules

**Verified:** on 2026-10-10, `@imp/rules/workflows/build`, `codegen`, `fmt`,
`generate`, `generate_build`, `lint`, `package`, `run`, and `test` have Luau
modules beside the JavaScript modules. JavaScript stays the default runtime of
this repository. To use the Luau modules here, select the Luau workspace with
`IMP_RUNTIME=luau`, as `docs/design/luau-authoring-contract.md` describes.

Each module registers its goal with `core.goal` and exports the slot key:
`BUILD`, `CODEGEN`, `FMT`, `GENERATE`, `LINT`, `PACKAGE`, `RUN`, or `TEST`. A
BUILD module puts a root under that slot key. Rule modules give these result
shapes. Luau result fields use `snake_case`:

| Slot | Root result |
| --- | --- |
| `CODEGEN` | The generator task of a `codegen()` result. It resolves to one artifact for each output path. |
| `GENERATE` | A `generated_files()` result. It resolves to one artifact for each output path and a `before` workspace digest. |
| `FMT` | `{ paths, sources_digest?, formatted?, check?, output? }`. `check` is `{ requested, failed }`. `formatted` is an artifact. |
| `LINT` | `{ ok, output?, paths?, fixed?, fix_applied? }`, or a table with that table in its `result` field. `fixed` is an artifact with the fixed sources under `fixed/`. |
| `RUN` | `{ argv, env?, display?, tools?, digest }` for a full program, or one executable artifact. |
| `TEST` | A list of `{ name, ok, output? }` units. `core.test_root()` makes this list from `.test.luau` modules. |

`imp fmt --check`, `imp generate --check`, `imp goal generate-build --check`,
and `imp lint --fix` are goal flags. `generate-build` has no slot key: it
takes no target selector, and it runs the BUILD generators that
`core.register_build_generator` registers. Its module registers the goal with
`selection = "none"`. The `fmt`, `generate`, and `lint` goals write workspace
files only at the goal boundary; their graph tasks stay sandboxed.
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
