# imp

Imp is a hermetic, content-addressed build system. It describes work as a
graph, runs actions in sandboxes, and stores outputs in a content-addressed
cache.

## Start here

- [Installing Imp](docs/content/guide/installing.md) — install a published
  archive and check the prerequisites.
- [Getting started](docs/content/guide/getting-started.md) — create a
  workspace and build a first target.
- [Configure a workspace](docs/content/guide/workspace-file.md) — select rules,
  workflows, profiles, and execution limits.
- [Writing build files](docs/content/guide/writing-build-rules.md) — declare
  graph-native targets and actions.
- [Advanced user workflows](docs/content/guide/toolchains-and-caches.md) —
  use toolchains, caches, CI, packaging, and diagnostics.

For repository work, see [Contributing and maintaining
Imp](docs/content/guide/contributing.md). Maintainers can also read the
[release workflow](docs/content/guide/releases.md) and [documentation
workflow](docs/content/guide/documentation-workflow.md).

From a workspace root, initialize Imp and build a target:

```sh
imp init
imp build //:target
```

The [public documentation site](https://imps.build/) contains the complete
guide and generated API references.
