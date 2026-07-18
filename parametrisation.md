# Parametrisation: build-mode axes, profiles, and per-edge link()

## Context

imp currently has no mechanism for varying how a target builds based on an
axis like optimization level, cross-compilation target, or linking mode. Every
selected target in one invocation shares exactly one global `workspace_config`
and one global `goal_flags` value (`src/spike.rs:156`, `:381`); one address
maps to exactly one `Target` (`Workspace.targets: BTreeMap<String, Target>`,
`src/spike.rs:144-172`); and the only precedent for "a target's build varies"
is baking a choice into a target's declared attrs at BUILD.js-load time (e.g.
Odin's `toolchain:` attr override, `rules/odin/index.js:844-886`).

We looked at how Bazel (configurations + transitions), Buck2 (modifiers layered
over PACKAGE/target/CLI), and Pants (`parametrize()` → `@key=value` addresses)
solve this. None of them port directly: imp's dependencies are live JS
handles, not textual addresses, so there's no string to append a modifier
suffix to. The design below is built around that constraint, reusing existing
imp primitives (`memo()`, `configure()`/`configuration()`, `registerTarget()`,
the `Toolchain`-default pattern) rather than porting Bazel-style transitions or
Pants-style address parametrization wholesale.

Two axis *kinds* need different mechanisms, and this plan treats them
separately:

- **build-parameter axes** (optimization level, cross-compile target,
  sanitizers) genuinely need a differently-invoked build — a derived target.
- **output-selecting axes** (static vs. dynamic linking) don't: a library rule
  can produce both artifacts from one build, and only the *consuming* edge
  needs to pick which one to link. No re-derivation needed.

One combinator, `link(handle, overrides)`, serves both — for a build-parameter
axis it derives a variant target; for an output-selecting axis it just
annotates which existing output the edge should pull. `mode`/profiles are the
separate, ambient/global layer ("info for there" — the whole invocation's
default), while `link()` is the local, per-edge annotation ("info for here").
They compose: an ambient default resolves for every edge that doesn't specify
`link()`, and `link()` overrides it exactly at the edges that need to deviate.

