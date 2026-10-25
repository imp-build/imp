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
- The repository has an `imp.workspace.luau` beside `imp.workspace.js`. A port
  task adds the `BUILD.luau` and `.test.luau` modules of its package, requires
  any new workflow module from `imp.workspace.luau`, and validates with
  `IMP_RUNTIME=luau imp test //<package>/...`. The
  `luau::tests::repository_luau_workspace_tests_pass` test runs these tests in
  `imp test //...`.
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
| Imp | `imp-host-foundation` | 2 | Imp host and test task |
| Imp | `imp-mode` | 2 | Imp mode axes task |
| Imp | `imp-core-foundation` | 7 | Imp core task |
| Imp | `imp-toolchain` | 5 | Imp toolchain task |
| Imp | `imp-generate-validation` | 1 | Imp generate validation task |
| Imp | `imp-validation` | 14 | Imp host and test task |
| Workflows | `workflow-core-runtime` | 6 | Core workflow task |
| Workflows | `workflow-core-validation` | 6 | Core workflow task |
| Workflows | `workflow-codegen-runtime` | 3 | Imp core task |
| Workflows | `workflow-codegen-validation` | 4 | Codegen workflow task |
| Workflows | `workflow-lockfiles-runtime` | 2 | Packaging workflow runtime task |
| Workflows | `workflow-packaging-runtime` | 5 | Packaging workflow runtime task |
| Workflows | `workflow-vs` | 3 | Odin VS Code task |
| Workflows | `workflow-packaging-validation` | 1 | Packaging workflow task |
| Workflows | `builtin-lockfiles` | 1 | Packaging workflow task |
| C | `c-shared-toolchain` | 1 | C toolchain task |
| C | `c-toolchains` | 9 | C toolchain task |
| C | `c-cmake` | 12 | CMake task |
| C | `c-catalog-root` | 4 | C catalog-root task |
| C | `c-generate-build` | 1 | C BUILD generation task |
| JavaScript | `js-biome` | 10 | Biome task |
| JavaScript | `js-node-pnpm` | 12 | Node and pnpm task |
| Python | `python-core` | 12 | Python core task |
| Python | `python-pex-uv` | 5 | PEX and uv task |
| Python | `python-ruff` | 8 | Ruff task |
| Rust | `rust-toolchains` | 9 | Rust toolchain task |
| Rust | `rust-graph` | 7 | Rust graph task |
| Odin | `odin` | 17 | Odin task |
| Odin | `odin-vscode` | 3 | Odin VS Code task |
| Tree-sitter | `treesitter-validation` | 2 | Tree-sitter task |
| Tree-sitter | `treesitter-runtime` | 1 | Tree-sitter task |
| OCI | `oci` | 5 | OCI task |
| Zola | `zola` | 3 | Zola task |

The two excluded application files and their `BUILD.js` owner are in
`example-decision`. No tracked JavaScript file is unassigned. The report must
be refreshed after a JavaScript file is added, removed, or moved.

## JavaScript example decision

Keep `rules/js/example/src/hello.js` and
`rules/js/example/app/src/index.js` as deliberate JavaScript examples outside
the authoring catalog. The first demonstrates a source collection. The second
demonstrates a Node application. These files are source inputs, not Imp
authoring modules. They do not require QuickJS.

The example package has a `BUILD.luau` that declares the existing `hello`,
`hello_src`, `app`, and `app_ts` targets. The TypeScript application keeps its
TypeScript source. Keep `BUILD.js` during the compatibility period; remove it
with the other JavaScript authoring modules at QuickJS removal.

## Import islands and dependencies

The report extracts static `//rules/...` imports, resolves file and directory
entrypoints, and prints the complete cross-boundary dependency table with one
source edge for each row. It ignores addressed data such as lockfiles because
those strings are not module imports.

The report also ignores imports that name only JavaScript test scaffolding
that the Luau host replaces:

- All exports of `//rules/imp/test`. Luau tests use `core.test` and
  `core.test_root`.
- `jsSources` from `//rules/js` in BUILD modules. Luau BUILD modules do not
  declare their own JavaScript sources. A test that imports `jsSources` keeps
  its edge.

These imports are not Luau dependencies, and they caused most of the false
cycles between tasks. A boundary gets the "test host fakes" prerequisite when
one of its tests imports a `withFake*` helper or replaces a
`globalThis.__host_*` function. The report prints the number of imports that it
ignores.

Review boundaries express ownership. They are not dependency nodes: one
boundary can contain independent files from different import stages. The
module-level graph has eleven prerequisite-first stages. Its condensed graph is
acyclic. It contains one multi-module strongly connected component, owned by
`rust-graph`:

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
| C catalog root | C toolchains, Imp foundations, core and packaging workflows |
| CMake | C catalog root, C toolchains, Imp foundations, core, lockfile, and packaging workflows |
| C BUILD generation | C catalog root, CMake, Imp core with codegen workflows |
| JavaScript and Python toolchains | Imp foundations, base lockfile workflow |
| Rust toolchains | Imp foundations, base lockfile workflow |
| Rust graph | Rust toolchains, C toolchains, Imp foundations, core, codegen, and packaging workflows |
| OCI and Zola | Imp foundations, base lockfile and packaging workflows |
| Built-in lockfiles | CMake and all shipped language and toolchain packages |
| Validation boundaries | Test discovery, their runtime boundary, and test host fakes when their tests use fakes |
| Workspace integration | Every shipped production and validation boundary |

The boundary dependency table lists imports between ownership boundaries. It
can contain cycles because a boundary can contain modules from different
stages; do not use it by itself as a task schedule. Use the module island order
to plan conversion, then split boundaries where needed. Re-run the report so
the edges and stages come from the current source.

The task dependency table condenses the boundary graph by owning task. Each
task's Peon `depends_on` list must contain the prerequisite tasks in that table.
The report prints every task cycle with one source edge for each step.

**Verified:** on 2026-10-10 the report printed "Task graph: acyclic". Three
task cycles that the report printed on 2026-10-07 were removed by ownership
changes:

- Biome and Node/pnpm: `rules/js/biome/index.js` imports `rules/js/graph.js`,
  and `rules/js/graph_test.js` imports Biome. The Biome task now owns
  `rules/js/graph_test.js`.
- Odin and the packaging workflow: `rules/workflows/vs/index.js` imports
  `rules/odin/index.js`, and `rules/odin/vscode/index.js` imports the VS
  workflow. A new Odin VS Code task owns `rules/odin/vscode` and
  `rules/workflows/vs`. It follows the Odin task.
