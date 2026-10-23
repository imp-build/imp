The Odin rules let build authors compile packages, run tests, check source,
run binaries, and publish artifacts through the Luau graph. Import
`@imp/rules/odin/odinfmt` to add formatting before you declare packages.

<!-- capabilities -->

## Public API

Use `odin_package(options)` and `odin_test_package(options)` from
`@imp/rules/odin`. Options use snake_case. The JavaScript implementation stays
available during the runtime migration. These examples use Luau.

An ordinary package provides build, lint, package, and run roots. The run root
is usable only when the package has a `main` entrypoint. A test package
provides build, lint, package, and test roots. An imported formatter extension
adds a format root to both kinds of package.

## Set up a workspace

Create `imp.workspace.luau` at the workspace root:

```lua
require("@imp/rules/odin")
require("@imp/rules/odin/odinfmt")
require("@imp/rules/workflows/build")
require("@imp/rules/workflows/test")
require("@imp/rules/workflows/run")
require("@imp/rules/workflows/fmt")
require("@imp/rules/workflows/lint")
require("@imp/rules/workflows/package")
require("@imp/rules/workflows/lockfiles")
return {}
```

Select the Luau runtime with `IMP_RUNTIME=luau`. Odin imports register the
shared `opt` mode axis and its debug and release profiles. Compiler and
formatter defaults use pinned, verified downloads and shared named caches.
No host Odin installation is required. Do not create a cache for each task.

## Declare packages and tests

In a package's `BUILD.luau`, declare the ordinary sources once:

```lua
local odin = require("@imp/rules/odin")
local lib = odin.odin_package({})
return {
    lib = lib,
    lib_tests = odin.odin_test_package({ deps = { lib } }),
}
```

`path` defaults to the BUILD directory. `base` overrides that directory.
`srcs` and `exclude` contain glob patterns relative to `path`.
`odin_package` defaults to `*.odin` and excludes `*_test.odin` and
`test_*.odin`. `odin_test_package` defaults to those two test globs and
excludes nothing. Set `srcs` when tests use other filenames.

Odin compiles a directory as one package. A same-directory test package needs
the ordinary package in `deps`, as above, so both source sets reach one sandbox
directory. A library builds an archive. A package with a `main` entrypoint
builds an executable. Build outputs stay in CAS until a publishing goal writes
them to the workspace.

From the workspace root, with the runtime selected:

```sh
IMP_RUNTIME=luau imp build //src/lib:lib
IMP_RUNTIME=luau imp test //src/lib:lib_tests
IMP_RUNTIME=luau imp lint //src/lib:lib
IMP_RUNTIME=luau imp fmt --check //src/lib:lib
IMP_RUNTIME=luau imp package //src/lib:lib
```

For a binary target, `imp run //src/app:app -- one "two words"` forwards the
arguments. `--profile release` or `--axis opt=release` selects `-o:speed`;
the default uses `-debug`. Each Odin action reserves four cores and passes
matching compiler and test-runner thread limits. Lint uses `odin check -vet`
and does not apply optimization flags. Lint has no autofix operation.

## Configure collections and defines

Workspace configuration maps collection names to workspace-relative paths:

```lua
return { odin = { collections = { lib = "library" } } }
```

A target's `collections` overrides workspace mappings. Its paths are relative
to `base`. Use a name-to-path map or a list of `{ name, path }` entries.

```lua
local odin = require("@imp/rules/odin")
return {
    app = odin.odin_package({ collections = { local_lib = "vendor" },
        defines = { SHIPPING = "true" } }),
}
```

Tree-sitter analysis follows transitive relative and mapped collection imports.
It includes declared packages and undeclared source directories. Unmapped
collections, such as `core`, remain the compiler's responsibility. A mapped
or relative import with no package produces an error before compilation.

Profiles can supply default defines:

```lua
local core = require("@imp/core")
core.define_profile("shipping", {
    opt = "release", odin = { defines = { SHIPPING = "true" } },
})
```

