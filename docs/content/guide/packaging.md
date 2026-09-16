+++
title = "Package build outputs"
weight = 20
extra = { sidebar_heading = true }
+++

This page is for users who need to publish a build result or create an OCI
image. `imp package` writes selected package results below `dist/`; it does not
publish them to a registry or deployment system by itself.

## Package a target

Declare a package-capable target in a `BUILD.js` file, then select it from the
workspace root:

**Illustrative example**

```sh
imp package //apps/server:server
```

The output is placed below `dist/` according to the target address. Read the
target's rule guide to find the exact output shape. Package output
is separate from the graph and cache: changing or deleting `dist/` does not
change the cached graph result.

## Build an OCI image

The OCI rules build images without requiring a Docker daemon. Use
`ociPull()` or `ociBuild()` for the image, then `ociPush()` or `ociMirror()` for
registry movement. The [OCI user API reference](../../reference/user-api/) documents
the required repository, tag, digest, and credential behavior.

Prefer an immutable base digest when reproducibility matters. A tag can move,
so a later run may resolve a different base image.

## Deployment boundary

Imp can produce files and OCI images for another system to deploy. It does not
decide deployment policy, rollout order, service identity, or production
credentials. Keep those controls in the deployment system and pass only the
artifact that system is intended to consume.
