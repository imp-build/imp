# imp framework roadmap

## Projects this framework replaces

The framework is intended to replace the repeated `imp` implementations that
motivated this repository, not merely the small planning example in this tree.
They share a command-and-subprocess shape, but exercise materially different
requirements:

| Variant | Current responsibilities | Requirements it contributes |
| --- | --- | --- |
| Odin engine imp (this crate) | Odin target and test discovery, native Jodin/CMake build, packaging, coverage, toolchain setup, dependency graph generation | generated target discovery, native-library staging, build modes, parallel tasks, local cache inputs, progress reporting |
| Godot/GDExtension imp (`examples/imp`) | Rust GDExtension build, Godot download/bootstrap/editor/run/pack, Windows cross compilation, protobuf generation, CI-pipeline generation | versioned downloads, platform-specific artifacts, generated source, grouped workflows, release/package products |
| Hyperfuse imp (`examples/hf-imp`) | Rust/C/CMake/Python build and test, ISA emulation, tool provisioning, kernel/codegen generation, coverage, Buildkite generation | mixed-language products, tool artifacts, variants and execution constraints, external generators, test/coverage result products |

The replacement must therefore be general enough that a target can represent
source ownership, a generated artifact, a tool, a native library, a binary, a
test suite, or a package. It must not make Odin, Godot, CMake, Cargo, Python,
or Buildkite special cases in the core engine.

The examples are design inputs and migration candidates. They are not all
expected to be converted at once; the later migration milestone moves one
workflow at a time after the shared primitives are proven.

## Design commitments

- `imp.workspace.js` marks the workspace root and loads extension modules.
- `BUILD.js` files declare addressable targets. Their directory determines
  their `//path:name` address scope.
- Targets are declared by calling constructor functions imported from plugin
  modules. Constructors return target handles — first-class JS values.
- Dependencies are expressed by passing handles directly, not by address
  strings. `export const name = constructor(...)` makes the variable name
  the target's address within its file.
- Cross-file references use ES module imports: `import { name } from "//path"`.
  The `//path:name` address syntax only appears at the CLI level.
- A goal selects targets and requests products. Rules (defined in plugin
  modules) resolve those product requests into tasks.
- The Rust engine owns addresses, graph validation, planning, scheduling,
  caching, and reporting. Plugin modules written in JS define target
  constructors and rules without a Rust rebuild.
- Plugin files are ordinary JS modules — no separate registration ceremony
  or different paradigm. A plugin is just a module you import.
- Definition-time side effects remain possible, but they must be visibly
  classified as impure before they participate in caching or CI generation.

## Extension language

The extension language is **JavaScript** (QuickJS, embedded via `rquickjs`).

QuickJS was chosen over Steel/Scheme because:
- ES module `import`/`export` syntax provides natural cross-file target
  references without string address duplication.
- `export const name = constructor(...)` captures the target name from the
  variable binding — no `name =` argument needed.
- Dependencies are passed as values (handles), not as strings, so the
  dependency graph is expressed directly in code rather than through a
  host registry.
- Plugin files are conventional JS modules; there is no distinction between
  a "plugin API" and "library code."
- QuickJS is lightweight, has no external runtime dependency, and embeds
  cleanly in Rust via `rquickjs`.

## Current spike

Implemented:

- upward workspace discovery using `imp.workspace.js`;
- recursive `BUILD.js` discovery;
- JS-defined target constructors and rules via `imp:core` built-in module;
- ES module imports for cross-file target references;
- target handles as first-class JS values — deps passed by value, not string;
- `export const name = ...` as the target naming mechanism;
- `build` goal planning, DOT rendering, and task deduplication;
- `imp targets`, `imp dependencies`, and `imp rules` inspection commands.

Deliberately incomplete:

- only the `build` goal exists;
- rules describe action strings rather than structured executable actions;
- no artifact model, execution, caching, tool resolution, or CI backend;
- `auto` has one product-selection behaviour only;
- no field schema validation (removed from scope — JS constructors own validation).

## Milestone 1 — Stabilise the definition API

Replace ad-hoc host primitives with a small, documented JS API.

- [x] Finalise `imp:core` API surface (`target`, `rule`) with JSDoc.
- [x] Add extension imports rooted at the workspace, with source locations in
  diagnostics.
- [x] Define the module resolution protocol: `//path` → file, `imp:*` →
  built-in, relative → prohibited in BUILD files.
