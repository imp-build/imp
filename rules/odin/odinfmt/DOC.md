Build authors can import `@imp/rules/odin/odinfmt` in `imp.workspace.luau`
before declaring Odin packages. The extension adds a formatter root to
`odin_package` and `odin_test_package` declarations.

## Public API

Use `odinfmt_toolchain(version, options)` to select a formatter version and
lockfile. Use `odinfmt_gen_lockfiles()` to expose a selectable lockfile root.
Omit the version to follow the current Odin default. An explicit formatter
default takes precedence. See the [Odin guide](https://imps.build/reference/user-api/odin/) for complete
workspace and lockfile examples.

**Known limitation:** The `dev-2026-03` formatter can write invalid Odin when
it wraps a long single-line procedure that contains a loop. Use multiline
blocks with that version. This defect is in the formatter executable.

From the workspace root, with an existing Odin target:

```sh
imp fmt //src/game:game
imp fmt --check //src/game:game_tests
```

Odinfmt has no native read-only check mode. Both commands run `odinfmt -w`
in a sandbox. Write mode copies changed source files back to the workspace.
Check mode compares the sandbox output digest with the original source digest
and leaves the workspace files unchanged.

Only declared `.odin` sources are formatted. Dependency packages must be
selected through their own targets. Each file gets a separate formatter
invocation, so a root package does not format the toolchain's own Odin files.
The workspace's `odinfmt.json`, when present, is staged and passed with
`-config`. Without that file, the formatter uses its built-in defaults.

The formatter comes from a verified OLS release archive and uses the shared
`odinfmt-toolchains` named cache. Custom workspace lockfiles use
`@workspace/locks/odinfmt.lock` addresses. The bundled lockfile remains the
default. Generated Luau references remain with workspace integration.