- Python core and Ruff: Ruff imports `rules/python/index.js`, and
  `rules/python/graph_test.js` imports Ruff. The Ruff task now owns
  `rules/python/graph_test.js` and `rules/python/doc_test.js`.

The report reads only static imports. `rules/python/doc_test.js` imports the
modules in the `DOC.md` setup block with `import()`, and these include the Ruff
modules. Its owner is set by hand in `inventory.py`.

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
| Dynamic expansion | Keyed child targets that a rule derives from task outputs, with named and aggregate selection |
| Unowned file discovery | Sorted workspace files that no loaded target owns, filtered by root, include, and exclude patterns |
| Test host fakes | Luau test replacements for the JavaScript `withFake*` helpers and `globalThis.__host_*` patches: toolchain host, `run`, workspace writes, goal flags, and diffs |
| Generic goal driver | One driver that calls the registered Luau `core.goal` function with `{ address, result }` roots, with goal flags, goal errors, action status, `read_file_in_digest`, and the interactive `run` program. `workflow-core-runtime` is its first consumer. |

The report associates each review boundary with proposed host prerequisites. A
host task must name the first boundary that consumes every new API. Do not add
an API only to approximate JavaScript behavior that no selected boundary uses.

## Backlog reconciliation

Task ownership follows these rules:

- The C toolchain task owns the shared C toolchain. A separate task owns C
  BUILD generation, because it imports CMake.
- The Imp core task owns the codegen workflow runtime modules, because the Imp
  codegen and workflow generate modules import each other's packages. The
  codegen workflow task owns their BUILD and test modules.
- A separate Imp toolchain task owns `rules/imp/toolchain`, its test, and
  `lockfileFor()` of `rules/imp/lockfile` (user decision, 2026-10-10). The
  port needs a host function that returns the named-cache directory of a tool
  (`exec.tool_dir`), and no Luau rule used a toolchain when the Imp core task
  ran. The task also owns `rules/c/mold`, the first Luau toolchain consumer
  (user decision, 2026-10-11). The C toolchain task owns the other C
  toolchains and depends on it.
- The Imp core task moved the `generate-build` goal into
  `@imp/rules/workflows/generate_build` (user decision, 2026-10-10). The Luau
  host keeps only `core.generate_build(check)` and no goal special case.
- A separate validation task owns `rules/imp/generate_test.js`, because it
  imports Odin toolchains. It follows the Odin task.
- A packaging runtime task owns the base lockfile, package, and publish
  workflows with their BUILD modules and focused tests. The packaging workflow
  task owns the built-in lockfile aggregator and the lockfile test.
- The Luau `gen-lockfiles` root downloads and hashes each artifact in an
  uncached sandbox action, and the goal writes the lockfile at the goal
  boundary (user decision, 2026-10-11). The Luau host has no download, hash,
  or file-size functions. The lockfile encoder of
  `@imp/rules/workflows/lockfiles` writes the shipped lockfiles with the same
  bytes as the JavaScript generator. `generate_builtin_lockfile(spec)` returns
  a lockfile task, so the built-in lockfile aggregator must resolve these
  tasks as graph roots. The goal fails when two roots write one lockfile. The
  write action gives the lockfile text as one argument, which limits its size
  (`2026-10-11-write-luau-lockfiles-without-argv-limit`).
- The Odin VS Code task owns `rules/odin/vscode` and `rules/workflows/vs`,
  because the VS workflow imports Odin and the Odin VS Code module imports the
  VS workflow. It follows the Odin task.
- A test that imports a plugin package belongs to the plugin task, not to the
  package that it tests. The Biome task owns `rules/js/graph_test.js`. The Ruff
  task owns `rules/python/graph_test.js` and `rules/python/doc_test.js`.
- A separate Imp mode axes task owns `rules/imp/mode` and
  `rules/imp/config/example`, because Luau has no mode axes, profiles,
  `semantic.mode`, or `configured()` (user decision, 2026-10-10). The Odin
  task follows it, because Odin imports `rules/imp/mode`.
- The Imp host and test task retires the JavaScript test harness
  (`rules/imp/test/index.js` and its BUILD module). The host test API and test
  host fakes replace it.
- The Rust work has two tasks. The Rust toolchain task owns the toolchain,
  Kache, and Cargo input modules with their tests and `rules/rust/BUILD.js`.
  The Rust graph task owns the three cyclic modules, their tests, and the
  example BUILD module. The earlier cut between the cycle and the other files
  made a task cycle: the cyclic modules import the toolchain, Kache, and Cargo
  input modules, and the other tests import `//rules/rust`.
- A host task adds test host fakes. Each task whose boundary requires test host
  fakes depends on it.

On 2026-10-08 the remaining tasks were reconciled. The Odin VS Code module and
the VS workflow became a separate task. The Tree-sitter task needed no split,
because its two boundaries have three modules in total. The report has no task
cycles, and each port task's Peon `depends_on` list contains the prerequisite
tasks in the report's task dependency table. Each task whose boundary requires
test host fakes depends on the test host fakes task. Re-run this check after a
JavaScript file is added, removed, or moved.

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

## OCI package port

The OCI package has Luau image rules, Crane acquisition, BUILD discovery, and
focused tests. JavaScript remains available. The Luau port rejects layer
traversal and encodes image configuration with private string-array and
string-map helpers. The consumer check under `rules/oci/testdata` exercises
local composition, packaging, hashes, metadata, fresh-build determinism, and
Crane acquisition. Registry publication is covered with fake actions.

The OCI guide documents Luau now. Generated Luau references remain deferred
to `2026-09-30-integrate-luau-workspace-tests-and-docs`; the OCI task's
reference-generation acceptance criterion is therefore not fully met by this
package port alone.

## Zola package port

The Zola package provides Luau toolchain declarations, graph acquisition,
lockfile generation roots, BUILD discovery, and focused tests. JavaScript
remains available for the existing documentation build. The consumer check
under `rules/zola/testdata` acquires the pinned default release and checks
site builds, packaging, source edits, and failure propagation.

The Zola guide documents Luau now. Generated Luau references remain deferred
to `2026-09-30-integrate-luau-workspace-tests-and-docs`. The Zola task's
reference-generation acceptance criterion remains incomplete until that work
lands.

## Python core package port

The Python core package provides Luau project/workspace declarations, runtime
selection, PEX app builds, pytest roots, and shallow source-run expansions.
The example and native-wheel fixtures have Luau BUILD modules. JavaScript
remains available for its runtime, the documentation build, and the pending
Ruff port. Core graph tests do not require Ruff.

Source runs use explicit expansion selectors, such as
`//:scripts#scripts/demo.py`. Bare file-path lookup exists only in the
JavaScript CLI path and remains a Luau integration gap. This package port
does not change the Rust host, by user decision.

