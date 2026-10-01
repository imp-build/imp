# Luau catalog cutover plan

**Status: Planned.** This plan is for contributors and maintainers who migrate
Imp's workspace modules, installed rules, and tests from JavaScript to Luau. It
defines review ownership, import islands, host prerequisites, and the gate for
removing QuickJS. It does not describe behavior that is available today.

## Current evidence

The conversion report at `probes/js-luau-conversion/inventory.py` reads tracked
JavaScript files and assigns each file to one named migration boundary or one
explicit exclusion. Its current result is:

| Role | Mechanical | Review | Redesign | Excluded | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Production | 14 | 28 | 39 | 0 | 81 |
| Workspace or BUILD | 43 | 21 | 0 | 0 | 64 |
| Test | 8 | 44 | 12 | 0 | 64 |
| Excluded | 0 | 0 | 0 | 2 | 2 |
| **All** | **65** | **93** | **51** | **2** | **211** |

The previous 212-file count included `rules/init/index.js`. Imp no longer has
an `imp init` command or rule package. The conversion categories are heuristic
review signals. They are not semantic proof that a module can be translated
mechanically.

## Migration rules

- Do not evaluate JavaScript and Luau modules in one graph. There is no
  cross-runtime bridge.
- Keep JavaScript as the default runtime until the removal gate passes. A Luau
  workspace can import only Luau modules that exist in its selected island.
- A review boundary may land before its imports are complete. The migration
  branch may be temporarily broken between island completions.
- Validate an island only when every module in that static-import component and
  all of its prerequisite islands are present in Luau.
- Keep every review boundary at or below 20 tracked authoring modules. A task
  may need separate runtime and validation boundaries to preserve that limit
  and the import order.
- Keep installed rules as files beside the executable. Do not compile them into
  the binary and do not let workspace files override `@imp/rules` modules.

## Review boundaries

The report lists every file in these boundaries. The counts below match the
current 211-file inventory. “Split” means that the next sprint must replace the
current broad task with the listed ownership boundaries before conversion work
starts.

| Area | Boundary | Files | Task ownership |
| --- | --- | ---: | --- |
| Pilot | `asset-pilot` | 3 | Completed graph-host pilot |
| Discovery | `catalog-discovery` | 1 | Workspace and catalog discovery |
| Host removal | `quickjs-removal` | 2 | QuickJS removal |
| Examples | `example-decision` | 3 | Example migration decision |
| Integration | `workspace-integration` | 19 | Workspace, CI, docs, and integration |
| Imp | `imp-host-foundation` | 3 | Split host/test task |
| Imp | `imp-core-foundation` | 10 | Split core task |
| Imp | `imp-validation` | 15 | Split host/test task |
| Rust | `compiled-language-island` | 3 | Split Rust task |
| Workflows | `workflow-core-runtime` | 6 | Split core workflow task |
| Workflows | `workflow-core-validation` | 6 | Split core workflow task |
| Workflows | `workflow-codegen-runtime` | 3 | Split codegen workflow task |
| Workflows | `workflow-codegen-validation` | 4 | Split codegen workflow task |
| Workflows | `workflow-lockfiles-runtime` | 1 | Split packaging workflow task |
| Workflows | `workflow-packaging-runtime` | 3 | Split packaging workflow task |
| Workflows | `workflow-packaging-validation` | 7 | Split packaging workflow task |
| Workflows | `builtin-lockfiles` | 1 | Split packaging workflow task |
| C | `c-shared-toolchain` | 1 | Split C catalog-root task |
| C | `c-toolchains` | 12 | C toolchain task |
| C | `c-cmake` | 12 | CMake task |
| C | `c-catalog-root` | 4 | Split C catalog-root task |
| C | `c-generate-build` | 1 | Split C catalog-root task |
| JavaScript | `js-biome` | 9 | Biome task |
| JavaScript | `js-node-pnpm` | 13 | Node and pnpm task |
| Python | `python-core` | 14 | Python core task |
| Python | `python-pex-uv` | 5 | PEX and uv task |
| Python | `python-ruff` | 6 | Ruff task |
| Rust | `rust-remainder` | 13 | Split Rust task |
| Odin | `odin-remainder` | 20 | Split Odin task |
| Tree-sitter | `treesitter-validation` | 2 | Split Tree-sitter task |
| Tree-sitter | `treesitter-runtime` | 1 | Split Tree-sitter task |
| OCI | `oci` | 5 | OCI task |
| Zola | `zola` | 3 | Zola task |

The two excluded application files and their `BUILD.js` owner are in
`example-decision`. No tracked JavaScript file is unassigned. The report must
be refreshed after a JavaScript file is added, removed, or moved.

## Import islands and dependencies