Define names must be identifiers and values must be strings. Target defines
override profile values. Packages compiled together must agree on each define;
a conflict produces an error. Arguments use sorted define names.

## Select toolchains and workspace lockfiles

`odin_toolchain(version, options)` declares a provider with `tool`, `version`,
linker settings, and a lockfile-generation root. Give the provider or a version
string to a package's `toolchain` option. An explicit provider retains its own
version and linker settings when the workspace default changes.

In the root `BUILD.luau`, export generation roots to make them selectable:

```lua
local odin = require("@imp/rules/odin")
local fmt = require("@imp/rules/odin/odinfmt")
local compiler = odin.odin_toolchain("dev-2026-03", {
    default = true, lockfile = "@workspace/locks/odin.lock",
})
fmt.odinfmt_toolchain(nil, { lockfile = "@workspace/locks/odinfmt.lock" })
return { compiler = compiler, formatter_lock = fmt.odinfmt_gen_lockfiles() }
```

From the workspace root:

```sh
IMP_RUNTIME=luau imp goal gen-lockfiles //:compiler //:formatter_lock
```

The shipped lockfiles are the default. A custom lockfile pins download URLs,
sizes, and SHA-256 values. Missing files or entries fail acquisition and name
the lockfile and generation goal. `unverified = true` explicitly permits an
unverified download. `imp @odin` and `imp @odinfmt` select the current defaults
when their modules are loaded.

Odin and odinfmt releases cover Linux and macOS on x86_64 and aarch64, and
Windows on x86_64. The package rule also requires the managed GCC linker
provider. Its current platform limits apply; a compiler release alone does
not establish package execution on that platform.

## Add native dependencies and generated sources

`deps` accepts Odin packages, graph handles, `{ sources }` or `{ resources }`
records, and Luau C/CMake library records. Archives, shared libraries, Windows
import libraries, and linker flags travel through the transitive source
closure. Each distinct resource is staged once. Unsupported dependency shapes
produce an error.

Use `cc_library` from `@imp/rules/c`, or `cmake_library_dep` from
`@imp/rules/c/cmake`. An Odin `foreign import` must name the captured artifact
path relative to the importing source file. A binary with shared dependencies
is packaged with its libraries beside the executable. Linux tests receive
`LD_LIBRARY_PATH`; Windows tests write the executable beside the DLLs and
reject DLLs from multiple directories.

Set `linker` on `odin_toolchain` to a managed mold provider on Linux. On
Windows, `lld_on_windows = true` selects bundled lld-link. Add `mingw_crt = true`
only when the native dependencies require MinGW CRT archives. Without that
option, Odin retains its normal CRT selection. `unsafe_system_paths = true`
on a package selects GCC aliases that bypass the host-path guard. This option
does not propagate from dependency packages.

`generated_srcs` accepts codegen results or `{ artifact, path }` entries. An
entry's `path` is relative to the package directory. The producing action's
output path must match it exactly. Exclude generated paths from source globs.
Generated sources travel with imported packages. Two artifacts cannot claim
one path. Generated source imports are not scanned; declare their required
sources and native inputs through `deps` or `collections`.

## Generate BUILD modules

Require `@imp/rules/workflows/generate_build` and set
`odin = { build_generate = true }` in workspace configuration. Then run:

```sh
IMP_RUNTIME=luau imp goal generate-build
IMP_RUNTIME=luau imp goal generate-build --check
```

The generator writes `BUILD.luau` declarations for unowned source directories.
Test declarations include their directory's ordinary sources. Relative and
collection dependencies use the package rule's import inference, rather than
serialized target references. Existing declared package directories are not
generated again. Hidden, build, coverage, dist, obj, target, and vendor
directories are excluded by default.

The Odin VS Code integration and VS workflow have a separate migration task.
Generated Luau API references remain with workspace integration. This guide
covers the Luau API before those references are available.
