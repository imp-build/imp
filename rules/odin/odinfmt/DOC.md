Odinfmt formats targets declared with `odinPackage()` and
`odinTestPackage()`:

```sh
imp fmt //src/game:game
imp fmt --check //src/game:game_tests
```

Odinfmt has no native read-only check mode. Both operations therefore run
`odinfmt -w` in a sandbox. Write mode materializes changed source files back to
the workspace; check mode keeps the sandbox result private and compares its
content digest with the original files. This checks the formatter's actual
output without parsing diagnostics or relying on timestamps.

Only sources owned by the selected package are formatted. Dependency packages
must be selected through their own targets, which prevents one package's
format operation from unexpectedly rewriting another package's files.
