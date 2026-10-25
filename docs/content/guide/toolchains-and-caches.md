+++
title = "Toolchains and caches"
weight = 10
extra = { sidebar_heading = true }
+++

This page is for users who need reproducible tool downloads, faster repeated
builds, or cache maintenance. These are advanced settings; the default
workspace setup is enough for a first build.

## Use managed toolchains

Import a language rule in `imp.workspace.luau` to enable its default toolchain.
The rule provides a pinned version and downloads it as a graph artifact on
first use. To select a different version known by the shipped lockfile, make
that version the workspace default:

**Illustrative example**

```luau
require("@imp/rules/rust/toolchain").rust_toolchain("1.93.0", { default = true })
return {}
```

The same pattern applies to the language-specific toolchain factories. Use the
[generated user API reference](../../reference/user-api/) for their names and
options.

## Use a version Imp does not ship

When the required version is not in the shipped lockfile, the workspace must
own a lockfile for that version. Point the toolchain at the workspace path and
generate the lockfile:

**Illustrative example**

```luau
local rust = require("@imp/rules/rust/toolchain")
return { rust = rust.rust_toolchain("1.91.0", {
    default = true,
    lockfile = "@workspace/toolchains/rust.lock",
}) }
```

```sh
imp goal gen-lockfiles //:rust
```

The generated lockfile records the download URL, artifact name, size, and
SHA-256 for the selected platform. A missing entry is a toolchain configuration
failure, not permission to use an unverified download.

## Use an existing toolchain artifact

Use a rule-specific Luau installer when the rule exposes one. For example,
Ruff and Biome accept captured executable or directory artifacts. Declare
those handles as graph dependencies. Do not pass a raw host path as if it
were a portable toolchain. See the corresponding user API page for the
installer's accepted shape and cache identity.

## Inspect the local cache

Imp stores task results, content-addressed files, and named tool caches under
one cache root. The default is `XDG_CACHE_HOME/imp`, then
`$HOME/.cache/imp`, then `/tmp/imp/cache`. Set `IMP_CACHE_DIR` when a specific
cache root is required. In a sandboxed environment, set `XDG_CACHE_HOME` to a
writable directory before starting Imp.

**Runnable example**

From a workspace root:

```sh
imp cache stats
imp cache stats --details
```

`cache stats` reports counts and sizes. `--details` also reports named-cache
breakdown when the workspace provides it. Cache entries are implementation
data. Do not copy or edit files inside the cache root by hand.

## Remove old cache entries

`cache gc` is a dry run unless you pass `--apply`:

**Runnable example**

```sh
imp cache gc --max-age 30
imp cache gc --max-age 30 --apply
```

Review the dry-run summary before deletion. Garbage collection removes entries
that are not kept live by recent task records; it does not repair a failed
build or replace a missing source file.

## Optional GitHub Actions cache

The `ghac` remote cache is an optional accelerator for GitHub Actions. Set
`IMP_REMOTE_CACHE=ghac` only in a GitHub Actions job that provides the Actions
cache environment. `IMP_REMOTE_CACHE_ROOT` can select a namespace; its default
is `imp`.

**Warning:** A remote cache miss or remote cache failure falls back to local
execution. A successful build does not prove that the remote cache was used.
The remote cache must not be treated as the source of truth for correctness,
and its runtime token must not be printed or written to artifacts.
