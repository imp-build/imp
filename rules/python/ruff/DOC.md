Ruff formats and lints targets declared with `pythonApp()`. The two features
are registered by separate modules: importing `//rules/python/ruff/fmt`
enables the `fmt` product, importing `//rules/python/ruff/lint` enables the
`lint` product. The fmt and lint workflows do not import these modules, so
the workspace must import each one that it uses. A workspace can enable one
without the other. The tool version comes from the
rule-provided default Ruff toolchain, so local and CI runs use the same
formatter and rule set.

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
Users select the resulting products with `imp fmt` and `imp lint`; toolchain
download helpers are not user BUILD APIs.