The Python guide documents the Luau API. Generated Luau references remain
with `2026-09-30-integrate-luau-workspace-tests-and-docs`, as agreed for this
port. The Python core reference-generation acceptance criterion remains
incomplete until that work lands.

### Python core verification

Verified on Linux on 2026-10-22, from the repository root:

| Command | Result |
| --- | --- |
| `cargo build -p imp` | Exit 0. Built the checkout binary. |
| `cargo test --workspace` | Exit 0. All workspace and doc tests passed. |
| `IMP_RUNTIME=luau target/debug/imp test //rules/python:rules_test` | Exit 0. 47/47 units passed. |
| `IMP_RUNTIME=luau target/debug/imp build //rules/python/example:hello` | Exit 0. Built the example PEX. |
| `python3 rules/python/testdata/consumer_check.py --imp target/debug/imp` | Exit 0. Guide discovery and real core consumers passed. |
| `IMP_RUNTIME=luau target/debug/imp test //...` | Exit 0. 578/578 units passed. Four action failures were expected negative-test cases. |
| `imp test //rules/python:rules_test` | Exit 0. The JavaScript Python rule tests passed. |
| `imp fmt //...` | Exit 0. 61 unchanged, 0 changed, 0 failed. |
| `imp lint //...` | Exit 0. 46 clean, 0 fixed, 0 failed. |
| `PATH="$PWD/target/debug:$PATH" imp test //...` | Exit 0. 58/58 units passed with the checkout binary. |
| `PATH="$PWD/target/debug:$PATH" imp lint //docs:quality` | Exit 0. Documentation quality was clean. |

The consumer check covers root and nested PEX builds, packaging, native wheels,
argument forwarding, process failure, source edits, pytest failure, project
scripts, and scripts without a project. It checks that actions do not leave
virtual environments or staging directories in the workspace.

The installed `imp test //...` returned exit 1 with 57/58 units passed. The
engine environment test failed because the installed executor did not set
`IMP_CACHE_DIR`. This is an installed-binary environment mismatch. Native
Windows and macOS execution were not checked.

The port preserves the existing pytest summary parser. If pytest prints only
passing summaries and then exits with an error, the parser can report success.
Correcting that behavior requires a separate change.

## Biome package port

The Biome package provides Luau formatting and linting facets, verified tool
acquisition, local installation from declared file artifacts, BUILD discovery,
and focused tests. JavaScript remains available. The consumer check under
`rules/js/biome/testdata` checks real formatting and lint fixes, check-mode
workspace preservation, nested paths with spaces, executable resolution, and
local-source cache separation. Application checks cover `js_app` and `ts_app`
with both `biome.json` and `biome.jsonc`, including configuration-only changes.

The Biome guide documents Luau now. Generated Luau references remain deferred
to `2026-09-30-integrate-luau-workspace-tests-and-docs`. The Biome task's
reference-generation acceptance criterion remains incomplete until that work
lands.

### Biome validation commands

From the repository root on Linux, with the checkout binary built by
`cargo build`:

| Command | Result |
| --- | --- |
| `cargo build` | Exit 0. |
| `IMP_RUNTIME=luau target/debug/imp test //rules/js/...` | Exit 0; 44/44 units passed. |
| `IMP_RUNTIME=luau target/debug/imp test //rules/...` | Exit 0; 595/595 units passed. Four action failures are expected CMake negative-test cases. |
| `python3 rules/js/biome/testdata/consumer_check.py --imp target/debug/imp` | Exit 0; real format, lint, failure, and local-cache checks passed. |
| `PATH="$PWD/target/debug:$PATH" imp fmt //...` | Exit 0; 61 unchanged, 0 changed, 0 failed. |
| `PATH="$PWD/target/debug:$PATH" imp lint //...` | Exit 0; 46 clean, 0 fixed, 0 failed. |
| `cargo test --workspace` | Exit 0; 569 tests passed. |
| `PATH="$PWD/target/debug:$PATH" imp test //...` | Exit 0; 58/58 units passed with the checkout binary. |

The installed binary's `imp test //...` returned exit 1: 57/58 units passed.
`environment_tests::imp_sandbox_test_reuses_imp_cache_and_has_writable_xdg_cache_home`
failed with `Imp test sandboxes must share IMP_CACHE_DIR`. The direct Cargo
workspace run and the checkout-binary rerun passed this test. No Rust source
changed in the Biome port.

Independent review found that application facets omitted Biome configuration.
The fix declares package-local `biome.json` and `biome.jsonc` as action inputs
and copies them into the lint working tree. The consumer check verifies both
application factories, both configuration extensions, and configuration-only
cache invalidation. The reviewer checked the fix and found no further issues.

## Tree-sitter package port

The Tree-sitter port adds Luau grammar roots, two built-in Cargo executable
packages, native rule tests, and the `roundtrip` test target. The external
consumer check under `rules/treesitter/testdata` runs the JSON round-trip and
checks Odin analysis, source edits, and failure propagation. The JavaScript
modules remain for the current Odin consumer and documentation build.

The guide documents the Luau support roots. Generated Luau references remain
deferred to `2026-09-30-integrate-luau-workspace-tests-and-docs`. The
Tree-sitter task's reference-generation acceptance criterion remains incomplete
until that integration work lands.

### Tree-sitter validation commands

From the repository root on Linux, with the checkout binary:

| Command | Result |
| --- | --- |
| `cargo build -p imp` | Exit 0. |
| `IMP_RUNTIME=luau target/debug/imp test //rules/treesitter/...` | Exit 0; 5/5 units passed, including the grammar round-trip. |
| `python3 rules/treesitter/testdata/consumer_check.py --imp target/debug/imp` | Exit 0; JSON round-trip, Odin analysis, source edits, and missing-file failure passed. |
| `IMP_RUNTIME=luau target/debug/imp test //rules/...` | Exit 0; 600/600 units passed. Four action failures are expected CMake negative-test cases. |
| `target/debug/imp test //rules/treesitter/...` | Exit 0; 2/2 JavaScript-path units passed. |
| `PATH="$PWD/target/debug:$PATH" imp fmt //...` | Exit 0; 61 unchanged, 0 changed, 0 failed. |
| `PATH="$PWD/target/debug:$PATH" imp lint //...` | Exit 0; 46 clean, 0 fixed, 0 failed. |
| `PATH="$PWD/target/debug:$PATH" imp test //...` | Exit 0; 58/58 units passed, including 5 documentation quality tests. |

## Host API test triage outcomes

`2026-10-10-triage-unported-luau-host-api-tests` reviews each deferred case
separately. The remaining cases are still open.