The report extracts static `//rules/...` imports, resolves file and directory
entrypoints, and prints the complete cross-boundary dependency table with one
source edge for each row. It ignores addressed data such as lockfiles because
those strings are not module imports.

Review boundaries express ownership. They are not dependency nodes: one
boundary can contain independent files from different import stages. The
module-level graph has eleven prerequisite-first stages. Its condensed graph is
acyclic. It contains one multi-module strongly connected component, owned by
`compiled-language-island`:

- `rules/rust/generate_build/index.js`
- `rules/rust/index.js`
- `rules/rust/workspace_expansion.js`

Convert those three files as one unit. Do not divide the cycle across
independently activated Luau packages. The Imp codegen, Odin, Rust cargo input,
and Tree-sitter runtime modules are not part of this cycle; they remain in
their own review boundaries and use the prerequisite-first module stages
printed by the report. A conversion task may commit files from one review
boundary before the full boundary is runnable.

The main cross-boundary constraints are:

| Consumer | Static-import prerequisites |
| --- | --- |
| C toolchains | Shared C toolchain, Imp foundations, base lockfile workflow |
| CMake | C toolchains, Imp foundations, core and packaging workflows |
| C catalog and BUILD generation | C toolchains, CMake, compiled-language island, workflow codegen |
| JavaScript and Python toolchains | Imp foundations, base lockfile workflow |
| Compiled-language island | C toolchains, Imp foundations, core, codegen, and packaging workflows |
| OCI and Zola | Imp foundations, base lockfile and packaging workflows |
| Built-in lockfiles | CMake and all shipped language and toolchain packages |
| Validation boundaries | Test discovery, Imp test rules, and their runtime boundary |
| Workspace integration | Every shipped production and validation boundary |

The boundary dependency table lists imports between ownership boundaries. It
can contain cycles because a boundary can contain modules from different
stages; do not use it by itself as a task schedule. Use the module island order
to plan conversion, then split boundaries where needed. Re-run the report so
the edges and stages come from the current source.

## Host prerequisites

The report's host prerequisites are planning estimates recorded in
`inventory.py`. They are not a verified capability matrix. Check them against
the current host surface and migration gaps in
`docs/design/luau-authoring-contract.md` before scheduling host work. The
current requirements are:

| Prerequisite | Required behavior |
| --- | --- |
| Workspace configuration | Base configuration, CI overlay, validation, and source-address diagnostics |
| Graph outputs | Named value and artifact outputs through the existing execution and CAS path |
| Tool and path APIs | Hermetic tool acquisition, platform data, environment settings, and path resolution |
| Test discovery | Luau `TEST` values, BUILD discovery, filtering, execution, and failure locations |
| Workspace and catalog discovery | Canonical root and nested BUILD addresses, generated BUILD names, installed-rule ownership, and cache identity |

The report associates each review boundary with proposed host prerequisites. A
host task must name the first boundary that consumes every new API. Do not add
an API only to approximate JavaScript behavior that no selected boundary uses.

## Backlog reconciliation

Before the next catalog task is claimed, the sprint must reconcile the current
Peon tasks with this plan:

- Split the C catalog-root task into shared toolchain, catalog root, and BUILD
  generation boundaries. Reverse any task ordering that conflicts with the
  report's current imports.
- Split Imp work into host foundation, core foundation, validation, and the
  compiled-language island.
- Split workflow work into runtime, validation, base lockfile, packaging, and
  built-in lockfile boundaries.
- Keep the three cyclic Rust modules together. Keep Imp codegen, Odin, Rust
  cargo input, and Tree-sitter runtime modules in their own boundaries.
- Keep package tasks that already match one boundary, but replace their broad
  dependency lists with prerequisites derived from the current import report
  and host table.

This documentation task does not edit planner-owned task contracts. The sprint
owns those changes.

## QuickJS removal gate

Remove QuickJS only after all conditions below pass on
`luau-runtime-migration`:

- Every tracked workspace, BUILD, production rule, and test module has a Luau
  implementation or an explicit documented exclusion.
- The example decision names both excluded application files and states whether
  each file remains JavaScript or migrates.
- Every dependency-closed Luau island passes its focused consumer and validation
  checks. Supported workspaces and repository CI use only completed islands.
- Tests cover canonical module identity, package ownership, graph identity,
  async execution, diagnostics, graph outputs, toolchains, workspace
  configuration, and test discovery.
- Repository searches and Cargo manifests contain no authoring dependency on
  QuickJS or rquickjs.
- Release packaging stages the Luau rule tree beside `imp` and
  `ci/smoke_package.sh` resolves it from outside the repository.
- From the repository root, `imp fmt //...`, `imp lint //...`,
  `imp test //...`, and `cargo test --workspace` pass.

Record every command result. Keep code failures, toolchain failures, and
environment failures separate. A focused pass does not replace a failed broad
gate.
