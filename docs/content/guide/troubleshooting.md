+++
title = "Troubleshoot Imp"
weight = 30
extra = { sidebar_heading = true }
+++

This page is for users who need to separate a repository error from an
environment, platform, or Imp error. Start with the smallest reproducible
target and record the command, platform, workspace configuration, and cache
state.

## Identify the failure boundary

| Symptom | First check | Likely boundary |
| --- | --- | --- |
| Imp cannot find a target | Run `imp targets` from the workspace root | Repository or selector |
| A declared tool cannot be found | Check the rule import and toolchain declaration | Workspace or toolchain |
| A download fails | Check the platform and lockfile entry | Network, lockfile, or platform |
| A cached result looks wrong | Re-run the selected goal with `--no-cache` | Cache or product behavior |
| Only one platform fails | Compare the platform-specific rule and toolchain path | Platform or toolchain |
| A daemon command fails | Run `imp daemon status`, then stop and restart it | Daemon or environment |

## Inspect a run

Use a focused selector first. Increase log detail only for the run you are
investigating:

**Illustrative example**

```sh
imp --level debug build //app:server
imp --level trace build //app:server --no-cache
imp cache stats
```

`--no-cache` disables task-cache reads and writes for that goal. It does not
disable managed toolchain downloads or make an unsandboxed action safe.

For artifact-capture questions, `IMP_TRACE_ARTIFACTS=1` adds opt-in artifact
trace output. Treat trace output as diagnostic data and do not include secrets
in commands or environment values.

## Compare repository and environment failures

If the same focused command fails with a fresh cache, inspect the selected
`BUILD.js`, workspace imports, declared tools, source paths, and platform. If a
clean workspace or another supported platform succeeds, compare those inputs
before changing Imp.

If a failure occurs while downloading a pinned toolchain, preserve the error
and check the lockfile, URL availability, platform entry, and digest. Do not
replace a failed verification with an unverified download.