- **Ported: `action_cores_test.js`.** `rules/imp/action_cores.test.luau` checks
  action core requests, the default, and invalid values through the existing
  action fake. The Rust test
  `luau_action_cores_match_scheduler_admission_and_environment` checks real
  actions, scheduler lanes, budget limits, and both environment placeholder
  spellings. Interactive programs remain unchanged. Keep the JavaScript module
  until QuickJS removal.

### Product test outcomes

Luau keeps explicit graph dependencies and goal slots. It does not add the
JavaScript product registry. `rules/imp/product.test.luau` provides the graph
coverage below. Keep `product_test.js` until QuickJS removal. All other
unresolved host API cases remain open.

| JavaScript test | Outcome and reason |
| --- | --- |
| Returns a callable memoized function | Equivalent test: two consumers share a producer task, receive its computed value, and execute the producer once while resolving their common parent. |
| Different args produce different results | Equivalent test: tasks made by the same computation helper receive different declared inputs and return their expected results. |
| Product and memo of the same function have independent caches | Dropped: Luau has no product wrapper, and `core.memo` returns its function unchanged. The JavaScript test name says the caches are independent, but its assertion requires a shared cache. |
| Requires a declared tool token | Dropped: Luau has no product registration API. |
| Two tools can register the same product and both dispatch | Dropped: Luau selects explicit graph roots instead of registered product functions. |
| `productFor` rejects a role registered by several tools | Dropped: Luau selects an explicit dependency instead of resolving an implicit product provider. |

### Graph identity and nested resolution test outcomes

Luau keeps explicit task handles and its current resolution boundaries.
`rules/imp/graph_identity.test.luau` provides the coverage below. Keep
`graph_identity_test.js` until QuickJS removal. Its three diagnostic tests
belong to the separate files and test.resolve diagnostic tasks.

| JavaScript test | Outcome and reason |
| --- | --- |
| tasks differing only in display are distinct nodes | Equivalent test: separate declarations with different displays execute independently and return distinct callback results. |
| tasks with an identical display still dedupe | Excluded: each Luau task declaration creates a distinct handle. A replacement test verifies independent execution with identical displays. Share work by reusing a handle. |
| tasks with no authored display dedupe on their inputs | Excluded: matching inputs do not merge separate Luau declarations. A replacement test verifies independent execution without displays. |
| display does not override a real difference in outputs | Equivalent test: tasks with the same display and different output declarations both execute and return the expected output. |
| a task body may resolve handles without tearing down its invocation | Equivalent test: an outer task resolves a previously consumed dependency and a flag-reading task. The dependency executes once, and the goal flag remains available after nested resolution. The existing goal-flags fake surrounds the outer resolution. |
| resolveGraphHandle opens an invocation when called outside one | Excluded: core.test.resolve does not open a new invocation for each call. A replacement test resolves the same output twice in one case and verifies one callback execution. |

These outcomes add no host API or runtime behavior. Action caching remains
separate from task result reuse. The other unresolved host API cases remain
open.

### File argument diagnostic outcomes

Luau retains declaration-time validation for glob file selections. The
`file selection arguments` suite in `rules/imp/graph_identity.test.luau`
checks `files`, `glob`, and `builtin_files`. Each error names the constructor.
Keep `rules/imp/graph_identity_test.js` until QuickJS removal.

| Source test | Outcome |
| --- | --- |
| files() rejects options with no include patterns | Equivalent Luau coverage: an empty options table and a root-only table fail with an Imp diagnostic that requires include glob patterns. |
| files() rejects a bare list of patterns | Equivalent Luau coverage: positional pattern tables fail with an options-table diagnostic. By user decision, mixed positional entries and named include also fail instead of silently ignoring the entries. |
| files() rejects an empty include list (existing Luau test) | Retained: files({ include }) requires glob patterns. The shared suite also checks the corresponding glob and builtin_files names. |

The suite checks valid named glob options too. Existing exact-file tests keep
the valid empty `paths` list, rejected combinations of exact and glob options,
and exact-selection error precedence. Exact-selection checks run before the
new glob checks. Other field conversions and unknown string-key behavior are
unchanged. No host API or test fake is added. The `test.resolve` diagnostic
case remains separate work.

### Tracked API test outcomes

Luau keeps declared tools, configured action environments, artifact reads, and
goal-boundary workspace publication. It does not add the legacy host query,
command, mutation, or memo APIs. Keep `rules/imp/tracked_apis_test.js` until
QuickJS removal. Each source test has an outcome below.

| JavaScript test | Outcome and reason |
| --- | --- |
| env returns a string for PATH | Excluded: Luau has no direct host env query. Actions receive configured environment entries; this does not provide a rule-level PATH string. |
| env returns null for an unset variable | Excluded: Luau has no direct host env query or null result for an unset host variable. |
| env records an effect entry in memo trace | Excluded: Luau does not record memo effect traces. |
| which returns a string path for sh | Excluded: native_tool declares an opaque tool handle instead of returning a host executable path. The native_tool suite covers tool use on the action PATH. |
| which returns null for a nonexistent binary | Excluded: a missing native tool fails action execution instead of returning null. The native_tool suite covers that failure. |
| which records an effect entry in memo trace | Excluded: Luau does not record memo effect traces. |
| configuration returns configured workspace values | Equivalent test: tracked_apis.test.luau checks that configure deep-merges the values returned by configuration. |
| workspace configuration changes memo identity | Excluded: core.memo returns its function unchanged and has no memo identity or cache to invalidate when configuration changes. |
| paths(glob(...)) returns an array of strings | Equivalent test: file_set.test.luau checks that exec.paths returns workspace-relative strings from a glob selection. |
| paths(glob(...)) records a paths effect entry in memo trace | Excluded: Luau does not record memo effect traces. The path query has separate graph coverage. |
| run executes a command and returns exitCode 0 | Equivalent test: the tracked action results suite runs a real sandboxed action and checks exit code zero and stdout. |
| run records an effect entry in memo trace | Excluded: Luau does not record memo effect traces. |
| run redacts literal environment values in its effect trace | Excluded: Luau has no memo effect trace to redact. This outcome makes no broader claim about log redaction. |
| memo calling env still deduplicates on repeated calls | Excluded: core.memo is an identity function, and Luau has no direct env query. Shared task execution has separate graph coverage. |
| read_file reads a file written by run | Equivalent test: the tracked action results suite reads a declared action output through exec.digest and core.read_file_in_digest. It does not read a host temporary file after sandbox removal. |
| withFakeRun: run() resolves without executing and still traces | Equivalent action coverage: the with_fake_run suite records an action without executing its failing command, returns exit code zero, and checks its declared output handle. The memo trace assertions are excluded. Fake artifact contents are not verified. |
| run() single-flights concurrent calls with identical opts | Excluded from this cutover: Luau has no legacy run API. Equivalent concurrent-action protection is deferred; task result reuse does not establish it. Track that protection with 2026-10-25-share-concurrent-luau-action-execution alongside 2026-10-13-run-luau-actions-concurrently. |
| getMemoTrace includes key_display with function name | Excluded: Luau does not record memo traces or memo key display labels. |
| memo cycle errors include a readable call chain | Excluded: core.memo returns its function unchanged and has no memo cycle detector. Graph dependency cycle diagnostics are a separate contract. |
| workspace_mutation with watch reports changed files | Excluded: Luau has no command-and-watch workspace_mutation API. Sandboxed generation, digest comparison, and goal-boundary publication have separate coverage; they do not provide equivalent watch semantics. |

