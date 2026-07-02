# Remove the planned workflow; live evaluation only

## Context

imp has two execution paths: **planned** (introspect mode records JS effects →
task graph → `executor.rs` runs it) and **live** (`execute_goal_live`: product
functions fan out from roots via async/await + memoization, `run()` executes
immediately through the scheduler). The paths have diverged — `write_file` works
planned but is a silent no-op live (the vs.js bug) — and the goal has always
been to delete the planned path. `Build` is already live-only; the planned path
is now reached only by `plan`, `cache explain`, and (introspect mode) `explain`/
`actions`. The typed dependency graph (target handles/kinds/deps in BUILD.js)
stays; work is discovered by fan-out, not pre-planned.

**Decisions (fixed):**
1. Delete all four introspection CLI commands (`plan`, `explain`, `actions`, `cache explain`).
2. Remove `write_file` outright (it's wrong-by-design; a future side-effecting
   API restricted to top-level product dispatchers replaces it later — ROADMAP note only).
3. Wire all goals (test/fmt/lint/package/run) through the live path like `build`.
4. Harden live cache keys (config digest, env) in scope so removal doesn't regress correctness.

**Verified facts the plan relies on:**
- exec.rs doesn't use spike's `Plan`/`Task`/`Action`/`Artifact` (only cache.rs
  primitives, `src/exec.rs:18-23`) — the whole planned type family is deletable.
- Live `exec_run_inner` already content-digests staged inputs into `task_key`
  (`src/exec.rs:552-596`); upstream outputs materialize before downstream awaits
  resolve, so content digests **subsume** planned's `dependency_keys`. The real
  gaps are config digest and passthrough env, both absent from the live key.
- Memo keys already fold `__host_configuration_digest()` (`src/imp_core.js:867`).
- `run()` records its trace effect **unconditionally** (`imp_core.js:1114`),
  so JS tests keep asserting on `getMemoTrace()` — only `_introspect_mode` goes.
- `resetMemoState`/`getMemoTrace`/`_memo_trace` are live machinery (used by
  `execute_goal_live` `spike.rs:3316` and JS tests) — keep.
- Only `write_file` caller: `odinGenRun` generator branch (`rules/odin/index.js:818`).
- `select_roots` (`spike.rs:2099`) already gives sane per-goal defaults:
  no selectors → `//:default` if present, else every target with a product for
  the goal; Named-policy goals skip kinds without that product.

## Stage 1 — Wire all goals live ✅ DONE (commit f01aaa1)

- Done via a shared `#[derive(clap::Args)] struct GoalArgs` (selectors, `--jobs`,
  `--js-workers`, `--no-cache`); enum variants `Build(GoalArgs) | Test | Fmt |
  Lint | Package | Run` all dispatch to `cmd_execute_goal(goal, ...)` (renamed
  from `cmd_build_planned`). Goal name threaded through goal lookup, UI labels,
  watchdog error, and `execute_goal_live`. Stale "planned" help text fixed.
- Verified: `cargo build`/`cargo test` green; `fmt` (2/2 targets), `lint`,
  `build //:vs //:generated_stamp` (×2, second run clean), and `test` on each
  `rules_test` target individually all pass through the new wiring.
- **Selector syntax note**: `matches_selector` (`spike.rs:2189`) accepts full
  addresses (`//rules/odin:rules_test`), bare names, or `:name` suffix — NOT
  package prefixes. The verification commands below originally used
  `test //rules/odin`, which does not match anything.
- The imp repo's own root `BUILD.js` had broken demo targets (`//:cmake` with
  a nonexistent `CMakeLists.txt` entrypoint; `//:joltphysics` whose `**/*.h`/
  `**/*.cpp` glob swept the repo's own `target/` rquickjs artifacts into
  sandboxes; `//:jodin` depending on cmake). Removed — end-to-end goal testing
  happens in `../ottar` instead.

## Stage 2 — Harden the live cache key (before test ports so they assert against it)