Before any of this lands, one real landmine needs fixing. It's not `memo()`'s
in-process dedup cache that matters (that's ephemeral, cleared every process)
— it's `run()`'s `configDigest` (`src/imp_core.js:2160`), which flows
straight into `ExecAction.config_digest` → `Action.salt`
(`crates/imp-exec-api/src/lib.rs:11`), the literal salt of the
**persistent, cross-invocation action cache**. Today it's an unconditional
digest of the *entire* `workspace_config` map for every sandboxed action,
regardless of whether that action's product function reads configuration at
all. Storing a frequently-toggled axis through that same path would
invalidate every cached action in the workspace on every toggle — toolchain
downloads, unrelated packages, everything. Phase 0 fixes this before anything
is built on top of it. See **`config-digest-scoping.md`** for the full design
(an earlier draft of this phase used an explicit opt-in `configNamespaces`
list per call; it was rejected as too heavy and too easy to silently forget —
the shipped design tracks reads automatically instead, no signature changes
anywhere).

## Phase 0 — Scope the persistent action-cache salt (see `config-digest-scoping.md`)

**Goal:** a `run()`'s cache salt depends only on the configuration namespaces
its own call frame actually read, computed automatically — no opt-in list on
`memo()`, `run()`, or `configuration()`.

- Every `memo()`-wrapped call already forks a per-call context frame for
  owner/stack/cycle-detection bookkeeping (`_fork_context`/`_with_context`/
  `_clone_context`, `src/imp_core.js:1329-1394`). Add a fresh
  `readNamespaces: Set<string>` to that frame (not inherited from the parent
  — each frame tracks only its own direct reads).
- `configuration(namespace)` (`src/imp_core.js:505-517`) records into the
  current frame's `readNamespaces` as a side effect — purely additive, no
  signature change.
- `run()` (`src/imp_core.js:2122-2177`) already resolves its context frame
  at line 2123; change its `configDigest` computation (line 2160) to a digest
  scoped to that frame's `readNamespaces` instead of the whole map.
- Rust: extend `__host_configuration_digest` (`src/spike.rs:1778-1786`) to
  accept an optional namespace list and hash only that sub-map. No
  namespaces read → digest of the empty set, a fixed constant — the common
  case (most functions never call `configuration()`) gets a `run()` cache
  entirely independent of any `configure()` change anywhere, for free.
- `memo()`'s own key (`src/imp_core.js:1680`) is deliberately left
  untouched — its coarseness is harmless (in-process only, cleared every
  invocation, and axis values never change mid-invocation anyway), and fixing
  it would require restructuring `_memo_eval`'s hit/miss logic into a
  two-phase "look up, then validate recorded dependencies" scheme that isn't
  needed to solve the actual (persistent-cache) problem.
- Reserve a new config namespace, `"imp.mode"`, exclusively for mode-axis
  state (kept separate from rule-authored namespaces like `"odin"`, `"rust"`).
  A product function that calls `modeAxis("opt")` (Phase 1) automatically
  registers `"imp.mode"` as a read namespace for its frame — no
  declaration, no list to maintain — so its downstream `run()` is salted only
  by the axis bundle, and unrelated cached actions are untouched by axis
  toggles.

**Verification:** see `config-digest-scoping.md` — extends
`action_digest_keys_config_digest` (`crates/imp-execution/src/exec.rs:1237`)
and `live_config_digest_change_invalidates_run_cache`
(`src/spike.rs:7878`) with a case proving a `run()` is invalidated only by the
namespace its frame actually read, plus a regression case for functions that
never call `configuration()` at all.

## Phase 1 — Mode axis registry + CLI plumbing

**Goal:** a small typed registry for named axes, resolved once per invocation,
read at product-execution time.

- `defineModeAxis(name, { kind: "rebuild" | "output-select", values?, default })`
  — new module, e.g. `rules/imp/mode.js`. `kind` records which of the two
  mechanisms `link()` uses for this axis (see Phase 3/4). Mirrors the shape of
  `defineConfigSchema()` (`src/imp_core.js:448-461`) but writes into the
  reserved `"imp.mode"` namespace via `configure()`.
- `modeAxis(name)` — read the resolved value for an axis at execution time:
  ad hoc CLI `--axis` override → profile-selected value (Phase 2) → the
  axis's own declared default.
- CLI: extend `GoalArgs` (`src/main.rs:175-198`, shared by build/test/lint/
  package/run/goal) with a repeatable `--axis KEY=VALUE` flag. Fold parsed
  axis overrides into one `configure("imp.mode", {...})` call performed once
  before goal dispatch — same timing slot as today's `goal_flags` resolution
  (`src/main.rs:660-701`, `src/spike.rs:3970`/`4053`), so no change to
  workspace-load ordering is needed.
- **Explicit limitation to document, not solve here:** because this resolves
  *after* BUILD.js load (same constraint `goal_flags` already has — goal-
  declared flags "are only known post-load" per the comment at
  `src/main.rs:666-668`), axis values are read at **execution time only**.
  Rule constructors that bake a choice into attrs at declare time (Odin's
  toolchain-default pattern) can't source that choice from an axis in this
  version. Unifying the two is explicitly out of scope for this epic.

**Verification:** CLI parsing tests for repeated `--axis k=v` flags; a
rules-test exercising `modeAxis()`'s resolution order (default → CLI override,
profile ordering added in Phase 2's tests).

## Phase 2 — Profiles

**Goal:** named, checked-in bundles of axis defaults, selected by `--profile`.

- `defineProfile(name, { ...axisValues })` — checked into a workspace file
  (e.g. `imp.workspace.js` or a dedicated `profiles.js`).
- CLI: `--profile NAME` alongside `--axis` (both live on `GoalArgs`, same
  resolution pass as Phase 1). A selected profile expands into axis defaults;
  ad hoc `--axis key=value` flags override individual axes from the profile,
  last-wins per axis — mirroring Buck2's PACKAGE-default/CLI layering, but
  implemented as ordinary default-value resolution, not a constraint solver.
- Full precedence order, to document precisely in code/DOC.md:
  `defineModeAxis` default → `--profile` → ad hoc `--axis` → (Phase 3) per-edge
  `link()` override.

**Verification:** profile expansion tests; override-layering tests
(`--profile=windows-release --axis opt=debug` yields `opt: "debug"`, all
other axes from the profile).

## Phase 3 — `link(handle, overrides)`: the per-edge combinator

**Goal:** the per-edge escape hatch, and the mechanism for build-parameter
axes that genuinely need a differently-invoked build.

- `link(handle, overrides)` — takes a dependency handle and an axis-overrides
  object, returns immutable **edge metadata**, not an eagerly-created target.
  A consumer passes that reference to `productFor()`; only then does imp
  reconstruct and dispatch the requested variant. Linked variants are not
  standalone selectors in a fresh invocation.
- **Opt-in per kind**, not generic reflection over `attrs`: a rule kind that
  wants to be `link()`-able exposes an explicit reconstruction hook (e.g. a
  static `deriveXxx(handle, overrides)` alongside its constructor). Calling
  `link()` on a non-participating kind throws a clear error naming the kind.
  (Generic `{...handle.attrs, ...overrides}` reconstruction is rejected as too
  leaky — constructor opts and stored attrs don't always shape-match, e.g.
  Odin's `toolchain` opt vs. `attrs.toolchainVersion` split,
  `rules/odin/index.js:875-886`.)
- Memoization: `link()` uses a synchronous per-load identity cache keyed by
  `(handle identity, canonical overrides)` — `memo()` cannot be used because
  it returns an async thenable and a linked reference must be valid in a
  declared `deps` array. Repeated links therefore share one lazy derived
  target once consumed.
- A participating kind exposes `static derive(base, overrides)` beside its
  constructor. `productFor(link(...), product)` invokes the hook lazily and
  runs the resulting product under an async-local mode overlay. `modeAxis()`
  therefore sees the edge override while omitted axes retain the invocation
  profile/CLI/default value; the overlay is included in a mode-reading
  `run()` action's cache salt.
- Phase 3 accepts `kind: "rebuild"` axes only. `output-select` overrides are
  rejected until Phase 4 supplies their artifact-selection semantics.

**Verification:** derivation+memoization test (two identical linked edges
consumed from different call sites resolve to one derived target); mode-overlay
and cache-salt test; metadata hydration test; error tests for output-select
axes and non-participating kinds.

## Phase 4 — Output-selecting axes (pattern, not a concrete rule module)

**Goal:** document and land the *pattern* for axes like linking mode, where a
library-shaped rule exposes multiple named outputs from one target and the
consumer picks.

- Guidance for rule authors: a "library" rule computes N named outputs (e.g.
  static archive + shared object) from one target instead of deriving a
  second target per linking mode.
- A consuming edge's link step chooses which output to request by reading the
  ambient `linking` axis (Phase 1/2 default) unless overridden per-edge via
  `link(handle, { linking: "static" })` (Phase 3's same combinator, `kind:
  "output-select"` path — no target derivation, just output selection).
- **Explicitly deferred, per discussion:** wiring this into any real rule
  module (e.g. adding Odin's missing `-build-mode:dll` shared-library product
  so Odin can actually participate) is a separate follow-up, not part of this
  epic. This phase lands the pattern/API only.

**Verification:** none beyond what Phase 3 already covers for the `link()`
API surface — no concrete rule module changes in this phase, so nothing new
to exercise end-to-end yet.

## End-to-end proof of mechanism (last step of this epic)

Wire `opt` (or another single simple axis) through one existing, simple
product function purely to prove the full chain works — not production
adoption of the axis system in any real rule module. Concretely:

1. `defineModeAxis("opt", { kind: "rebuild", values: ["debug", "release"],
   default: "debug" })`.
2. One small, throwaway example target (or an existing simple one) whose
   product function reads `modeAxis("opt")` and branches on it — Phase 0's
   automatic read-tracking picks this up with no extra wiring at the call
   site.
3. Confirm via `cargo run -- goal build --axis opt=release //example:...` vs.
   `--axis opt=debug`: distinct cache entries/outputs per value, and that
   toggling does **not** invalidate unrelated cached targets (the concrete
   scenario Phase 0 exists to prevent) — check via cache hit/miss log lines,
   same technique used earlier this session to verify the Odin toolchain fix.
4. One `link(handle, { opt: "release" })` call site depending on that example
   target, confirming a second, correctly-addressed derived target appears
   and is independently selectable/cacheable.

## Explicitly out of scope for this epic

- Unifying axis resolution with the existing declare-time `Toolchain`-default
  pattern (would require moving axis resolution before workspace load).
- Per-directory/PACKAGE-file-style scoping of axis defaults (Buck2's PACKAGE
  layer) — this epic's profile/axis defaults are invocation-global only.
- Full Bazel-style transitions (edge-scoped configuration propagation,
  automatic exec-vs-target-platform splitting).
- Odin's `-build-mode:dll` / any concrete rule-module adoption of the
  output-selecting pattern (Phase 4 lands the pattern only).
