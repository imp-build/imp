The OCI rules model image movement and deterministic image assembly without a
Docker daemon. `ociPull()` fetches an immutable layout, `ociBuild()` composes
file layers and metadata, `ociPush()` publishes a local image, and
`ociMirror()` copies directly between registries. A managed Crane toolchain
handles registry operations.

<!-- capabilities -->

## Set up Crane

Registry operations use the pinned Crane release provided by the OCI rule:

```js
import "//rules/oci";
```

The release is acquired as an immutable graph artifact on first use. Pure local
composition of a `"scratch"` image does not invoke Crane, but pulls, publishes,
mirrors, and builds based on a pulled image do.

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
