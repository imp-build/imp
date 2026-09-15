+++
title = "Target selection"
weight = 10
extra = { sidebar_heading = true }
+++

Goals run against targets selected by an address or package path. Exact target
selectors use `:name`; package selectors omit the colon. A selector without a
leading `//` is relative to the current package, while `//` is relative to the
workspace root.

**Illustrative example**

```sh
# One target
imp build //apps/server:server

# Every target in a package, or recursively below it
imp test //apps/server
imp fmt //apps/...

# Every target in the workspace that supports the requested goal
imp lint //...
```

Package selectors automatically skip targets that do not implement the goal.
An exact target selector instead reports that the target has no such workflow,
which is usually a sign that the wrong goal or target was chosen.

A target may expose more than one root for the same goal. Two suffixes select
between them:

```sh
# A named facet, when a workflow exposes several
imp test //crates/imp-store:imp_store@doctests

# One child of an expansion, by its key
imp run //rules/python/example:scripts#rules/python/example/scripts/demo.py
```

An expansion key is minted by the ruleset, so it is not always a bare name —
an expansion keyed by source file uses that file's workspace-relative path, as
above.

## Give more than one selector

A command accepts any number of selectors and runs the union of what they
select.

```sh
imp test //apps/server:server //libraries/parser:parser
```

Each selector must resolve on its own. If one of them matches nothing, the
command fails and runs no work, even when the other selectors resolved — a
mistyped address in a list is a mistake, not an empty set. An exact selector
naming an address that exists but has no work for the requested goal reports
what the address does provide:

```
$ imp test //apps/server:assets
error: //apps/server:assets has no 'test' workflow; it exports: build
```

Package and recursive selectors keep their filtering behaviour: `imp test
//...` over a workspace of mostly non-test targets succeeds and runs the test
targets it found. Such a selector only fails when its address space is empty,
for example when it names a directory that does not exist.

## Select changes from Git

`--changed-since REF` selects targets that own files changed since the merge
base of `REF` and `HEAD`, including committed, staged, unstaged, deleted, and
untracked non-ignored files in the working tree.

```sh
imp test --changed-since origin/main
imp lint --changed-since HEAD~1
```

Imp requires a Git checkout for this option. A changed source file selects
every target whose source globs own it. Changing a `BUILD.js` file selects its
whole package; changing `imp.workspace.js` selects the whole workspace.
Changing an imported JavaScript rule module selects packages that transitively
import it. Files with no owner produce a warning but do not fail the command.

Use `--changed-dependents direct` to include targets that directly depend on
the changed targets, or `--changed-dependents transitive` for the full reverse
dependency closure.

## Scope changed targets

Path selectors and `--changed-since` can be combined. The selector narrows the
changed target set, which is useful when CI runs separate jobs for different
parts of a workspace.

```sh
imp test //apps/... --changed-since origin/main
imp targets //libraries/... --changed-since origin/main
```

A nonexistent or invalid selector is still an error. If a valid selector has
no changed targets in scope, the command succeeds without running work.
A changed run always uses the goal's own workflow, so the legacy
`//pkg:target#product` override is not supported with `--changed-since`.

Goals declared with `selection: "none"` are independent of target selection:
their callbacks still run with an empty selection when `--changed-since` is
present.
