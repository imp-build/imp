# C and C++ rules

Declare libraries, executables, and tests with explicit compiler providers.

## Public API

## Luau modules

These modules provide the Luau graph API. `//rules/c/cmake`'s own docs
describe the CMake modules. Imp uses Luau for workspace and BUILD modules.

### Raw targets

`cc_library(options)`, `cc_binary(options)`, and `cc_test(options)` declare
C and C++ graph targets. Options include `generated_srcs`, `output_name`, and
`unsafe_system_paths`. Dependency results expose `transitive_archives`,
`transitive_shared_libs`, `transitive_import_libs`, `transitive_include_dirs`,
`transitive_hdrs`, and `transitive_linkopts`.

The other options (`path`, `srcs`, `hdrs`, `deps`, `toolchain`, `copts`,
`linkopts`, and `shared`) have the same names. The results use the `BUILD`,
`PACKAGE`, `RUN`, and `TEST` slot keys of the workflow modules.
`DEFAULT_CPP_SRCS` and `DEFAULT_CPP_HDRS` are the default globs.

**Illustrative example**

```luau
local c = require("@imp/rules/c")
local gcc = require("@imp/rules/c/gcc")

local toolchain = gcc.default_graph_toolchain()
local lib = c.cc_library({ path = "app/lib", toolchain = toolchain })

return {
	lib = lib,
	app = c.cc_binary({ path = "app", srcs = { "main.c" }, deps = { lib }, toolchain = toolchain }),
	app_test = c.cc_test({ path = "app/test", deps = { lib }, toolchain = toolchain }),
}
```

`//rules/c/graph_example/BUILD.luau` declares a library and a binary in the
same way.

`cc_workload_specs()` returns the declared targets in declaration order. The
C build generator uses it to find duplicate declarations.

The C rules declare the `opt` mode axis as a task input. `release` selects
release compile flags. A missing value selects debug flags. Require
`@imp/rules/imp/mode` from the workspace module to register the axis and
profiles, then use `--profile release` or `--axis opt=release`.

### Compiler providers

`gcc.graph_toolchain(version?)`, `zig.graph_toolchain(version?)`, and
`msvc.msvc_toolchain()` return a provider table with the same fields:

| Field | Result |
| --- | --- |
| `kind` | `"gcc"`, `"zig"`, or `"msvc-host-toolchain"` |
| `task_inputs()` | The graph handles that a compile, archive, or link task declares as inputs |
| `commands(exec, inputs, options?)` | `{ env, rsp_quote, compile_command, archive_command, link_command }` |
| `cmake_configure(exec, inputs, options?)` | `{ compiler_args, env }` for a CMake configure |
| `resolves_tool_name(name)`, `resolve_state(exec, inputs)`, `edge_env(state)` | The CMake replay part of the contract |

Add the `task_inputs()` handles to the inputs of the task. In the task body,
`commands()` gives `sh -c` tokens and an `env` table for `exec.action`. The
gcc and Zig tool handles put the compiler names on PATH. The MSVC `env` puts
the MSVC and Windows SDK `bin` directories of the host on PATH, and sets
`INCLUDE` and `LIB`. The `unsafe_system_paths` option of gcc `commands()`
and `cmake_configure()` selects the compilers that skip the Bootlin path guard.

`toolchain.cc_toolchain_for_platform({ linux = ..., windows = ... })` returns
a union. `toolchain.select_cc_toolchain(value, platform?)` returns the
provider of the host OS, or of `platform`. A branch can be a function that
returns a provider.

The Zig provider has no CMake support: its `cmake_configure` fails, and
`resolves_tool_name` is false.

**Illustrative example**

```luau
local core = require("@imp/core")
local gcc = require("@imp/rules/c/gcc")

local provider = gcc.graph_toolchain()
local inputs = provider.task_inputs()
inputs.sh = core.native_tool("sh")

local compile = core.task({
	inputs = inputs,
	run = function(exec, resolved)
		local commands = provider.commands(exec, resolved)
		-- Join commands.compile_command({ ... }) into an `sh -c` script, and
		-- give commands.env to exec.action.
	end,
})
```

### Declare toolchain versions

Each module declares its pinned default when it loads on a platform that it
supports: gcc 2025.08-1 on Linux x86_64 and 16.2.0posix-14.0.0-ucrt-r1 on
Windows x86_64, Zig 0.16.0 on Linux and Windows, and NASM 3.02 and mold
2.42.1 on their only platforms. The Luau modules declare no default on
unsupported platforms.

`gcc_toolchain(version, options?)`, `zig_toolchain(version, options?)`,
`nasm_toolchain(version?, options?)`, and `mold_toolchain(version, options?)`
declare another version. The options are `default`, `unverified`, and
`lockfile`. gcc takes a version and a lockfile address for each OS, for
example `{ linux = "2025.08-1", windows = "16.2.0posix-14.0.0-ucrt-r1" }`.
The result has a `GEN_LOCKFILES` root, so a BUILD module can export it for
`imp goal gen-lockfiles`. A lockfile address must start with `@workspace/` or
`@imp/rules/`.

### Host C compiler on macOS

gcc and Zig have no macOS lockfile entry. On macOS, the Tree-sitter grammar
compile, the Rust link driver, and the Odin link step use the Apple clang of
the Xcode Command Line Tools instead.

`@imp/rules/c/host` gives `default_graph_toolchain()`. On macOS, it returns a
record with the native tool handles `tool` (`cc`), `clang_tool`, and
`ar_tool`. On other platforms, it returns nil. A task that declares a handle
as an input finds the tool on its PATH by its bare name.
`rust_link_driver_env(kache_active)` returns `{ rustflags, env, path_dirs }`
with the same shape as the gcc function.

This record is not a compiler provider: `cc_library()`, `cc_binary()`, and
CMake do not accept it. The host compiler uses the host SDK, so its result
depends on the installed Xcode Command Line Tools.

### Absolute host paths

Some programs need an absolute path, for example a rustc linker or a path
that CMake writes into build.ninja. These functions take the task `exec` and
a tool handle that the task declares as an input:

- `gcc.rust_link_driver_env(exec, tool, kache_active)` returns
  `{ rustflags, env, path_dirs }`.
- `gcc.cmake_compiler_args(exec, tool, unsafe_system_paths?)` and
  `gcc.windows_runtime_archives(exec, tool, version)` return argument lists.
- `msvc.resolve_nasm_host(exec, nasm_tool)` returns the path of nasm.exe.
- `mold.rust_linker_env(exec, tool)` returns `{ rustflags, path_dirs }`, and
  `mold.odin_linker_env(exec, tool)` returns `{ flags, path_dirs }`.

### Execution limits

The Luau host runs one action at a time. Each source has its own compile
action and cache entry. MSVC tools run from the host Visual Studio installation.
Zig's cache is shared across workspaces and protected by Zig's cache locks.
NASM caches are keyed by version. CLI `imp @gcc`, `imp @zig`, `imp @nasm`, and
`imp @mold` resolve the final declared defaults.

**Unknown:** the Windows behavior of the Luau modules is not verified on a
Windows host. The fake-host tests check only the argv and environment
values. These points need a real host:

- The gcc, Zig, and NASM install scripts that run tools by name.
- The MSVC `PATH` value `C:/...;C:/...`, after the `sh` of Git for Windows
  converts it.
- A CMake replay edge that runs a bare `rc` or `mt` through that `PATH`.

To verify, run `imp build` on Windows for a task that
compiles and links a C source with `gcc.graph_toolchain()`,
`zig.graph_toolchain()`, and `msvc.msvc_toolchain()`.
