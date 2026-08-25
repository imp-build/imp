# Cache validation — 2026-08-24

Status: validated against commit `c4f0f88` on Linux. This is a source and
focused-test audit, not a new performance benchmark.

## What is current

- CAS data is stored in flat `cas/blobs/<sha256>` files. `cas/meta/<sha>.json`
  stores metadata. Directory trees are `DigestTrie` JSON blobs that refer to
  child files and nodes.
- The task cache stores one `tasks/<task-key>.json` record per action. The key
  includes the action digest, input-tree digest, and output specification.
- Named-cache slots are published through a temporary sibling and rename. They
  live below `named/<scope>/<name>/<key>`; immutable toolchains can use the
  cross-workspace `shared` scope.
- `usage.db` records CAS, task, and named-cache use. It also records workspace
  and named-cache declarations for cache GC and cache statistics.
- `IMP_TRACE_ARTIFACTS=1` enables artifact trace output. It is an opt-in
  diagnostic, not a normal runtime cost. Memo traces are workspace-scoped JSON
  records for change detection; they do not cache memo results.
- Sandbox input materialization copies CAS files through one process-wide,
  bounded worker pool. The automatic pool size is available CPUs capped at 16.
- `tool(..., { mount: { name, cache, key } })` mounts a named-cache tool root
  atomically in the sandbox. GCC and Rust use this path.

## Historical measurements — do not treat as current

The earlier document reported Linux warm-build timings, syscall counts, cache
sizes, hit rates, and expected Windows improvements. Those measurements were
not repeated for this audit. They require the exact commit, filesystem,
hardware, cache state, command, and workload before they can guide priority.

In particular, the prior 50–93% hit-rate range and the `ETXTBSY` report are
unconfirmed observations. Re-executed `impure` actions are one possible reason
for a cache miss; unstable cache identity is not established.

## Action status

| Item | Status | Current evidence |
| --- | --- | --- |
| Mount graph toolchains | Partial | The mount mechanism is tested; GCC and Rust mount named-cache tool roots. Node, Zig, CMake, Odin, and other graph toolchains still use CAS input staging. |
| Avoid repeated parent-directory creation | Complete; benchmark pending | `materialize_one_file` now uses `copy_file_into_existing_dir`. `collect_materialize_jobs` creates each parent before it dispatches file jobs. |
| Avoid stat on every CAS read | Complete | `record_cas_read` checks whether a sized CAS use is already recorded in this process before it calls `metadata`; the first read still backfills the size. |
| Move usage DB work off the hot path | Open | Usage recording has a process-global mutex and executes SQLite synchronously. WAL mode is enabled, but there is no checkpoint policy. |
| Shard CAS and task directories | Open | `cas/blobs`, `cas/meta`, and `tasks` remain flat. |
| Avoid redundant permission updates | Complete | Unix `restore_file_mode` compares the captured permission bits with the copied file before it calls `set_permissions`. |
| Discover CMake compiler headers before replay | Complete; benchmark pending | One syntax-only Ninja scan materializes the complete CMake project once, then GCC depfiles or MSVC `/showIncludes` restrict each compiler edge to its direct headers. Unsupported scan records keep the former broad-header input for that edge. |
| Add input fingerprints | Open | Input capture re-hashes files; there is no persisted `(path, metadata) -> digest` cache. |
| Parallelize input capture | Open | `capture_directory_trie` and `capture_paths` walk and hash serially. |

## Validation completed

- `cargo test -p imp-store`: 65 passed.
- `cargo test -p imp-execution`: 60 passed.
- `cargo test -p imp-engine`: 228 passed.

`imp test //...` was started with an isolated fresh cache. It began toolchain
downloads but did not complete in the available execution window. This is not
a pass or a failure result.

## Recommended next task

Move usage-database recording off the execution hot path. This removes
synchronous SQLite work from every CAS read without requiring a new benchmark
as part of the implementation.
