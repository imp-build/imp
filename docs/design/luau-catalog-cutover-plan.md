# Luau catalog cutover plan

This plan stages the move from JavaScript to Luau for Imp's workspace modules,
rule catalog, and tests. It gives contributors reviewable migration boundaries
and a checkable gate for removing QuickJS. The current Luau runtime is a pilot;
the steps below are planned work, not claims about available behavior.

## Current evidence

The conversion inventory at `probes/js-luau-conversion/inventory.py` reports
212 tracked JavaScript files: 82 production modules, 64 workspace or BUILD
modules, 64 test modules, and 2 excluded examples. It classifies 65 files as
mechanical, 93 as mechanical with review, and 52 as manual redesign. These
counts are triage signals. Review source and imports before assigning work.

The largest rule families are `c` (30 modules), `workflows` (31), `imp` (28),
`python` (25), `js` (23), and `odin` (20). Split large families at package
boundaries and keep redesign work separate. The `asset` package is already the
host and rule pilot. The Luau contract records limits in workspace
configuration, toolchain downloads, and introspection. Add tasks for any
runtime capability a selected batch needs before assigning that batch.

File counts do not measure migration cost by themselves. The three-module
Tree-sitter package imports the Rust and GCC toolchains, build and test
workflows, and uses action outputs, tools, and path helpers. `rules/oci` also
uses declared action outputs and several workflow modules. `rules/zola` needs
toolchain downloads, lockfiles, caches, platform data, and archive extraction.
Check transitive imports and host APIs before treating a small file count as an
early batch.

## Migration sequence

Each row is a candidate task boundary. Package rows own the source modules,
BUILD files, package tests, and `DOC.md` for that boundary. Split a row further
when its import graph crosses an unfinished package or its redesign work needs
separate review.

| Candidate task | Source boundary | Test and documentation boundary | Depends on |
| --- | --- | --- | --- |
| Runtime prerequisites | Luau host APIs required by migrated rules, workspace configuration, toolchains, and test discovery | Focused host tests; update the contract capability matrix | Completed graph-host pilot |
| Workspace and catalog discovery | Root BUILD and workspace configuration; resolver, rule selection, test discovery, and generated BUILD naming | Resolver and selection tests; contract and workspace guide | Runtime prerequisites |
| C rule packages | `rules/c`, split at compiler and subpackage boundaries; separate manual redesign modules | Per-package toolchain tests, lockfiles, BUILD files, and `DOC.md`; consumer check | Workspace and catalog discovery; required runtime APIs |
| Python rule packages | `rules/python`, split at runtime and subpackage boundaries; separate manual redesign modules | Per-package tests, BUILD files, and `DOC.md`; consumer check | Workspace and catalog discovery; toolchain prerequisites |
| JavaScript rule packages | `rules/js`, split across `biome`, `node`, `pnpm`, and root graph APIs | Per-package tests, BUILD files, and `DOC.md`; consumer check | Workspace and catalog discovery; required runtime APIs |
| Rust and Odin rule packages | `rules/rust` and `rules/odin`, split at `kache`, `odinfmt`, `vscode`, and other subpackage boundaries | Per-package tests, BUILD files, and `DOC.md`; generated-source and toolchain checks | Workspace and catalog discovery; required runtime APIs |
| Imp and workflow packages | `rules/imp` and `rules/workflows`, split by subpackage such as `test`, `codegen`, `package`, and `publish` | Per-package tests, BUILD files, and `DOC.md`; generated-output and consumer-graph checks | Workspace and catalog discovery; language/toolchain packages used by each workflow |
| Tree-sitter package | `rules/treesitter`; imports `rules/rust`, `rules/c/gcc`, `rules/workflows/{build,test}`, and `rules/imp/test` | Port the round-trip and graph tests; preserve the `imp test //rules/treesitter:roundtrip` binary check and package documentation | C/GCC and Rust rule packages; `rules/workflows/test` and `rules/imp/test`; graph outputs and tool/path helpers |
| OCI package | `rules/oci` and `rules/oci/toolchain`; imports build, package, publish, native-tool, and OCI toolchain modules | OCI rule and toolchain tests, BUILD files, and `DOC.md`; validate OCI output artifacts and consumer workflows | `rules/workflows/{build,package,publish}`, `rules/imp/native-tool`, and OCI toolchain modules; declared action outputs and tool/path helpers |
| Zola package | `rules/zola` and its lockfile/toolchain modules; imports Imp lockfile, archive, and toolchain modules plus workflow lockfiles | Zola rule and toolchain tests, BUILD files, lockfile, and `DOC.md`; validate download, cache, and platform behavior | `rules/imp/{lockfile,archive,toolchain}` and `rules/workflows/lockfiles`; toolchain downloads, caches, platform data, and archive extraction |
| Workspace, tests, and docs | Repository workspace files, CI config, test fixtures, docs extraction, and documentation source inputs | Workspace integration tests; docs quality tests; regenerate references from source | All production package tasks |
| QuickJS removal | Runtime modules, Cargo manifests, test harnesses, release packaging, and remaining JavaScript authoring files | Full removal gate below; decide the two excluded examples | All in-scope migration tasks |

