The Ruff rules format and lint `python_app` and `python_test` targets. This
guide is for rule authors on the Luau migration branch. Import the facets in
`imp.workspace.luau` before BUILD files declare targets:

```lua
require("@imp/rules/python/ruff/fmt")
require("@imp/rules/python/ruff/lint")
return {}
```

Each import enables one product. The default toolchain pins Ruff `0.16.7`.
Imp uses Luau for workspace and BUILD modules.

From the workspace root, select a declared Python target:

```sh
# Rewrite Python files owned by the selected application.
imp fmt //services/acme:app

# Read-only formatting and lint checks.
imp fmt --check //services/acme:app
imp lint //services/acme:app
```

Ruff reads the project's own configuration. Formatting and linting stage
`pyproject.toml`, `ruff.toml`, and `.ruff.toml` from these directories:

- the application's project directory;
- each parent directory up to the workspace root;
- the directories below the project directory that the `sources` patterns
  can match. For `src/**/*.py`, this is `src/` and each directory below it.

Ruff uses the closest configuration file, as it does in an editor. A change
to one of these files makes the next fmt or lint run again. Imp does not
stage a configuration file that `.gitignore` or `.ignore` excludes.

An `extend` path must point to a file that Imp stages. If it points to a
file in a directory that Imp does not stage, for example
`extend = "../shared/ruff.toml"`, Ruff cannot load the file and the fmt or
lint result fails.

Formatting runs `ruff format` over the target's `.py` files. Write mode
materializes only files whose content changed; check mode uses Ruff's native
`ruff format --check` and leaves the workspace untouched.

Linting runs `ruff check --color=always`. A lint violation is collected as a
normal failed lint result instead of aborting the first worker, allowing the
workflow to print diagnostics and a combined summary for every selected
target.

```sh
imp lint --fix //services/acme:app
```

`--fix` adds `ruff check --fix` and materializes only the changed `.py`
files back into the workspace. Unsafe or otherwise unfixable violations are
still reported, so the lint goal still fails for anything left over after
fixing.
## Public API

Import the Ruff formatter or linter facet from the documented entrypoints.
Users select the products with `imp fmt` and `imp lint`.
Toolchain download helpers are not user BUILD APIs.

## Declare the toolchain

In a root `BUILD.luau`, export a declaration to generate a workspace-owned
lockfile. This illustrative example pins a version in a custom lockfile:

```lua
local ruff = require("@imp/rules/python/ruff_toolchain")
return { ruff = ruff.ruff_toolchain("0.16.7", {
    default = true,
    lockfile = "@workspace/locks/ruff.lock",
}) }
```

**Warning:** From that workspace root,
`imp goal gen-lockfiles //:ruff` writes `locks/ruff.lock`.
The declaration returns `version`, `lockfile`, and a `GEN_LOCKFILES` root.
Without a lockfile option, acquisition uses the shipped lockfile. Missing
entries fail with a generation command. `unverified = true` permits an
unverified download and logs a warning.

Importing the toolchain module registers `imp @ruff`. Rule tasks use
`graph_toolchain(version).tool` as an input. Inside the task,
`ruff_bin(exec, tool)` returns the absolute executable path.
`install_ruff_toolchain(version, source, options)` accepts a declared directory
artifact or path handle, with `default` as an option. The directory must
contain an executable `ruff` (`ruff.exe` on Windows). Its content digest is
part of the local named-cache key.

Lint maps declared source and configuration file sets under `fixed/` without
a source-copy loop. Source paths remain individual command arguments, so
large source sets remain subject to platform argv limits. Source selection
is unchanged. Ignored and unselected files are not added by the mapping.

Contributors can run the real-tool consumer check from the Imp checkout root,
after building `target/debug/imp`. It needs network access on a cold cache:

```sh
python3 rules/python/ruff/testdata/consumer_check.py --imp target/debug/imp
```
