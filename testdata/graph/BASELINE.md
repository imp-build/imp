# Graph execution baseline

Recorded before the leaf-first graph execution work item starts. Use these
numbers to find an unwanted change while phases 1 to 3 are in work.

- Revision: `33e4127`
- Host: Linux x86_64 (WSL2), release build of `imp`
- Cache: warm. Run each command two times and read the second result.

## What to compare

**Sandbox count is the important number.** It is the count of actions that
ran, and it does not change with the speed of the machine. A change in this
count means the shape of the graph changed, or dedup changed. Find the cause
before you continue.

Wall time on a warm cache is a weaker signal, because it changes with the
load on the machine. Use it to find a large fall in speed, not a small one.

## Warm-cache numbers

| Command | Sandboxes | Cache hit | Time |
| --- | --- | --- | --- |
| `imp build //crates/...` | 15 | 100% | 0.32s |
| `imp test //crates/...` | 28 | 100% | 2.05s |
| `imp lint //crates/...` | 16 | 100% | 1.15s |
| `imp build //rules/odin/example/...` | 13 | 100% | 0.05s |
| `imp build //rules/c/cmake/example:uses_cmake_lib` | 12 | 100% | 0.07s |

`imp test //crates/...` reports 12/12 units passed. `imp lint //crates/...`
reports 11 clean.

## Cold-cache times

These come from the first run after a change to the source. They change a
lot between machines. They are here to show the cost of a cold build, not
as a limit to hold.

| Command | Sandboxes fresh | Time |
| --- | --- | --- |
| `imp build //crates/...` | 2 of 15 | 44.5s |
| `imp test //crates/...` | 19 of 28 | 278.8s |
| `imp build //rules/odin/example/...` | 10 of 13 | 12.2s |
| `imp lint //crates/...` | 1 of 16 | 17.9s |

## The goldens hold host data

The goldens keep the toolchain nodes of the host that made them, for
example `install mold 2.41.0 (linux/x86_64)`. Thus they agree only on
Linux x86_64. A run on a different platform gives a difference that is
correct but not useful.

A change to the version of a toolchain also changes the goldens. That
difference is true: the graph did change. Write the goldens again with
`--update` and look at the difference to make sure that only the expected
toolchain nodes moved.

If the goldens must run on more than one platform later, give
`ci/graph_golden.py` an option to leave out the toolchain subtree, or keep
one golden for each platform.

## Note on `//...`

Do not use `//...` for a baseline on Linux. It holds
`//rules/c/cmake/example:raw_main_msvc`, which needs `vswhere.exe` and fails
on a machine that is not Windows.