Package tasks depend on the runtime prerequisites and discovery behavior they
use. Migrate a rule module before any batch that imports it. For example,
Tree-sitter follows the Rust and C/GCC rule packages and the workflow test
modules; OCI and Zola follow their Imp and workflow helper modules. Package
tasks may run in parallel only when their imports do not cross an unfinished
package boundary. The workspace, tests, and docs task depends on all production
package tasks. QuickJS removal depends on every in-scope migration and the
decision for excluded examples. The inventory proposes batches of at most 20
authoring modules; apply that cap when splitting the larger families, and keep
manual redesign modules in separate tasks.

## Compatibility policy

Keep JavaScript as the default while Luau is opt-in through
`imp.workspace.luau`. Keep QuickJS until the removal gate passes. Do not require
JavaScript and Luau modules to interoperate in one graph: the current contract
defines separate module contracts, and no cross-runtime bridge has been
approved. During migration, a Luau workspace may use only the dependency-closed
set of packages available in Luau. State this limit in the contract and user
guides. If this blocks representative consumers, pause package conversion and
settle a compatibility design before extending the runtime.

Keep installed rules outside the executable. Stage Luau rules beside the
binary with the existing rule tree, and preserve the package smoke test for
exe-relative lookup. Do not let workspace files override installed
`@imp/rules` modules.

## QuickJS removal gate

Remove QuickJS only when all conditions below pass on `luau-runtime-migration`:

- Every in-scope workspace, BUILD, production rule, and test module has a Luau
  implementation, or an explicit documented exclusion.
- Every package needed by supported workspace examples and repository CI is
  available through the Luau runtime.
- Tests cover canonical module identity, package ownership, graph identity,
  async execution, diagnostics, toolchain resolution, workspace configuration,
  and test discovery.
- Repository searches and Cargo manifests show no production or test runtime
  dependency on QuickJS or rquickjs.
- Release packaging stages the Luau rule tree beside `imp`; the package smoke
  test resolves and runs it from outside the repository.
- From the repository root, `imp fmt //...`, `imp lint //...`,
  `imp test //...`, and `cargo test --workspace` pass on the migration branch.

Record each command's result and distinguish code failures from toolchain or
environment failures. A focused pass does not replace a failed broad gate.

## Open decisions

- **Compatibility window:** Keep JavaScript as the default until the removal
  gate passes. Revisit if maintaining both runtimes prevents representative
  Luau consumers from using the staged catalog.
- **Excluded examples:** Decide whether the two JavaScript application examples
  remain as language examples or join the Luau migration.
- **Batch ownership:** Confirm exact subpackage splits from import edges and
  `DOC.md` boundaries when triaging each proposed task.
