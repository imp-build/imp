# Cache and materialization baseline

Recorded so a change to the cache subsystem (`crates/imp-store`) can be
confirmed instead of written down as "benchmark pending". Read these numbers to
find an unwanted change in cache hits, in files hashed into the CAS, or in files
and directories written on the input-materialization path.

- Revision: `49ee3a7`
- Host: Linux x86_64 (WSL2), release build of `imp`
- Cache: see the protocol below.

## Protocol

`ci/cache_baseline.py` runs the workloads and reads the numbers back.

- **Cold** — a fresh `IMP_CACHE_DIR` for each run, so nothing is cached. There
  is no `imp cache clean`; a new empty directory is the way to a cold cache, and
  `cache_root()` is fixed once per process, so the variable is set before the
  process starts. A cold run fetches the toolchains, so it needs the network;
  the script retries a failed cold build once.
- **Warm (fixed point)** — the same `IMP_CACHE_DIR`, the command run again and
  again until two runs in a row report 0 fresh sandboxes.
  `testdata/graph/BASELINE.md`'s "read the second result" rule does **not** hold
  for these counts: `//crates/...` promotes one more action to cached on each of
  the first few warm runs (15 → 3 → 2 → 1 → 0 fresh), dropping roughly 20 000
  materializations each time, and only settles near the fifth run. The row
  records the fixed point and the run count that reached it.

Run each command with `IMP_TRACE_ARTIFACTS=1`. The `capture` count is the number
of `[artifact-trace] capture` lines; the materialize counts come from the
`[artifact-trace] materialize totals: files=… dir_creates=…` line that the goal
summary prints when tracing is on. A nested `imp` prints its own totals line;
the script sums them.

## What to compare

**The counts are the load-bearing numbers**, the same way sandbox count is for
the graph baseline. A count does not change with the speed of the machine, so a
change in one means the work changed:

- **fresh sandboxes** — actions that ran; 0 on a fully warm cache.
- **captures** — files read and hashed into the CAS.
- **materialize files** — files copied out of the CAS into a sandbox or the
  workspace.
- **materialize dirs** — `create_dir_all` calls on that copy path. This is the
  only signal for the "one `create_dir_all` per directory, not per file" work
  (item (a) below): the file and sandbox counts do not move with it.

Wall time is a weak secondary signal. Use it to find a large fall in speed, not
a small one.

## Workloads

| name | selector | what it exercises |
| --- | --- | --- |
| `crates_build` | `//crates/...` | the Rust crate graph — the warm-build materialization headline, toolchain trees copied through CAS input staging |
| `cmake_uses_cmake_lib` | `//rules/c/cmake/example:uses_cmake_lib` | the CMake compiler-header scan that narrows each edge's input set (item (b) below) |

`//...` is not used: on Linux it holds `//rules/c/cmake/example:raw_main_msvc`,
which needs `vswhere.exe` and fails on a machine that is not Windows.

## How to run

    ci/cache_baseline.py --update    write the numbers below again
    ci/cache_baseline.py --check     compare (machine-independent columns only)

`--check` is not wired into CI, the same as `ci/graph_golden.py`.

## Numbers

<!-- cache-baseline:metrics -->

### Warm cache (fixed point)

| workload | sandboxes | fresh | hit % | captures | mat files | mat dirs | time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| crates_build | 15 | 0 | 100 | 86 | 0 | 0 | 0.35s |
| cmake_uses_cmake_lib | 12 | 0 | 100 | 26 | 0 | 0 | 0.04s |

Warm runs needed to reach 0 fresh — crates_build: 5 runs, cmake_uses_cmake_lib: 2 runs.

### Cold cache (fresh IMP_CACHE_DIR, first run)

| workload | sandboxes | fresh | hit % | captures | mat files | mat dirs | time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| crates_build | 15 | 15 | 0 | 25528 | 85020 | 5603 | 225.35s |
| cmake_uses_cmake_lib | 12 | 12 | 0 | 12919 | 20901 | 705 | 26.57s |

### CMake, one header edited

`//rules/c/cmake/example:uses_cmake_lib` warm, then one header in `rules/c/cmake/example/` touched and rebuilt:

- fresh sandboxes after the edit: **8**

<!-- /cache-baseline:metrics -->

## Item (a): repeated parent-directory creation

`collect_materialize_jobs` (`crates/imp-store/src/digest.rs`) creates each
destination directory once during the trie walk; the parallel file copies then
use `copy_file_into_existing_dir`, which does no directory work. Before commits
`7e8b525` and `0704ca9` every file copy ran its own `create_dir_all(parent)`.

Measured on `crates_build`, cold cache (the run that materializes; a warm run
copies nothing). "Before" is the `materialize_one_file` path routed back through
`copy_file`, its per-file `create_dir_all` restored:

| tree | materialize files | materialize dirs |
| --- | --- | --- |
| current `HEAD` | 85020 | 5603 |
| per-file `create_dir_all` restored | 85020 | 90623 |

`90623 = 5603 + 85020` — one `create_dir_all` per directory node, plus, before
the change, one more per file. The same 15 sandboxes and 85 020 files
materialize either way.

**Resolved.** The change removes 85 020 `create_dir_all` calls from a cold
`//crates/...` build — a 16× cut in materialize-path directory syscalls, with no
change to files or sandboxes. Off "benchmark pending". `materialize dirs` in the
tables above is the standing guard against a regression.

## Item (b): CMake compiler headers discovered before replay

`scanCmakeCompilerInputs` (`rules/c/cmake/graph_replay.js`, commit `a4b46ee`)
runs one syntax-only Ninja pass up front and reads `ninja -t deps`, so replay
gives each compiler edge only its own workspace headers instead of the whole
project header set. The cost is one extra `cmake scan <path>` action per
project.

Measured on `cmake_uses_cmake_lib`. "Before" is `scanManifest` forced to return
the broad-input fallback for every compiler edge — the pre-`a4b46ee` behaviour.
Cold build, then one header in `rules/c/cmake/example/` edited and rebuilt:

| tree | cold materialize files | captures | fresh sandboxes after a one-header edit |
| --- | --- | --- | --- |
| current `HEAD` | 20901 | 12919 | 8 of 12 |
| broad header input forced | 20901 | 12919 | 8 of 12 |

**No movement on this workload, and that is the measured result.** The example
project has one workspace header, `hello.h`, included by every compiler edge, so
the narrowed per-edge set and the broad include-like set are the same set; the
scan adds one `cmake scan` action (part of the 12 919 cold captures) and changes
nothing else here. The narrowing pays off only where headers are many and globs
overlap; this workload can measure it on such a project when one exists. Off
"benchmark pending": it is measured, and the workload stands to re-measure it.
