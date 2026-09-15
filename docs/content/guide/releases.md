+++
title = "Releases"
weight = 30
extra = { sidebar_heading = true }
+++

This page is for maintainers who need to understand the current release
artifacts. It documents the checked-in workflow behavior.

## Release artifacts

The release workflow builds two archives:

- `imp-x86_64-unknown-linux-musl.tar.gz` contains the Linux musl binary.
- `imp-x86_64-pc-windows-msvc.zip` contains the Windows MSVC binary.

Each archive contains a `bin/` directory with the executable and
`share/imp/rules/` with the rule packages that the executable loads at runtime.
The workflow runs a packaged-tree smoke test so it checks rule resolution
outside this repository's own `rules/` directory.

## Workflow triggers

The release workflow runs on `v*` tags and on manual dispatch:

1. The Linux and Windows jobs build locked release binaries.
2. Each job stages the binary beside the shipped `rules/` tree and runs its
   smoke checks.
3. The workflow packages and uploads both archives.
4. A manual dispatch updates the `main-preview` rolling draft release.
5. A version tag creates a separate draft release with generated release
   notes.

The rolling and versioned releases are drafts. A maintainer must
manually review the draft before publishing it.

### Smoke tests

The packaged-tree smoke test runs from a scratch workspace with `IMP_RULES_DIR` unset. It checks
that the installed executable can resolve `//rules/imp/codegen`, that the initializer is present,
and that runtime toolchain lockfiles are present beside the binary.

The release workflow also runs `imp --help` for each binary. These checks do not prove that every
rule or platform workflow works. A release description must state what was checked and must call out
failures caused by the runner, toolchain download, or platform environment separately from product
failures.

## Documentation

The documentation workflow is separate from binary releases. It checks generated workflows,
formatting, lint, and tests on pull requests. On a push to `main`, it packages `//docs:site` and
deploys the resulting Pages artifact.

The workflow files are generated. Change `ci/gen_workflow.py` and regenerate them with:

**Runnable example**

```sh
imp generate //ci:docs_workflow
```

Do not edit `.github/workflows/docs.yml` or `.github/workflows/release.yml` by hand.