In `exec_run_inner` (`src/exec.rs:521`):
- **Config digest**: JS `run()` adds `configDigest: __host_configuration_digest()`
  to the `__host_run` opts; `parse_exec_run_opts` (`spike.rs:1530`) copies it to a
  new `ExecRunOpts.config_digest`; fold into `action_digest` (`exec.rs:578`).
- **Passthrough env**: compute `passthrough_env_snapshot()` *before* the digest,
  merge `opts.env` over it, hash the merged env in `action_digest`, and reuse the
  same map for execution (today it's applied at `:653` but never hashed).
- Remove `dependency_keys` from `TaskCacheRecord` (always empty live; subsumed by
  content digests). Bump `TASK_CACHE_VERSION` 3 → 4. Update stale "planned tasks"
  comments (`exec.rs:444-446`, `:489-491`).
- Note in ROADMAP (don't do): tools are hashed by spec, not content
  (`fingerprint_tools` was planned-only).

## Stage 3 — Remove write_file; JS test strategy

- `rules/odin/index.js` `odinGenRun` generator branch (`:815-824`): replace with
  the gen.js/vs.js printf pattern:
  `run({ argv: ["sh","-c",'mkdir -p "$(dirname "$1")" && printf %s "$2" > "$1"',"odin-gen-write", output_path(outPath), content], outputs: [output(outPath)], display: \`generate ${outPath}\` })`.
  Content rides in argv so it keys the cache; drop `inputs` from this branch.
  Remove the `write_file` import (`:14`).
- `src/imp_core.js`: delete `write_file` (`:1067-1084`) + export.
- **Replace introspect in JS tests** — stub the host bridge, not the tracing
  (precedent: `fakeHost` in `rules/odin/toolchain_test.js:14`):
  ```js
  async function withFakeRun(fn) {
      const real = globalThis.__host_run;
      globalThis.__host_run = async () => ({ stdout: "", stderr: "", exitCode: 0 });
      try { return await fn(); } finally { globalThis.__host_run = real; }
  }
  ```
  Trace assertions (`trace.find(t => t.kind === "run" ...)`) keep working verbatim
  since tracing is unconditional. Convert the six `setIntrospectMode` tests in
  `rules/odin/index_test.js` (~:169, 271, 292, 323, 340, 364) and delete the
  introspect test in `rules/imp/tracked_apis_test.js:132` (add one `withFakeRun`
  smoke test). Hoist `withFakeRun` into `rules/imp/test/index.js` if shared.
- `rules/imp/test/index.js:153-159`: delete the `isIntrospectMode()` early-return
  and import (test product always runs tests).

## Stage 4 — Delete the planned core

- `src/main.rs`: delete `Cmd::Plan`, `Cmd::Cache`/`CacheCmd`, `Cmd::Explain`,
  `Cmd::Actions`; handlers `cmd_plan`, `cmd_cache`, `cmd_cache_explain`,
  `cmd_explain`, `cmd_actions`, `parse_product_selector`, `print_execution_report`;
  `mod executor`.
- Delete `src/executor.rs` (818 lines).
- `src/spike.rs`: delete `Plan`/`Task`/`Action`/`Artifact` (`:161-187`), `plan`
  (`:1987`), `plan_live` (`:1997`), `plan_inner` (`:2015`), `Planner` (`:2195-2269`),
  `memo_task_id`, `add_product_discovered_tasks` (`:2294-2552`), `render_dot`
  (`:2657`), `render_text_plan` (`:2691`), `introspect_product`/`IntrospectResult`
  (`:2940-3086`), `format_inspect_explain` (`:3089`), `format_inspect_actions`
  (`:3162`). **Keep**: `select_roots`, `goal_product_for_kind`, `matches_selector`,
  `execute_goal_live`, all `__host_*` bridges, scheduler bridges,
  `evaluate_product_function_json`, `generate_build_files`.
- `src/cache.rs`: delete planned-only fns — `evaluate_task_cache(_with_lookup)`,
  `disable_task_cache`, `prepare_sandbox`, `ingest_task_outputs`,
  `materialize_embedded_output_task`, `materialize_task_outputs_without_record`,
  `explain_task_cache`, `format_cache_explanation`, `digest_task_inputs`,
  `task_has_embedded_outputs`, `copy_artifact_into_sandbox`, `resolve_sandbox_path`,
  `fingerprint_tools`/`ToolFingerprint`, `SandboxManifest`/`SandboxInput`/
  `SandboxOutput`, `TaskCacheSummary`/`TaskCacheEvaluation`/`CacheExplanation`;
  `named_cache_bindings` if caller-less. (Verify callers per fn before deleting.)
- `src/runtime.rs:145-148`: drop `introspect_product`/`IntrospectResult` re-exports;
  fix module doc.
- `src/imp_core.js`: delete `_introspect_mode` (`:471`), `setIntrospectMode`/
  `isIntrospectMode` (`:948-950`), the introspect branch in `run()` (`:1109-1113`),
  `globalThis.setIntrospectMode` (`:1163`); fix `product()` docstring (`:836`).

## Stage 5 — Rust test disposition (`spike.rs` mod tests)

**Delete** (planned-graph semantics only): `dry_run_executor_*`,
`parallel_executor_*` (4), `executor_cancels_running_task_from_external_flag`
(live equivalent exists at `:5847`), `jobs_one_preserves_sequential_execution_order`,
`local_executor_materializes_embedded_manifest_outputs`,
`progress_executor_streams_process_output_path`,
`build_goal_plans_transitive_products` (`:4299`),
`product_plans_round_trip_through_json` (`:4415`),
`structured_rule_actions_lower_to_serializable_tasks` (`:4432`),
`dot_edges_*` (`:5534`), `sandbox_run_script_records_cwd_env_and_command`,
`explain_task_cache` assertions.

**Port to `exec_run_inner`-level tests** (temp workspace + temp `XDG_CACHE_HOME`;
pattern for live-goal style: `live_goal_no_cache_bypasses_run_task_cache` `:6654`):
cache hit on unchanged rerun (`:5070`); input edit invalidates + two-run pipeline
chaining (`:5151`); no-cache bypasses and does not populate (`:5108`); impure not
cacheable (`:5548`); force_cache overrides impure (`:5582`); missing declared
output bails (`exec.rs:696-700`); declared inputs staged / undeclared absent
(`:4841`); host env scrubbed (`:4883`); directory outputs materialized (`:4917`);
named-cache env paths (`:5230`, likely already covered by `:5268` — verify).
**New for Stage 2**: config-digest change invalidates; passthrough-env (PATH)
change invalidates.

**Rewrite against `select_roots`** (they call `plan()`):
`product_selector_hash_syntax_is_parsed` (`:6773`),
`product_registration_creates_dispatchable_product_task` (`:6730`).

**Keep**: all live tests `:5802+` (`quickjs_host_run_*`, `concurrent_roots_*`,
`live_goal_*`, `promise_all_fanout_*`, `sequential_sibling_*`, `deferred_run_*`),
workspace/loader/format tests.

## Stage 6 — Cycle/stall behavior ✅ DONE

Root cause of the hang-after-failure (diagnosed, was NOT failure propagation —
`execute_goal_live` resolves errors fine): when the drive future returns an
error, sibling product evaluations are abandoned inside the QuickJS runtime.
Their `scheduler.run` futures are never polled again, so their `Arc<Scheduler>`
clones (each holding an events sender) never drop, the events channel never
closes, and `render.await` in `cmd_execute_goal` blocked forever.

Fixes (all in `src/main.rs` `cmd_execute_goal`):
- Render task shuts down via an explicit oneshot signal instead of waiting for
  event-channel closure.
- On failure, the cancellation flag is set and a 300ms grace window lets the
  blocking workers (which poll the flag every ~20ms) kill their sandbox
  children — no orphaned processes.
- Watchdog error now lists the outstanding task labels (shared pending-labels
  map between render and watchdog): "…likely a dependency cycle; outstanding
  tasks: build(//:stuck)".

Verified: failing task among slow siblings → exit 1 in ~1.3s, zero orphans;
SIGTERM during a healthy run → clean "canceled" exit in ~300ms; genuine await
deadlock → watchdog fires at 30s naming the stuck task. Two regression tests
added (`live_goal_failure_propagates_instead_of_hanging`,
`live_goal_shared_failing_memo_propagates_to_all_roots`).

## Stage 7 — Cleanup

- `BUILD.js:15` stamp text "planned executor ran" → neutral.
- Delete untracked `plan.json` / `plan.dot`.
- ROADMAP.md: update planned/introspection sections (~`:960`, `:1170-1236`); add
  the future top-level-dispatcher write-API note and the tool-content-fingerprint note.
- Final sweep: `grep -rn "planned\|introspect\|plan_live\|write_file" src rules ROADMAP.md`.

## Order & verification (each stage leaves the repo green)

Order: 1 → 2 → 3 → 4 (+5 folded in) → 6 → 7. Stages 1–3 don't touch planned
code, so the big deletion lands on a validated live path.

```sh
export XDG_CACHE_HOME=/tmp/imp-cache   # sandboxed runs: $HOME may be read-only
cargo build && cargo test
cargo run -- build                        # live build, then again → cache hits
# NOTE: package-prefix selectors don't match; use full addresses. Run these
# separately — multiple rules_test roots in one invocation corrupt each other
# (shared JS memo state; see follow-ups).
cargo run -- test //rules/odin:rules_test
cargo run -- test //rules/imp:rules_test
cargo run -- test //rules/c/cmake:rules_test
cargo run -- fmt
cargo run -- build --no-cache
cargo run -- build //:vs#build            # run()-based file generation still works
```

## Surfaced separately (not in scope)

- ~~`default_product_for_kind` picks the first registered product in BTreeMap
  order — alphabetical luck.~~ **Resolved 2026-07-02**: this bit for real once
  fmt/format-check products were registered for odin-package (`build` silently
  dispatched fmt in ottar — "built 1 target", no binary, reformatted sources).
  Fixed by making goals map uniformly onto product names: build-goal products
  register as `"build"` (odinBuild, cmakeLib, vs, bundle, stamp, odinGen), the
  `Default` goal policy is deleted, and `Goal.product` is just a name. Explicit
  selectors changed: `//:app#odin-package` → `//:app#build`.

## Follow-up tasks (from Stage 1 verification, 2026-07-02)

1. ~~**Live path hangs after a root-task failure**~~ **Fixed in Stage 6** —
   see the Stage 6 section for the actual root cause (abandoned in-flight
   futures kept the render event channel open; not a failure-propagation bug).
2. **`rules_test` targets cannot share one invocation**: each passes alone, but
   `test //rules/odin:rules_test //rules/imp:rules_test` fails with a bogus
   "memo cycle detected / repeated key" — suites call `resetMemoState()` in the
   shared JS context and corrupt concurrently-evaluating roots. Bare
   `imp test` (which selects all three) hits this too. Address alongside the
   Stage 3/5 test rework — either isolate per-root JS contexts for rules-test
   or stop the suites from resetting global memo state.
3. **Selector UX**: package-prefix selectors (`//rules/odin`) silently match
   nothing and error; consider supporting package prefixes or improving the
   error message in `matches_selector` (`spike.rs:2189`).
4. Repo-root `BUILD.js` demo targets were removed (broken; see Stage 1 notes).
   If the repo should keep a self-contained end-to-end example, add one with
   real sources (e.g. a minimal CMakeLists + .cpp under a subdirectory-scoped
   glob) rather than root-level `**/*` globs that sweep `target/`.
