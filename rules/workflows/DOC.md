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
