# OCI image rules

For BUILD authors, the OCI rules declare image layouts, local image assembly,
archives, and registry publication without a Docker daemon.

## Luau API

Use `@imp/rules/oci` with `imp.workspace.luau` and `IMP_RUNTIME=luau`.
The JavaScript modules remain available during migration. Generated API
references still describe JavaScript. Luau reference extraction belongs to
`2026-09-30-integrate-luau-workspace-tests-and-docs`.

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

## JavaScript API

The OCI rules model image movement and deterministic image assembly without a
Docker daemon. `ociPull()` fetches an immutable layout, `ociBuild()` composes
file layers and metadata, `ociPush()` publishes a local image, and
`ociMirror()` copies directly between registries. A managed Crane toolchain
handles registry operations.

<!-- capabilities -->

## Public API

Use `ociPull()`, `ociBuild()`, `ociPush()`, and `ociMirror()` for immutable
image inputs, deterministic local image builds, and explicitly selected
registry operations. Crane toolchain helpers are documented here but remain
configuration details rather than standalone target constructors.

## Set up Crane

Registry operations use the pinned Crane release provided by the OCI rule:

```js
import "//rules/oci";
```

The release is acquired as an immutable graph artifact on first use. Pure local
composition of a `"scratch"` image does not invoke Crane, but pulls, publishes,
mirrors, and builds based on a pulled image do.

### Select a workspace lockfile

The Crane release ships with a lockfile pinning the download URL, size, and
SHA-256 of every artifact it knows. To pin a version the shipped lockfile does
not know, give the toolchain the address of a lockfile this workspace owns;
the shipped lockfile stays the default.

```js
import { craneToolchain, craneGenLockfiles } from "//rules/oci/toolchain";

export const crane = craneToolchain("0.19.0", {
	default: true,
	lockfile: "//locks/crane.lock",
});
export const craneLockfiles = craneGenLockfiles();
```

```sh
imp goal gen-lockfiles //:craneLockfiles
```

`craneGenLockfiles()` writes to the address the toolchain declares, so the
address is given one time only. Downloads stay verified: an address with no
file, or a lockfile with no entry for the selected version and platform, makes
the acquire fail and points at `imp goal gen-lockfiles`.

## Pull a base and build an image

```js
import { ociPull, ociBuild } from "//rules/oci";

export const alpine = ociPull({
    repo: "docker.io/library/alpine",
    digest: "sha256:...",
});

export const app = ociBuild({
    base: alpine,
    sourceBase: "images",
    path: ".",
    layers: [{
        srcs: ["bin/server"],
        path: "/usr/local/bin",
        mode: "0755",
    }],
    entrypoint: ["/usr/local/bin/server"],
    env: { LOG_LEVEL: "info" },
    workdir: "/srv",
});
```

A pull requires exactly one of `tag` or `digest`. Tags are resolved on every
invocation because they can move; the resolved digest and image layout then
flow through immutable artifact handles. Prefer a digest when reproducibility
matters.

`ociBuild` accepts an `ociPull`/`ociBuild` image as its base or the literal
`"scratch"`. It does not interpret a Dockerfile and cannot run `RUN` commands.
Each layer stages workspace files selected by `srcs` at the requested image
path, with optional exclusions, ownership, and mode. Layer tarballs, config,
manifest, and OCI index are assembled deterministically, so identical inputs
produce identical image content.

`sourceBase` defaults to the declaring package. Pass it explicitly through a
BUILD helper that constructs images for another package.

## Build and package locally

```sh
imp build //images:app
imp package //images:app
```

`build` leaves the OCI layout in the build graph/CAS. `package` writes
`dist/images/app/image.tar`, an OCI archive suitable for tools such as
`podman load` or `docker load`. Pulled images can be packaged in the same way.

## Push or mirror

```js
import { ociPush, ociMirror } from "//rules/oci";

export const publish = ociPush({
    image: app,
    repo: "registry.example.com/acme/server",
    tag: "latest",
});

export const mirror = ociMirror({
    from: { repo: "docker.io/library/alpine", tag: "3.23" },
    to: { repo: "registry.example.com/mirror/alpine", tag: "3.23" },
});
```

Select either target with `imp publish`. Push and mirror are intentionally
impure: they perform registry side effects on every invocation and are never
replayed from the task cache. Mirror uses a registry-to-registry Crane copy and
does not materialize the image locally.

Credential sourcing is not implemented yet, so these rules are presently
suitable for public/anonymous registries only. Do not assume an ambient Docker
login will be visible inside the hermetic execution environment.

The current image builder emits one image manifest. Multi-platform indexes and
Dockerfile-compatible command execution are outside this rule's present
surface.
