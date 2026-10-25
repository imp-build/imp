# Imp

Imp is a graph-native build system and task runner for polyglot repositories.
It describes work as a graph, runs actions in sandboxes, and stores declared
results in a content-addressed cache.

## Start here

- [Installing Imp](docs/content/guide/installing.md) — install a published
  archive and check the prerequisites.
- [Getting started](docs/content/guide/getting-started.md) — create a
  workspace and build a first target.
- [Configure a workspace](docs/content/guide/workspace-file.md) — select rules,
  workflows, profiles, and execution limits.
- [Writing build files](docs/content/guide/writing-build-rules.md) — declare
  graph-native targets and actions.
- [Toolchains and caches](docs/content/guide/toolchains-and-caches.md) — use
  pinned tools and maintain local or optional remote caches.
- [Target selection](docs/content/guide/target-selection.md) — select one
  target, a package, a subtree, or changed targets.
- [CI and packaging](docs/content/guide/continuous-integration.md) — run Imp
  in CI and publish build products.
- [Troubleshooting](docs/content/guide/troubleshooting.md) — separate
  repository, environment, platform, and Imp failures.

For repository work, see [Contributing and maintaining
Imp](docs/content/guide/contributing.md). Maintainers can also read the
[release workflow](docs/content/guide/releases.md) and [documentation
workflow](docs/content/guide/documentation-workflow.md).

Create `imp.workspace.luau` at the workspace root, import the rule modules your
workspace uses, and build a target:

```luau
require("@imp/rules/c")
require("@imp/rules/workflows/test")
return {}
```

Then run:

```sh
imp build //:target
```

The [public documentation site](https://imps.build/) contains the complete
guide and generated API references. The source links above are useful when
working from an Imp checkout; the site links are the canonical user-facing
version.