The native-tool coverage is in `rules/imp/native_tool.test.luau`. Environment
forwarding is covered by
`luau_workspace_passthrough_env_reaches_sandboxed_actions`. Namespaced source
reads are covered by `read_file_reads_namespaced_files_and_decodes_json`.
Artifact flow and publication boundaries are covered by
`luau_task_outputs_flow_through_cas_to_downstream_actions` and
`workspace_effects_require_a_goal_callback`. The generate workflow tests cover
digest comparison and declared workspace writes. These checks do not restore
the excluded host APIs or command-and-watch semantics.

**Planned:** Sprint triage must consider
`2026-10-25-share-concurrent-luau-action-execution` with
`2026-10-13-run-luau-actions-concurrently`. The follow-up requires identical
cacheable calls to share execution and results, failure propagation to all
callers, and bypass for non-cacheable calls. It remains proposed; this outcome
does not change the concurrency task's acceptance criteria or add action
concurrency now.

### Target schema test outcomes

Luau uses explicit graph handles and rule functions. It does not add the
JavaScript `Target` attribute schema model or its target-kind registry.
Each test in `rules/imp/target_schema_test.js` is excluded below. Keep the
JavaScript module until QuickJS removal. The other unresolved host API cases
remain open.

| JavaScript test | Outcome and reason |
| --- | --- |
| fills declared defaults | Dropped: Luau has no `Target` attribute schema that applies defaults to target attributes. |
| throws on a missing required field | Dropped: Luau has no `Target` attribute schema that declares required target attributes. |
| throws on an undeclared attrs key | Dropped: Luau has no `Target` attribute schema that restricts target attribute keys. |
| throws on a type mismatch | Dropped: Luau has no `Target` attribute schema that declares target attribute types. |
| keeps a target-typed field as the live handle, not a validated copy | Dropped: Luau passes graph handles through explicit dependencies; it has no target-typed attribute schema field to validate or copy. |
| targetSchemas() reflects the declared schema by kind | Dropped: Luau has no target-kind schema registry to inspect. |
| a subclass without its own schema inherits its ancestor's | Dropped: Luau has no `Target` class hierarchy or inherited target attribute schemas. |
| a subclass's schema merges over its ancestor's, own fields winning | Dropped: Luau has no `Target` subclass schema composition or field overrides. |
| targetSchemas() reports the composed shape for a subclass kind | Dropped: Luau has no composed subclass schemas or target-kind schema registry. |

Workspace configuration schemas validate workspace settings. They do not
replace target attribute schemas, so their tests are not replacement coverage
for these exclusions.

**Planned:** `2026-09-30-remove-quickjs-after-luau-cutover` must decide the
future of `imp rules schema` before removing its JavaScript target schema
registry. This triage records that follow-up; it does not select replacement
CLI behavior or change the command.

## Odin package port

The Odin port adds Luau compiler and formatter providers, deferred source
analysis and package expansion, native dependency staging, generated sources,
BUILD generation, examples, and focused tests. It excludes `rules/odin/vscode`
and the VS workflow. JavaScript modules remain for compatibility and the
existing reference build. The boundary has 19 Luau authoring modules.

The guides document Luau now. Generated Luau references remain assigned to
`2026-09-30-integrate-luau-workspace-tests-and-docs`. The Odin task's
reference-generation acceptance criterion remains incomplete until that work
lands.

BUILD generation relies on runtime import inference rather than serialized
cross-target references. Generated test targets include ordinary files from
their package directory. Existing package directories are left unchanged,
including when a test file is added after generation. The consumer check
verifies that repeated generation preserves the existing BUILD file.
Interactive run roots use `core.program` and preserve
CLI argument forwarding while loading binaries from their staged sandbox.

### Odin validation commands

From the repository root on Linux, use the checkout binary:

```sh
cargo build -p imp
IMP_RUNTIME=luau target/debug/imp test //rules/odin/...
python3 rules/odin/testdata/consumer_check.py --imp target/debug/imp
```

The consumer check covers build, run, test, lint, format, package, BUILD
and lockfile generation, modes and profile defines, native and CMake
libraries, generated sources, source edits, and failure propagation. Windows
command construction is covered by focused tests; real Windows execution is
not validated by the Linux consumer check.

Verified on Linux with the checkout binary:

| Command | Result |
| --- | --- |
| `cargo build -p imp` | Exit 0. |
| `cargo test --workspace` | Exit 0; 578 tests passed. |
| `IMP_RUNTIME=luau target/debug/imp test //...` | Exit 0; 633/633 units passed. Four action failures are expected CMake negative-test cases. |
| `python3 rules/odin/testdata/consumer_check.py --imp target/debug/imp` | Exit 0; all consumer scenarios passed. |
| `imp fmt //...` | Exit 0; 61 unchanged, 0 changed, 0 failed. |
| `imp lint //...` | Exit 0; 46 clean, 0 fixed, 0 failed. |
| `PATH="$PWD/target/debug:$PATH" imp test //...` | Exit 0; 59/59 units passed. |

The installed launcher also ran `imp test //...`. It passed 58/59 units.
The cache-environment test failed because its sandbox did not receive
`IMP_CACHE_DIR`. The checkout binary passed that test and the full suite.

A direct-tool probe found that the pinned `dev-2026-03` odinfmt executable
can turn a valid, long single-line procedure with a loop into invalid Odin.
`odin check` passed before the direct `odinfmt -w` call and failed after it.
This is a separate formatter defect; the guide records the multiline-block
workaround. The port does not change the formatter executable or its version.

### Ruff Luau port boundary

