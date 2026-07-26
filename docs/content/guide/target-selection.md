+++
title = "Target selection"
weight = 10
extra = { sidebar_heading = true }
+++

Goals run against targets selected by an address or package path. Exact target
selectors use `:name`; package selectors omit the colon. A selector without a
leading `//` is relative to the current package, while `//` is relative to the
workspace root.

```sh
# One target
imp build //apps/server:server

# Every target in a package, or recursively below it
imp test //apps/server
imp fmt //apps/...

# Every target in the workspace that supports the requested goal
imp lint //...
```

Package selectors automatically skip target kinds that do not implement the
goal. Exact target selectors instead report a missing goal product, which is
usually a sign that the wrong goal or target was chosen.

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
Changed goal runs always use that goal's product, so `#product` overrides are
not supported with `--changed-since`.

Goals declared with `selection: "none"` are independent of target selection:
their callbacks still run with an empty selection when `--changed-since` is
present.
