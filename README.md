# imp

Imp is a hermetic, content-addressed build system. It describes work as a
graph, runs actions in sandboxes, and stores outputs in a content-addressed
cache.

## Start here

- [Getting started](docs/content/guide/getting-started.md) — create a
  workspace and build a first target.
- [Writing build rules](docs/content/guide/writing-build-rules.md) — declare
  graph-native rules and actions.
- [Contributing and maintaining Imp](docs/content/guide/contributing.md) —
  understand the repository, development workflow, and validation gates.
- [Releases](docs/content/guide/releases.md) — understand the release
  artifacts and current CI workflow.
- [Documentation workflow](docs/content/guide/documentation-workflow.md) —
  update authored docs and generated references.

From a workspace root, initialize Imp and build a target:

```sh
imp init
imp build //:target
```

The [public documentation site](https://imps.build/) contains the complete
guide and generated API references.