The Ruff port adds the toolchain, separate format/lint facets, mapped lint
inputs, and Python graph/documentation tests. Source selection stays unchanged;
source paths remain individual argv entries. The guides document Luau.
Generated Luau references remain with
`2026-09-30-integrate-luau-workspace-tests-and-docs`. The Ruff
reference-generation acceptance criterion remains incomplete until that work
lands. JavaScript modules remain available during migration.

The boundary contains nine Luau authoring modules. Existing Python core tests
cover the non-Ruff cases from `graph_test.js`; the Ruff graph tests add the
facet, configuration, mapping, and workflow-result checks. JavaScript tests
remain available to the default runtime.

**Verified:** From the checkout root with `target/debug` first in `PATH`:

| Command | Result |
| --- | --- |
| `IMP_RUNTIME=luau target/debug/imp targets //rules/python/...` | Python and Ruff test roots discovered |
| `IMP_RUNTIME=luau target/debug/imp test //rules/python:rules_test //rules/python/ruff:rules_test` | 71/71 passed |
| `python3 rules/python/ruff/testdata/consumer_check.py --imp target/debug/imp` | Ruff consumer check passed |
| `python3 rules/python/testdata/consumer_check.py --imp target/debug/imp` | Python core consumer check passed |
| `IMP_RUNTIME=luau target/debug/imp test //rules/...` | 656/656 passed; exit 0 |
| `imp fmt //...` | 61 unchanged, 0 changed, 0 failed |
| `imp lint //...` | 46 clean, 0 fixed, 0 failed |
| `imp test //...` | 59/59 passed |
| `git diff --check` | Passed |

The Luau rules run also reports four failed sandbox actions from negative
tests. All test units pass. Native Ruff execution was checked on Linux;
platform-specific acquisition paths use fake-host tests. No native Windows
or macOS execution was checked. The tree is not committed or submitted.

An independent review found that local installation copied a directory onto
itself when the source artifact was already rooted at `captured-ruff`. The
capture step now skips the copy when the paths are equal. The Ruff consumer
check uses that directory name for both path-handle and artifact installation,
and still checks that changed source bytes select a different cache path.
After this fix, the package tests passed 71/71, the Ruff consumer check
passed, and `git diff --check` passed.

### Odin VS Code Luau port boundary

The port adds six Luau authoring modules for `rules/odin/vscode` and
`rules/workflows/vs`: two BUILD modules, two implementation modules, and two
test modules. JavaScript modules remain available during migration. By user
decision on 2026-10-24, the Luau goal generates VS Code files only. Visual
Studio output is deferred. The goal keeps the name `vs`.

The Odin hook now supplies a lazy metadata handle as its second argument.
Existing hooks can keep their one-argument form. Metadata shares the package
source analysis and binary layout calculation. It does not resolve a selected
package's compile action. Launch paths refer to files published by `package`,
including the executable inside a shared-library bundle. Debug and Release
tasks select `opt=debug` and `opt=release`. Libraries and test packages get
package tasks without launch entries.

`core.digest_from_text(files)` creates a directory-tree digest from a map of
relative paths to text. `core.json_encode(value)` performs JSON encoding as a
separate operation. The goal publishes the digest with
`core.write_workspace(".vscode", digest, { merge = true })`. The merge preserves
unrelated files, rejects existing destination symlinks and file/directory
conflicts before writing, and keeps the old replacement behavior as the
default. Publication is atomic per file, not across the complete digest.

The consumer check runs all emitted package commands in Debug and Release and
checks the actual launch paths for standalone and bundled executables. It also
checks stable output, preserved settings, unchanged `.vs` contents, and source
edits that add or remove a main entrypoint. Native execution is checked on
Linux. Windows metadata and debugger fields use fake-host tests; no Windows
editor or debugger session is checked.

Generated Luau API references remain with
`2026-09-30-integrate-luau-workspace-tests-and-docs`. This task's reference
criterion remains incomplete until that work lands.

**Verified:** on 2026-10-24, from the checkout root:

| Command | Result |
| --- | --- |
| `cargo test --workspace` | Passed. |
| `IMP_RUNTIME=luau target/debug/imp test //rules/odin/... //rules/workflows/vs/... //rules/workflows/package/...` | 41/41 units passed. |
| `python3 rules/odin/vscode/testdata/consumer_check.py --imp target/debug/imp` | VS Code consumer check passed. |
| `IMP_RUNTIME=luau target/debug/imp test //...` | 665/665 units passed. Four failed sandbox actions are expected negative cases. |
| `target/debug/imp test //...` | 59/59 units passed. |
| `target/debug/imp fmt //...` | 61 unchanged, 0 changed, 0 failed. |
| `target/debug/imp lint //...` | 46 clean, 0 fixed, 0 failed. |
| `IMP_RUNTIME=luau target/debug/imp fmt //...` | 13 unchanged, 0 changed, 0 failed. |
| `IMP_RUNTIME=luau target/debug/imp lint //...` | 13 clean, 0 fixed, 0 failed. |
| `git diff --check` | Passed. |

The independent review found a portability gap in merge preflight: paths such
as `A` and `a/child` can conflict on a case-insensitive filesystem after a write
has started. Text-digest creation and merge publication now reject paths and
directory prefixes that differ only in case on every host. The regression
failed before the fix and passed after it. It covers file/file,
file/directory, and directory-prefix aliases, and checks that rejection writes
no workspace files. The reviewer checked the fix and reported no additional
findings. The platform and publication limits above remain unchanged.

## Imp generate validation port

This boundary completes `rules/imp/generate_test.js` in the existing
`rules/imp/generate.test.luau` module. It owns one Luau authoring module. The
JavaScript tests remain available during the compatibility period. No public
API or host change is required.

| JavaScript behavior | Luau evidence |
| --- | --- |
| Graph handle with one file for each output path | The resolved task has `out1` and `out2` artifact userdata and a workspace `before` digest. |
| One action output for each path; tools separate from inputs | The run fake records named output slots, tool names, and input counts. The mounted odinfmt case declares no source inputs. |
| Mounted Odin formatter | The toolchain fake resolves the verified formatter provider and records its mounted executable. The consumer runs the real formatter. |
| Generator takes no check flag | The fake records the same command and cache policy in both modes. The consumer verifies zero fresh actions when switching modes. |
| Required output paths and argv; conflicting tool/input names | Focused cases check the Luau diagnostics. |
| Empty, exact-path, and ancestor-directory diffs | Scoped diff cases check staleness and exclude unrelated paths. |
| Publish every declared file | The write fake checks both files, their digests, and their `from` paths, even when only one file is stale. |
| Check mode never publishes; errors name only stale files | The write fake records no calls. The consumer checks absent files and unchanged drifted content. |
| Invalid generate root | The workflow case checks the root address and diagnostic. |

