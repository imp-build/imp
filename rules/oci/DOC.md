# OCI image rules

For BUILD authors, the OCI rules declare image layouts, local image assembly,
archives, and registry publication without a Docker daemon.

## Public API

**Illustrative example**

In `imp.workspace.luau`, register the workflows:

```lua
require("@imp/rules/workflows/build")
require("@imp/rules/workflows/package")
require("@imp/rules/workflows/publish")
require("@imp/rules/workflows/lockfiles")
return {}
```

In `images/BUILD.luau`, declare an image from files in `images/bin/`:

```lua
local oci = require("@imp/rules/oci")
local app = oci.oci_build({
    base = "scratch",
    layers = {
        { srcs = { "bin/*" }, path = "/app", mode = "0755" },
    },
    entrypoint = { "/app/bin/server" },
    env = { LOG_LEVEL = "info" },
    workdir = "/srv",
})
return {
    app = app,
    publish = oci.oci_push({
        image = app, repo = "registry.example.com/acme/server", tag = "v1",
    }),
}
```

From the workspace root, run `IMP_RUNTIME=luau imp build //images:app` to
build the layout in the CAS. Run `IMP_RUNTIME=luau imp package //images:app`
to write `dist/images/app/image.tar`. The archive contains an OCI layout;
verify that the destination image loader accepts that archive format.

`oci_pull({ repo, tag })` resolves a mutable tag without a cache on each
invocation. Use `oci_pull({ repo, digest })` for a pinned input. Specify
exactly one of `tag` or `digest`. Both forms return a frozen image object
with `image.layout`, `image.digest`, `BUILD`, and `PACKAGE` fields.

`oci_build` requires a base image object or `"scratch"`, and a non-empty
`layers` list. It returns the same image shape. Each layer requires `srcs`
and `path`; optional fields are `exclude`, `mode`, `uid`, and `gid`.
Ownership defaults to zero. File paths below the source root remain below
the destination: `bin/server` at `/app` becomes `/app/bin/server`.
`source_base` defaults to the declaring BUILD package; `path` defaults to
`.` below that base. Source roots must stay within the workspace. Image
layer destinations accept leading slashes but reject `..` components.

Optional image fields are `entrypoint`, `cmd`, `env`, `labels`, `user`, and
`workdir`. Entrypoint and command accept a string or a list of strings.
Environment variables and labels are string maps. Environment names and
label keys are sorted for deterministic output. Non-empty entrypoint,
command, environment, user, and workdir values replace inherited values;
labels merge with inherited labels. Empty values preserve inherited values.

`oci_push({ image, repo, tag })` and
`oci_mirror({ from = { repo, tag }, to = { repo, tag } })` return only a
`PUBLISH` root. Mirror also accepts `from.digest` in place of `from.tag`.
Select these roots with `IMP_RUNTIME=luau imp publish //images:publish`.
These actions change the registry and bypass the action cache. No build or
package command selects them.

### Crane toolchain

Importing OCI declares Crane `0.22.1` as the default. Registry actions acquire
it from verified archives through the shipped lockfile. Scratch builds do
not acquire Crane. To select another release, declare a toolchain target:

```lua
local crane = require("@imp/rules/oci/toolchain")
return {
    crane = crane.crane_toolchain("0.22.1", {
        default = true,
        lockfile = "@workspace/locks/crane.lock",
    }),
}
```

**Warning:** Lockfile generation writes the selected file into the workspace.

With this target in the root BUILD module, run
`IMP_RUNTIME=luau imp goal gen-lockfiles //:crane`. The toolchain declaration
returns `version`, `lockfile`, and `GEN_LOCKFILES`. A missing lockfile or
entry fails acquisition and names the regeneration command. The optional
`unverified = true` permits an unverified download with a warning.

For rule authors, `graph_toolchain(version)` returns `{ tool, version }`.
Declare `tool` as a task input, then call `crane_bin(exec, tool)` inside the
task. `default_version()` and `resolve_version(version)` inspect version
selection; the OCI entrypoint re-exports these and `crane_toolchain`.
Crane archives support Linux and macOS x86_64/aarch64 and Windows x86_64.
They are extracted into the shared `crane-toolchains` named cache.

### Limits and verification

Image assembly emits one `linux/amd64` manifest and uses POSIX shell tools,
GNU tar, `jq`, and `sha256sum`. macOS and Windows image assembly are
unverified. The rule does not execute Dockerfiles or image commands.
Credential sourcing is not implemented. Do not assume an ambient Docker
login is available in a sandbox.

Contributors can run the local consumer check from this checkout with
`python3 rules/oci/testdata/consumer_check.py --imp target/debug/imp` after
`cargo build -p imp`. It checks real local assembly, packaging, deterministic
outputs, and verified Crane acquisition. Registry actions use test fakes;
the check does not publish images.

Run the focused rule tests from the checkout with
`IMP_RUNTIME=luau target/debug/imp test //rules/oci/...`. Run all Luau rule
tests with `IMP_RUNTIME=luau target/debug/imp test //rules/...`. Use the
current source-built binary for both commands. Before delivery, also run
`cargo test --workspace`, `imp fmt //...`, `imp lint //...`,
`imp test //...`, and `git diff --check`.
