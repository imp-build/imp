# imp framework roadmap

This repository currently contains a Steel-backed planning spike. It proves
that a workspace can define target types, product rules, and target
constructors dynamically, then plan a `build` goal into a directed task graph.
It does not yet execute that graph.

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

- `imp.workspace.scm` marks the workspace root and defines extensions.
- `BUILD.scm` files declare addressable targets. Their directory determines
  their `//path:name` address scope.
- A goal selects targets and requests products. Rules resolve those product
  requests into tasks; targets do not run work directly.
- The Rust engine owns addresses, graph validation, planning, scheduling,
  caching, and reporting. Steel defines project-specific target types, rules,
  and constructors without a Rust rebuild.
- Definition-time side effects remain possible, but they must be visibly
  classified as impure before they participate in caching or CI generation.

## Current spike

Implemented:

- upward workspace discovery using `imp.workspace.scm`;
- recursive `BUILD.scm` discovery;
- Steel-defined target types, products, rules, and constructors;
- local and absolute target-address dependencies;
- `build` goal planning, DOT rendering, and task deduplication.

Deliberately incomplete:

- only the `build` goal exists;
- rules describe action strings rather than structured executable actions;
- no artifact model, execution, caching, tool resolution, or CI backend;
- `auto` has one product-selection behavior only;
- workspace extensions are currently one root file rather than an importable
  module/package system.

## Milestone 1 — Stabilise the definition API

Replace the positional host primitives with a small, documented Steel API.

- [ ] Add field schemas to target types: required fields, optional fields,
  defaults, and validation.
- [ ] Make target constructors ordinary extension functions/macros over that API.
- [ ] Add extension imports rooted at the workspace, with source locations in
  diagnostics.
- [ ] Replace the temporary Steel-home workaround with an explicit host-owned
  module/cache directory.
- [x] Add `imp targets`, `imp dependencies`, and `imp rules` inspection
  commands.

Acceptance: a separate Steel extension can define a target type, rule, and
constructor; a workspace can import it and inspect its targets without Rust
changes.

## Milestone 2 — Structured task and artifact model

Replace rule action strings with serializable task specifications.

- `Action`: argv, cwd, environment, platform requirements, declared inputs,
  declared outputs, and display metadata.
- `Artifact`: file, directory, manifest, or value output with a producing task.
- `Task`: stable identity, input artifacts, output artifacts, action, and
  dependency edges.
- Make product rules return task/artifact specifications, not prose strings.
- Keep DOT and text plans as renderers over the same graph IR.

Acceptance: a plan can be serialized to JSON and re-rendered without loading
Steel again.

## Milestone 3 — Local execution and correctness

Execute the task graph locally before adding any remote system.

- Add `imp build` execution for planned actions while retaining `imp plan`
  as a pure inspection command.
- Stream process output through the existing progress UI.
- Materialize declared outputs atomically and report missing outputs as errors.
- Add failure propagation, cancellation, bounded parallelism, and deterministic
  task ordering where it affects observable output.
- Introduce a no-op/dry-run executor for planner tests.

Acceptance: one migrated build target runs through the new executor and has no
project-specific command logic in Rust.

## Milestone 4 — Local incremental cache

Add a content-addressed local cache only after task inputs and outputs are
explicit.

- Hash action definitions, tool identities, declared environment, and input
  artifact digests.
- Store output manifests and materialize cache hits into the workspace.
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

- Steel versioning and compatibility policy while its embedding API is pre-1.0.
- Whether extensions are Steel source only or may include versioned native/Wasm
  modules.
- Whether `BUILD.scm` may import arbitrary workspace files, and how those files
  participate in invalidation.
- Default target-selection semantics for bare goals.
- Required reproducibility boundary for downloads, network access, and external
  mutable tools.