The Luau action fake has no `materialize` field. The consumer instead verifies
that a failed first `generate --check` leaves every output absent. Thus it
checks the CAS-only behavior through the public goal boundary.

Run the consumer from the checkout root:

```sh
python3 rules/imp/testdata/generate_consumer_check.py --imp target/debug/imp
```

It uses a temporary workspace and the normal Imp cache. A shell generator
writes two files. The check verifies first-run drift, publication, unchanged
check results, one-file drift, repair, and source-change invalidation. Warm
runs must report zero fresh sandbox actions and at least one cached action.
A second root uses the shipped, verified `dev-2026-03` odinfmt toolchain. It
formats a generated copy, preserves the source, and passes a subsequent
check. An unrelated sentinel file must stay unchanged throughout.

**Verified:** on 2026-10-24, from the checkout root:

| Command | Result |
| --- | --- |
| `cargo build` | Passed. |
| `IMP_RUNTIME=luau target/debug/imp test //rules/imp:rules_test //rules/odin/odinfmt:rules_test` | 146/146 units passed. |
| `python3 rules/imp/testdata/generate_consumer_check.py --imp target/debug/imp` | Consumer check passed, including real odinfmt and cached generation after drift. |
| `IMP_RUNTIME=luau target/debug/imp test //...` | 671/671 units passed. Four failed CMake scan actions are expected negative cases in `rules/c/cmake/scan.test.luau`. |
| `PATH="$PWD/target/debug:$PATH" imp fmt //...` | 61 unchanged, 0 changed, 0 failed. |
| `IMP_RUNTIME=luau target/debug/imp fmt //...` | 13 unchanged, 0 changed, 0 failed. |
| `IMP_RUNTIME=luau target/debug/imp lint //...` | 13 clean, 0 fixed, 0 failed. |
| `cargo test --workspace` | All suites passed. |
| `PATH="$PWD/target/debug:$PATH" imp lint //...` | 46 clean, 0 fixed, 0 failed. |
| `PATH="$PWD/target/debug:$PATH" imp test //...` | 59/59 units passed. |
| `git diff --check` | Passed. |

## Built-in lockfile aggregator port

The Luau `@imp/rules/workflows/builtin_lockfiles` module imports all shipped
toolchain modules. Its `gen-builtin-lockfiles` goal uses a selectorless roots
provider to declare authoritative regeneration tasks for every registered
lockfile. The shared lockfile callback publishes their resolved artifacts.
The repository Luau workspace imports this workflow. JavaScript modules remain
available during the compatibility period.

The authoring boundary is the aggregator and the existing lockfile test
module. Tests check all 18 shipped registrations, the platform matrices, and
regeneration to the registered versions. Downloads are faked in these tests.
The consumer check uses a local HTTP artifact and the same selectorless-goal
and lockfile runtime APIs. It checks the actual SHA-256 and size, removal of
stale versions, repeatable bytes, and preservation after a failed download.
It does not download the shipped toolchain archives.

Focused validation commands from the repository root:

```sh
cargo test -p imp-engine selectorless_goal_roots_resolve_before_publication
IMP_RUNTIME=luau target/debug/imp test //rules/workflows/lockfiles:rules_test
python3 rules/workflows/lockfiles/testdata/consumer_check.py --imp target/debug/imp
```

**Deferred:** generated references still use JavaScript extraction. On
2026-10-24, the user chose to defer Luau extraction from this task. The workflow
guide and authoring contract describe the Luau API, but the generated-reference
acceptance criterion remains unmet. A later task submission must report that
gap and remain in review.

Validation on 2026-10-24:

| Command | Result |
| --- | --- |
| `cargo test -p imp-engine selectorless_goal_roots_resolve_before_publication` | Passed. Covers ordered results, validation before execution, provider/task failures, and workspace-write boundaries. |
| `cargo test --workspace` | Passed on the final Rust source. |
| `IMP_RUNTIME=luau target/debug/imp test //rules/workflows/lockfiles:rules_test` | 27/27 units passed. |
| `python3 rules/workflows/lockfiles/testdata/consumer_check.py --imp target/debug/imp` | Passed, including the expected HTTP 404 failure case. |
| `target/debug/imp fmt //...` | 61 unchanged, 0 changed, 0 failed on the final run. |
| `target/debug/imp lint //...` | 46 clean, 0 fixed, 0 failed after the options-struct fix. |

The first broad `target/debug/imp test //...` run passed 58/59 units.
`spike::tests::graph_expansion_all_children_start_concurrently` observed one
active child where it expected two. This existing JavaScript test passed in
both workspace Rust runs. Its source was not changed by this port.

The final `target/debug/imp test //...` retry passed 59/59 units.
`target/debug/imp lint //docs:quality` also passed after the documentation
updates. The earlier concurrency assertion failure remains recorded above as
an intermittent test observation; this task does not change that test.


### File-set and action-input test outcomes