- [x] Decide constructor validation story: JS-side (throw in constructor) or
  host-side (typed field declarations). Current v1 uses JS-side validation,
  with the host validating only core target-handle and field invariants.
- [x] Add `imp targets`, `imp dependencies`, and `imp rules` inspection
  commands.

Acceptance: a separate JS module can define a target constructor and rule;
a workspace can import it and inspect its targets without Rust changes.

## Milestone 2 — Structured task and artifact model

Replace rule action strings with serialisable task specifications.

- [x] `Action`: argv, cwd, environment, platform requirements, declared inputs,
  declared outputs, and display metadata.
- [x] `Artifact`: file, directory, manifest, or value output with a producing task.
- [x] `Task`: stable identity, input artifacts, output artifacts, action, and
  dependency edges.
- [x] Make `rule()` accept task/artifact specifications, not prose strings.
- [x] Keep DOT and text plans as renderers over the same graph IR.
- [x] Add JSON plan output through `imp plan --json <path>`.

Compatibility note: legacy string `action` values are still accepted and lowered
into structured action display metadata so existing rules continue to load.

Acceptance: a plan can be serialised to JSON and re-rendered without loading
JS again.

## Milestone 3 — Local execution and correctness

Execute the task graph locally before adding any remote system.

- Add `imp build` execution for planned actions while retaining `imp plan`
  as a pure inspection command.
- [x] Add local execution for planned actions through `imp plan --execute`
  while the command migration path is decided.
- Stream process output through the existing progress UI.
- [x] Report missing declared file, directory, and manifest outputs as errors.
- Materialise declared outputs atomically.
- [x] Add failure propagation for failed local commands.
- Add cancellation and bounded parallelism.
- [x] Add deterministic dependency ordering for observable execution output.
- [x] Introduce a no-op/dry-run executor for planner tests.

Acceptance: one migrated build target runs through the new executor and has no
project-specific command logic in Rust.

## Milestone 4 — Local incremental cache

Add a content-addressed local cache only after task inputs and outputs are
explicit.

- Hash action definitions, tool identities, declared environment, and input
  artifact digests.
- Store output manifests and materialise cache hits into the workspace.
- Mark definition-time or execution-time impure tasks as uncacheable by
  default, with an explicit override for users who accept that risk.
- Provide `imp cache explain <task>` for cache-key diagnostics.

Acceptance: a second unchanged build skips all cacheable actions; editing a
declared input invalidates only its affected downstream tasks.

## Milestone 5 — Goals and product selection

Generalise beyond `build` without adding goal-specific Rust branching.

- Add goal registration and product-selection policies to extensions.
- Implement `test`, `fmt`, `lint`, `package`, and `run` as product requests.
- Extend dependency modes beyond `auto`, initially `sources`, `link`, and
  `runtime`.
- Decide whether a selector-less goal means all buildable targets or an
  explicit workspace default target such as `//:default`.

Acceptance: an extension adds a new goal and another adds a new target type
that participates in an existing goal, both without changing the engine.

## Milestone 6 — Platforms, tools, and CI

Move current environment-specific code behind graph abstractions.

- Model local, WSL/Windows, and future container execution as platforms.
- Turn Odin, CMake, Godot, `uv`, and other provisioned tools into versioned
  tool artifacts.
- Make workspace sync an explicit platform-transfer task rather than a global
  preamble.
- Lower selected graph roots to Buildkite from the same graph used locally.
- Keep remote caching out of scope until the local cache model has proven
  correct.

Acceptance: local and Buildkite plans originate from identical selected targets
and differ only in execution backend details.

## Milestone 7 — Migrate real workflows

Migrate one workflow at a time and delete bespoke command code only after its
replacement is exercised.

Suggested order:

1. simple code generation;
2. CMake/native library build;
3. Odin build plus runtime-library staging;
4. unit tests and coverage;
5. package/release and generated CI pipeline.

Each migration needs a plan snapshot, execution test, and clear removal of the
superseded imperative command path.

## Open decisions

- QuickJS versioning and compatibility policy as `rquickjs` evolves.
- Whether extensions may include native/Wasm modules alongside JS.
- Whether `BUILD.js` may import arbitrary workspace files, and how those files
  participate in invalidation.
- Default target-selection semantics for bare goals.
- Required reproducibility boundary for downloads, network access, and external
  mutable tools.
- Constructor validation: JS-side throws vs host-side typed field declarations.
