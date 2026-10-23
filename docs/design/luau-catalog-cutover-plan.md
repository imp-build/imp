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
