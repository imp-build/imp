# CMake rules

Declare CMake projects and consume their discovered targets through graph expansions.

## Public API

`cmake_project(options)` and `cmake_library_dep(project, name, options)`
declare CMake configuration and replay actions. Options use `snake_case`:
`build_dir`, `extra_globs`, `cmake_args`, `cmake_toolchain`, and
`unsafe_system_paths`. Library dependencies accept `include_dirs` and expose
transitive archives, shared libraries, include directories, and linker flags.

The other options (`path`, `srcs`, `dirs`, `deps`, `toolchain`, `linkopts`,
and `shared`) have the same names. The result of `cmake_project()` is an
expansion. Select its children with method calls:
`project:get(cmake_target_name, workflow, facet?)` and
`project:all(workflow, facet?)`. Put a `TEST` child directly in the `TEST`
slot.

**Runnable example:** `//rules/c/cmake/example/BUILD.luau` declares these
targets.

```luau
local build = require("@imp/rules/workflows/build")
local test = require("@imp/rules/workflows/test")
local cmake = require("@imp/rules/c/cmake")
local gcc = require("@imp/rules/c/gcc")
local c = require("@imp/rules/c")

local hello = cmake.cmake_project({
	path = "rules/c/cmake/example",
	cmake_args = { "-DCMAKE_BUILD_TYPE=Debug" },
})
local hello_lib = cmake.cmake_library_dep(hello, "hello_cmake", {
	include_dirs = { "rules/c/cmake/example" },
	shared = true,
})

return {
	hello_cmake_main = {
		[build.BUILD] = hello:get("hello_cmake_main", build.BUILD),
		[test.TEST] = hello:get("hello_cmake_main", test.TEST, "unit"),
	},
	uses_cmake_lib_test = c.cc_test({
		srcs = { "uses_cmake_lib.c" },
		deps = { hello_lib },
		toolchain = gcc.default_graph_toolchain(),
	}),
}
```

```sh
# From the repository root, after `cargo build -p imp`:
IMP_RUNTIME=luau target/debug/imp test //rules/c/cmake/example:hello_cmake_main //rules/c/cmake/example:uses_cmake_lib_test
```

`cmake_project_specs()` returns the declared projects in declaration order.
The C build generator uses it to find duplicate declarations.

### CMake toolchain

`@imp/rules/c/cmake/toolchain` declares CMake 4.4.3 as the default when it
loads on Linux or Windows, on x86_64 or aarch64.
`cmake_toolchain(version, options?)` declares another version. The options
are `default`, `unverified`, and `lockfile`. The result has a `GEN_LOCKFILES`
root. `graph_toolchain(version?)` returns `{ tool, version }`, and
`cmake_bin(exec, tool)` returns the absolute path of the cmake executable in
a task body.

### Execution limits

Replay edges run one action at a time. Each edge has its own cache entry.
The compiler provider, CMake, and native utilities must be task inputs. CTest
comes from the selected CMake toolchain, not from the host PATH. CLI
`imp @cmake` resolves the final declared default.

**Unknown:** the Windows behavior of the Luau modules is not verified on a
Windows host. The fake-host tests check only the argv values.
