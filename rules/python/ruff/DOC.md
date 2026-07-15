Ruff formats and lints targets declared with `pythonApp()`. The two features
are registered by separate modules: importing `//rules/python/ruff/fmt`
enables the `fmt` and `format-check` products, importing
`//rules/python/ruff/lint` enables the `lint` product. The fmt and lint
workflows each import their own half, so a workspace can enable one without
the other. The tool version comes from the workspace's default
`ruffToolchain()` declaration, so local and CI runs use the same formatter
and rule set.

```sh
# Rewrite Python files owned by the selected application.
imp fmt //services/acme:app

# Read-only formatting and lint checks.
imp fmt --check //services/acme:app
imp lint //services/acme:app
```

Formatting runs `ruff format` over the target's `.py` files. Write mode
materializes only files whose content changed; check mode uses Ruff's native
`ruff format --check` and leaves the workspace untouched.

Linting runs `ruff check --color=always`. A lint violation is collected as a
normal failed lint result instead of aborting the first worker, allowing the
workflow to print diagnostics and a combined summary for every selected
target.