The user retained exact regular-file selection and action staging from several
declared handles. Luau excludes a reusable union handle and raw input
specifications. Keep both JavaScript modules until QuickJS removal.
`core.files({ paths })` bypasses glob matching and ignore rules. Unlike the
legacy literal path list, its resolved paths omit missing files and duplicate
paths so they agree with its captured tree. It rejects directories and
symlinks. The authoring contract defines the API and its limits under
[Select exact workspace files](luau-authoring-contract.md#select-exact-workspace-files).

The following rows cover every test in `file_set_test.js`, in source order.
Replacement cases are in `rules/imp/file_set.test.luau` unless stated otherwise.

| JavaScript test | Outcome and reason |
| --- | --- |
| an isolated test may mutate module state | Equivalent: a case may change module state. |
| the next test receives a fresh module instance | Equivalent: the next case gets a fresh module instance. |
| glob() returns a FileSet descriptor, not paths | Equivalent: glob returns an opaque graph handle. JavaScript descriptor fields and process-isolation syntax are excluded from this case. |
| glob() records no effect entry on its own | Excluded: Luau does not record legacy memo effects. |
| paths(glob(...)) returns a non-empty string array | Equivalent: exec.paths returns workspace-relative strings. |
| paths(glob(...)) supports double-star patterns | Equivalent: glob patterns support double stars. |
| paths(glob(...)) result is sorted | Equivalent: exec.paths is sorted. |
| file_set.union() returns a union FileSet | Excluded: no reusable union handle or descriptor API. Actions accept separate declared handles. |
| paths(file_set.union(a, b)) is deduplicated and sorted | Excluded: no union path-query API. Sorted unique paths remain covered for individual glob and exact selections. |
| paths(file_set.union(a, b)) contains paths from both sets | Excluded: no union path-query API. Combined action staging has separate coverage below. |
| file_set.literal() returns a literal FileSet | Equivalent: core.files({ paths }) returns an opaque files handle. JavaScript descriptor fields are excluded. |
| paths(file_set.literal([...])) returns sorted paths | Equivalent: exact paths are sorted unique existing workspace files. Missing files are omitted rather than returned as requested names. |
| paths() throws on a plain string | Equivalent: exec.paths rejects a plain string. Exact JavaScript error text is excluded. |
| file_set.union() throws if given a non-FileSet value | Excluded: no union constructor to validate. |
| memo wrapping paths(glob(...)) deduplicates correctly | Excluded: core.memo remains an identity function under the existing memo decision. |

The following rows cover every test in `run_fileset_test.js`, in source order.
Replacement cases are in `rules/imp/run_fileset.test.luau` unless stated otherwise.

| JavaScript test | Outcome and reason |
| --- | --- |
| run accepts a glob FileSet in inputs | Equivalent: stages glob files into the sandbox. |
| run copies glob files into sandbox | Equivalent: stages glob files into the sandbox; stages only the matched files. |
| run accepts a literal FileSet in inputs | Equivalent: stages exact paths into the sandbox. |
| run accepts a union FileSet in inputs | Equivalent staging: stages separate overlapping glob and exact inputs. The union constructor is excluded. |
| run accepts empty inputs array | Equivalent: accepts an empty input list. |
| run accepts mixed FileSet and plain spec in inputs | Equivalent staging: stages separate overlapping glob and exact inputs. Raw specifications are excluded; actions reject legacy plain input specifications. |
| materialising a FileSet input records a paths effect entry | Excluded: Luau does not record legacy memo effects. Shared capture and digest behavior has focused replacement coverage without trace assertions. |
| output returns a file spec by default | Equivalent: output.file declares a file artifact, covered by existing codegen tests. The generic output() function and JavaScript descriptor shape are excluded. |
| output respects explicit kind | Equivalent: output.directory declares a directory artifact, covered by existing toolchain tests. The generic output() function and JavaScript descriptor shape are excluded. |

Rust integration coverage checks literal pattern characters, ignored files,
missing paths, shared capture, regular-file restrictions, ownership, and exact
change detection. Scoped fake-run coverage checks real paths and digest
content without running an action. Real action tests check sandbox staging.

Generated-file snapshots remain unchanged. Their current use of glob selection
and ignore rules is a follow-up; their existing rejection of glob characters
in output paths remains in place. This case does not settle the other pending
host API cases and does not authorize JavaScript test removal.

The digest tree-listing helper also needs a separate review: its documentation
promises sorted paths, but recursive traversal can return `a/item` before
`a.txt`. Exact selection sorts its captured paths locally and has regression
coverage for this case. This task does not change the shared helper.

#### File-set verification

**Verified:** on 2026-10-25, from the checkout root on Linux. No alternate
cache root or rules override was set.

| Command or check | Result |
| --- | --- |
| `cargo build -p imp --quiet` | Exit 0. |
| `cargo test -p imp-engine --lib exact_files --quiet` | Exit 0; 5 passed, including nested-path ordering and shared capture after workspace edits. |
| `cargo test --workspace --quiet` | Exit 0; all suites passed, including 341 engine library tests. |
| `IMP_RUNTIME=luau target/debug/imp test //rules/imp:rules_test` | Exit 0; 148/148 units passed. |
| `IMP_RUNTIME=luau target/debug/imp test //...` | Exit 0; 692/692 units passed. Four failed CMake scan actions are expected negative cases. |
| `imp fmt //...` | Exit 0; final pass: 61 unchanged, 0 changed, 0 failed. |
| `imp lint //...` | Exit 0; 46 clean, 0 fixed, 0 failed. |
| `PATH="$PWD/target/debug:$PATH" imp lint //...` | Exit 0; 46 clean, 0 fixed, 0 failed on the final Rust implementation. |
| `imp test //...` | Exit 1; 58/60 units passed with the installed September 29 binary. The engine cache-environment check and the workflow no-handler warning tests failed. |
| `target/debug/imp test //...` | Exit 0; 60/60 units passed on the final implementation, including both units that failed with the installed binary. |
| `IMP_RUNTIME=luau target/debug/imp fmt //...` | Exit 0; 13 unchanged, 0 changed, 0 failed. |
| `IMP_RUNTIME=luau target/debug/imp lint //...` | Exit 0; 13 clean, 0 fixed, 0 failed. |
| `python3 -m unittest discover -s docs -p quality_check_test.py` | Exit 0; 5 tests passed. |
| Python comparison of JavaScript test names and outcome rows | Exit 0; 24/24 exact names matched in source order. |
| `PATH="$PWD/target/debug:$PATH" imp lint //docs:quality` | Exit 0; 1 clean, 0 fixed, 0 failed. |
| `git diff --check` | Exit 0. |

An intermediate full Luau run exited 1 because a concurrent Cargo check
replaced the running `target/debug/imp` binary. The self-tool check then tried
to canonicalize an executable path with a ` (deleted)` suffix. The full rerun
after Cargo finished passed 692/692 units. No self-tool behavior was changed.

The installed binary is `/home/ts/.local/bin/imp`, dated 2026-09-29. Its engine
failure was `Imp test sandboxes must share IMP_CACHE_DIR`. Its workflow suite
failed the two cases that expect one warning for selected targets with no
format or lint handler; both observed zero warnings. The checkout binary
passed these checks. This task does not change cache-environment or workflow
warning behavior.

The generated-file snapshot and shared tree-listing follow-ups above remain
outside this delivery. The JavaScript tests and the other pending host API
cases remain in place.

## Workspace integration checks

The Luau repository declarations cover the root resources, Cargo packages, CI
generation, documentation, and shipped rule packages.
`ci/check_luau_workspace.py` checks missing BUILD counterparts against explicit
exclusions and verifies target workflows with the checkout CLI. It also
checks Odin libraries without RUN children and enabled C, Rust, and Odin
generators. A zero-file generation check means the declarations already own
the relevant source directories; it is not a count of enabled generators.

The remaining JavaScript-only BUILD files are formatting inventories, the
QuickJS test harness and its build-workflow tests, and the illustrative
`examples/proposed-rules` proposal. The check records the reason for each
exclusion. JavaScript application example sources remain application inputs.

Generated references use the pinned Luau Tree-sitter grammar, source `---`
comments, and the documentation-only host declarations. The generated public
reference replaces the JavaScript reference. The rule library still ships
as files beside the executable. QuickJS removal remains a separate task.
