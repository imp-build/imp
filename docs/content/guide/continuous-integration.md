+++
title = "Use Imp in CI"
weight = 15
extra = { sidebar_heading = true }
+++

This page is for users who run Imp in continuous integration. The result is a
repeatable check that uses a committed workspace file and reports the same
target and cache behavior as a local run.

For GitHub Actions, use the reusable [Imp Actions
repository](https://github.com/imp-build/actions), especially
`imp-build/actions/setup-imp@main`. It installs Imp, adds it to `PATH`, and
can cache Imp's toolchain and build store.

## Prepare the job

Commit `imp.workspace.js` and the `BUILD.js` files that define the targets.
Do not run the interactive initializer in a non-interactive CI step. Use
`setup-imp` or install a published Imp archive before running the job.

Run the checks from the workspace root:

**Runnable example**

```sh
imp test //...
imp lint //...
```

The equivalent GitHub Actions setup is:

**Runnable example**

```yaml
- uses: imp-build/actions/setup-imp@main
- run: imp test //...
```

Select a smaller package while developing the job, then use the workspace-wide
selectors for the required check. A target that is not selected is not tested
by the command.

## Use the local cache

Set `XDG_CACHE_HOME` or `IMP_CACHE_DIR` to the CI cache directory when the CI
system restores and saves that directory. The cache is an accelerator: a cold
cache must still produce the correct result, and a restored cache may contain
records that are no longer usable after source or toolchain changes.

## Use the optional remote cache

GitHub Actions can opt into the `ghac` backend with `IMP_REMOTE_CACHE=ghac`.
The backend uses the Actions runtime endpoint and token supplied to the job;
do not place those values in workspace configuration or command output.

**Warning:** Remote cache errors fall back to real execution. Keep the job
 correct when the remote tier is absent, slow, or unavailable. For a first CI
 setup, leave this setting unset until the remote-cache behavior
is understood for your workflow; remote-cache behavior is not a correctness
gate.

## Diagnose a CI-only failure

Compare the selected target, workspace configuration, platform, and cache
state before changing the build. Use `imp cache stats` to inspect the cache and
`--no-cache` on a goal to test whether a result depends on a stale local task
record. A failure that remains with `--no-cache` is not evidence that the cache
caused it.
