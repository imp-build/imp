//! QuickJS-backed target, rule, and goal planning spike.
//!
//! `imp.workspace.js` imports plugin modules that register rules via
//! `__host_rule`.  Workspace `BUILD.js` files declare and export target handles
//! via `__host_target`.  The Rust engine resolves product requests into a task
//! DAG without executing it.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread;
use std::time::Duration;

use crate::toolchain;
use anyhow::{bail, Context, Result};
use regex::Regex;
use rquickjs::{
    loader::{Loader, Resolver},
    module::Declared,
    promise::MaybePromise,
    Array, CatchResultExt, Context as JsContext, Ctx, Filter, Function, Module, Object, Runtime,
    Value,
};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use walkdir::WalkDir;

const WORKSPACE_FILE: &str = "imp.workspace.js";
const BUILD_FILE: &str = "BUILD.js";

/// The built-in `imp:core` module exposed to every plugin and BUILD file.
const CORE_JS: &str = r##"
/**
 * Declare a target and return a target handle.
 *
 * @param {object} opts
 * @param {string} opts.kind Stable target kind understood by extension rules.
 * @param {Record<string, string>} [opts.fields={}] String fields stored on the target.
 * @param {Array<object>} [opts.deps=[]] Dependencies as target handles returned by target().
 * @returns {object} An opaque target handle for exports and dependency lists.
 *
 * Constructors should perform domain validation in JavaScript and throw normal
 * Error objects for invalid arguments. The host validates only core invariants,
 * such as dependency values being target handles.
 */
export function target(opts) {
    const depIds = [];
    const depModes = [];
    for (const d of (opts.deps || [])) {
        if (d && d.__imp === true) {
            depIds.push(d.__id);
            depModes.push(null);
        } else if (d && d.target && d.target.__imp === true) {
            depIds.push(d.target.__id);
            depModes.push(d.mode != null ? String(d.mode) : null);
        } else {
            throw new Error('dep must be a target handle or { target, mode }, got: ' + JSON.stringify(d));
        }
    }
    return __host_target(opts.kind, opts.fields || {}, depIds, depModes);
}

/**
 * Register a rule for producing a product from a target kind.
 *
 * @param {object} opts
 * @param {string} opts.kind Target kind this rule applies to.
 * @param {string} opts.product Product name produced by the rule.
 * @param {string|object} opts.action Human-readable action template, or a
 * structured action object with argv/cwd/env/platform/inputs/outputs/display.
 * @param {boolean} [opts.action.impure=false] Mark the action as impure (non-deterministic). Impure tasks are uncacheable by default.
 * @param {boolean} [opts.action.force_cache=false] Force caching of an impure task. The caller accepts that stale outputs may be reused.
 * @param {boolean} [opts.requiresOwnSources=false] Whether non-source products depend on this target's sources product.
 * @param {string|null|undefined} [opts.dependencyProduct=null] Product requested from dependencies; use "default" for their default product.
 * @returns {void}
 */
export function rule(opts) {
    __host_rule(
        opts.kind, opts.product, opts.action,
        opts.requiresOwnSources === true,
        opts.dependencyProduct !== undefined ? opts.dependencyProduct : null,
        opts.exec || null
    );
}

/**
 * Declare a plugin-managed raw cache directory.
 *
 * Named caches are intentionally opaque to the task cache. Actions receive a
 * stable directory path through IMP_NAMED_CACHE_<NAME>, and plugins decide
 * what to store there.
 *
 * @param {object} opts
 * @param {string} opts.name Stable cache name, using lowercase ASCII, digits,
 * hyphens, or underscores.
 * @returns {void}
 */
export function namedCache(opts) {
    __host_named_cache(opts.name);
}

/**
 * Register a goal and its product-selection policy.
 *
 * The built-in "build" goal is pre-registered with productPolicy "default".
 * Extensions may register additional goals. Duplicate goal names are silently
 * ignored (first registration wins).
 *
 * @param {object} opts
 * @param {string} opts.name Goal name, e.g. "test" or "fmt".
 * @param {string} [opts.productPolicy="default"] Product to request from each
 *   selected target. Use "default" to request each target's default product
 *   (first non-"sources" rule), or a product name to request that specific
 *   product (targets lacking a rule for it are skipped).
 * @returns {void}
 */
export function goal(opts) {
    __host_goal(opts.name, opts.productPolicy !== undefined ? opts.productPolicy : "default");
}

/**
 * Register a named platform.
 *
 * The built-in "local" platform is pre-registered with the native executor and
 * the current machine's OS-arch as the target. Duplicate platform names are
 * silently ignored (first registration wins).
 *
 * @param {object} opts
 * @param {string} opts.name Platform name referenced in action.platform.
 * @param {string} opts.executor Execution backend: "local", "wsl", or "container".
 * @param {string} opts.target Target OS-arch string, e.g. "windows-x86_64".
 * @returns {void}
 */
export function platform(opts) {
    __host_platform(opts.name, opts.executor, opts.target);
}

// ---------------------------------------------------------------------------
// Toolchain acquisition primitives
// ---------------------------------------------------------------------------

/**
 * Download a URL to the local download cache.
 * @param {string} url
 * @returns {string} Local path to the downloaded file.
 */
export function download(url) {
    return __host_download(url);
}

/**
 * Extract an archive to a directory.
 * @param {string} archive Path to the archive file.
 * @param {string} dest    Destination directory.
 * @param {object} opts
 * @param {string} opts.format Archive format: "tar.gz", "tgz", or "zip".
 * @param {number} [opts.strip_components=0] Number of leading path components to strip (tar.gz only).
 * @returns {void}
 */
export function extract(archive, dest, opts) {
    __host_extract(archive, dest, opts.format, opts.strip_components || 0);
}

/**
 * Detect the current platform.
 * @returns {{ os: string, arch: string }}
 */
export function platformInfo() {
    return JSON.parse(__host_platform_info());
}

/**
 * Compute the SHA-256 digest of a file.
 * @param {string} path
 * @returns {string} Hex-encoded digest.
 */
export function sha256(path) {
    return __host_sha256(path);
}

/**
 * Store a file or directory into a named cache under a key.
 * @param {string} name   Cache name (matches a namedCache() declaration).
 * @param {string} key    Sub-key within the cache (e.g. "dev-2026-03/linux-x86_64").
 * @param {string} source Path to the file or directory to cache.
 */
export function cachePut(name, key, source) {
    __host_cache_put(name, key, source);
}

/**
 * Retrieve the path of a cached item.
 * @param {string} name Cache name.
 * @param {string} key  Sub-key.
 * @returns {string|null} Local path if the key exists, null otherwise.
 */
export function cacheGet(name, key) {
    return __host_cache_get(name, key);
}

/**
 * Check whether a key exists in a named cache.
 * @param {string} name Cache name.
 * @param {string} key  Sub-key.
 * @returns {boolean}
 */
export function cacheHas(name, key) {
    return __host_cache_has(name, key);
}

/**
 * List workspace files below a workspace-rooted directory.
 *
 * Returned paths are module specifiers without the trailing `.js`, so they can
 * be passed directly to dynamic import().
 *
 * @param {object} opts
 * @param {string} opts.root Workspace-rooted directory, e.g. "//rules/odin".
 * @param {string} [opts.suffix] File suffix to include, e.g. "_test.js".
 * @returns {string[]} Sorted workspace module specifiers.
 */
export function workspaceFiles(opts) {
    return JSON.parse(__host_workspace_files(opts.root, opts.suffix || ""));
}

/**
 * List workspace source files matching Rust regular expressions.
 *
 * Returned paths are workspace-relative, using `/` separators.
 *
 * @param {object} opts
 * @param {string} [opts.root="."] Workspace-relative directory to search.
 * @param {string[]} opts.include Regexes; a file is included if any matches.
 * @param {string[]} [opts.exclude=[]] Regexes; a file is excluded if any matches.
 * @returns {string[]} Sorted workspace-relative file paths.
 */
export function workspaceSourceFiles(opts) {
    if (!opts || !Array.isArray(opts.include)) {
        throw new Error("workspaceSourceFiles({ root?, include, exclude? }) requires include regexes");
    }
    return JSON.parse(__host_workspace_source_files(
        opts.root || ".",
        JSON.stringify(opts.include),
        JSON.stringify(opts.exclude || []),
    ));
}

/**
 * List matching workspace source files and capture each file into CAS.
 *
 * @param {object} opts
 * @param {string} [opts.root="."] Workspace-relative directory to search.
 * @param {string[]} opts.include Regexes; a file is included if any matches.
 * @param {string[]} [opts.exclude=[]] Regexes; a file is excluded if any matches.
 * @returns {{ path: string, digest: string, bytes: number }[]} Sorted source entries.
 */
export function workspaceSourceEntries(opts) {
    if (!opts || !Array.isArray(opts.include)) {
        throw new Error("workspaceSourceEntries({ root?, include, exclude? }) requires include regexes");
    }
    return JSON.parse(__host_workspace_source_entries(
        opts.root || ".",
        JSON.stringify(opts.include),
        JSON.stringify(opts.exclude || []),
    ));
}

/**
 * Store a set of source entries as a CAS tree, returning its digest.
 *
 * Entries are sorted by path before storage, so the digest is stable
 * regardless of input order.
 *
 * @param {{ path: string, digest: string, bytes: number }[]} entries
 * @returns {string} Tree digest.
 */
export function casTreeStore(entries) {
    return __host_cas_tree_store(JSON.stringify(entries));
}

/**
 * Retrieve the entries of a CAS tree by digest.
 *
 * @param {string} digest Tree digest returned by casTreeStore or casTreeMerge.
 * @returns {{ path: string, digest: string, bytes: number }[]} Sorted entries.
 */
export function casTreeGet(digest) {
    return JSON.parse(__host_cas_tree_get(digest));
}

/**
 * Merge multiple CAS trees into one, returning the merged tree's digest.
 *
 * Same path with the same digest is deduplicated silently. Same path with
 * different digests (conflicting content) is an error.
 *
 * @param {...string} digests Tree digests to merge.
 * @returns {string} Merged tree digest.
 */
export function casTreeMerge(...digests) {
    return __host_cas_tree_merge(JSON.stringify(digests));
}

/**
 * Retrieve the kind, fields, and dep handles for a target handle.
 *
 * @param {object} handle A target handle returned by target().
 * @returns {{ kind: string, fields: Record<string, string>, deps: Array<{ handle: object, mode: string|null }> }}
 */
export function hydrateTarget(handle) {
    if (!handle || handle.__imp !== true) {
        throw new Error('hydrateTarget: expected a target handle');
    }
    return JSON.parse(__host_hydrate_target(handle.__id));
}

/**
 * Collect all targets of a given kind reachable from a handle (depth-first, deduped).
 *
 * @param {object} handle Root target handle.
 * @param {string} kind Target kind to collect, e.g. "odin-package".
 * @returns {object[]} Handles of all matching targets in the transitive closure.
 */
export function gatherTransitiveClosure(handle, kind) {
    const visited = new Set();
    const result = [];
    function walk(h) {
        if (!h || h.__imp !== true) return;
        const id = h.__id;
        if (visited.has(id)) return;
        visited.add(id);
        const t = hydrateTarget(h);
        if (t.kind === kind) result.push(h);
        for (const dep of t.deps) walk(dep.handle);
    }
    walk(handle);
    return result;
}

/**
 * Mount an external directory into the workspace module namespace.
 *
 * Static imports are resolved before a workspace module body runs, so mount
 * first, then use dynamic import:
 *
 *   workspaceMount({ prefix: "//rules", path: "../imp/rules" });
 *   await import("//rules/odin");
 *
 * @param {object} opts
 * @param {string} opts.prefix Workspace module prefix, e.g. "//rules".
 * @param {string} opts.path Directory containing modules for that prefix.
 * @returns {void}
 */
export function workspaceMount(opts) {
    if (!opts || typeof opts.prefix !== "string" || typeof opts.path !== "string") {
        throw new Error("workspaceMount({ prefix, path }) requires prefix and path strings");
    }
    __host_workspace_mount(opts.prefix, opts.path);
}

// ---------------------------------------------------------------------------
// memo() — memoized async build functions (Phase 1)
// ---------------------------------------------------------------------------

const _memo_fn_ids = new WeakMap();
let _memo_fn_counter = 0;

function _stable_function_id(fn) {
    let id = _memo_fn_ids.get(fn);
    if (id === undefined) {
        id = (fn.name || "<anonymous>") + "#" + (++_memo_fn_counter);
        _memo_fn_ids.set(fn, id);
    }
    return id;
}

// Serialize args to a stable string. Target handles ({ __imp: true, __id })
// are replaced with { __imp_ref: <id> } so identity is by numeric ID.
function _stable_digest(args) {
    return JSON.stringify(args, function(key, value) {
        if (value !== null && typeof value === "object"
                && value.__imp === true && typeof value.__id === "number") {
            return { __imp_ref: value.__id };
        }
        return value;
    });
}

let _memo_table = new Map();
let _memo_call_stack = [];
let _memo_call_stack_set = new Set();
let _memo_deps = [];
let _memo_trace = [];

function _memo_eval(key_string, thunk) {
    // Cycle check BEFORE table check: a key in the call stack means it is
    // currently being evaluated in this call chain.
    if (_memo_call_stack_set.has(key_string)) {
        throw new Error("memo cycle detected: " + key_string);
    }
    if (_memo_table.has(key_string)) {
        _memo_trace.push({ event: "hit", key: key_string });
        return _memo_table.get(key_string);
    }
    _memo_trace.push({ event: "miss", key: key_string });
    // Call thunk() synchronously so _push_call runs before the first await,
    // keeping the call stack accurate during the synchronous portion.
    const promise = thunk();
    _memo_table.set(key_string, promise);
    return promise;
}

function _push_call(key_string) {
    if (_memo_call_stack.length > 0) {
        _memo_deps.push({
            caller: _memo_call_stack[_memo_call_stack.length - 1],
            callee: key_string,
        });
    }
    _memo_call_stack.push(key_string);
    _memo_call_stack_set.add(key_string);
}

function _pop_call(key_string) {
    _memo_call_stack.pop();
    _memo_call_stack_set.delete(key_string);
}

/**
 * Wrap an async function so repeated calls with identical arguments return the
 * cached result. Cycles in the call graph are detected and thrown as errors.
 * Call getMemoTrace() for hit/miss events and dependency edges.
 *
 * @param {function} fn Named async function to memoize.
 * @returns {function}
 */
/**
 * Register a memoized build function as a CLI-dispatchable product.
 *
 * Calling `product(kind, name, fn)` is equivalent to `memo(fn)` plus
 * registering the result so that `imp build --planned //:target#name`
 * dispatches to it when the target's kind matches.
 *
 * @param {string} kind Target kind, e.g. "odin-package".
 * @param {string} name Product name, e.g. "executable".
 * @param {function} fn Async function taking a target handle and returning a result.
 * @returns {function} The same function, wrapped in memo().
 */
export function product(kind, name, fn) {
    const memoized = memo(fn);
    __host_product(kind, name, memoized);
    return memoized;
}

export function memo(fn) {
    const fn_id = _stable_function_id(fn);
    return async function memoized(...args) {
        const key_string = JSON.stringify({
            fn_id,
            args_digest: _stable_digest(args),
            config_digest: "",
        });
        return _memo_eval(key_string, async () => {
            _push_call(key_string);
            try {
                return await fn(...args);
            } finally {
                _pop_call(key_string);
            }
        });
    };
}

/**
 * Reset all memo state. Call between test runs to start with a clean slate.
 * Does NOT reset function identity — the same function reference always maps
 * to the same ID even across resets.
 */
export function resetMemoState() {
    _memo_table = new Map();
    _memo_call_stack = [];
    _memo_call_stack_set = new Set();
    _memo_deps = [];
    _memo_trace = [];
}

/**
 * Return a snapshot of the memo trace and dependency graph.
 * @returns {{ trace: Array<{event: string, key: string}>, deps: Array<{caller: string, callee: string}> }}
 */
export function getMemoTrace() {
    return {
        trace: _memo_trace.slice(),
        deps: _memo_deps.slice(),
    };
}

// ---------------------------------------------------------------------------
// Tracked runtime APIs (Phase 3)
// ---------------------------------------------------------------------------

// glob() returns a lazy FileSet descriptor — no I/O happens here.
// Call paths(fileset) to evaluate it.
export function glob(opts) {
    if (!opts || !Array.isArray(opts.include)) {
        throw new Error("glob({ root?, include, exclude? }) requires include regexes");
    }
    return { __fileset: true, kind: "glob", root: opts.root || ".", include: opts.include, exclude: opts.exclude || [] };
}

// ---------------------------------------------------------------------------
// FileSet — lazy file collection (Phase 4)
// ---------------------------------------------------------------------------

function _eval_fileset(fs) {
    if (!fs || fs.__fileset !== true) throw new Error("paths() requires a FileSet");
    if (fs.kind === "glob") {
        return JSON.parse(__host_glob(
            fs.root,
            JSON.stringify(fs.include),
            JSON.stringify(fs.exclude),
        ));
    }
    if (fs.kind === "union") {
        const seen = new Set();
        const all = [];
        for (const s of fs.sets) {
            for (const p of _eval_fileset(s)) {
                if (!seen.has(p)) { seen.add(p); all.push(p); }
            }
        }
        all.sort();
        return all;
    }
    if (fs.kind === "literal") {
        return fs.paths.slice().sort();
    }
    throw new Error("paths(): unsupported FileSet kind: " + fs.kind);
}

export function paths(fileset) {
    if (!fileset || fileset.__fileset !== true) {
        throw new Error("paths() requires a FileSet value");
    }
    const result = _eval_fileset(fileset);
    _memo_trace.push({ event: "effect", kind: "paths", fileset_kind: fileset.kind, count: result.length });
    return result;
}

export const file_set = {
    union(...sets) {
        for (const s of sets) {
            if (!s || s.__fileset !== true) throw new Error("file_set.union() requires FileSet values");
        }
        return { __fileset: true, kind: "union", sets };
    },
    literal(file_paths) {
        if (!Array.isArray(file_paths)) throw new Error("file_set.literal() requires an array of paths");
        return { __fileset: true, kind: "literal", paths: file_paths };
    },
};

// Expand any FileSet objects in an inputs array to flat {kind, path}[] specs.
// Plain {kind, path} objects are passed through unchanged.
function _materialise_inputs(inputs) {
    const result = [];
    for (const input of (inputs || [])) {
        if (input && input.__fileset === true) {
            for (const p of paths(input)) {
                result.push({ kind: "file", path: p });
            }
        } else if (input != null) {
            result.push(input);
        }
    }
    return result;
}

export function output(path, opts) {
    return { kind: (opts && opts.kind) || "file", path };
}

export function env(name) {
    const result = __host_env(name);
    _memo_trace.push({ event: "effect", kind: "env", name, result });
    return result ?? null;
}

export function which(name) {
    const result = __host_which(name);
    _memo_trace.push({ event: "effect", kind: "which", name, result });
    return result ?? null;
}

export function read_file(path) {
    const result = __host_read_file(path);
    _memo_trace.push({ event: "effect", kind: "read_file", path });
    return result;
}

export async function run(opts) {
    _memo_trace.push({ event: "effect", kind: "run", display: opts.display ?? (opts.argv && opts.argv[0]) });
    return __host_run({
        argv: opts.argv,
        display: opts.display,
        env: opts.env,
        inputs: _materialise_inputs(opts.inputs),
        outputs: opts.outputs,
        tools: opts.tools,
        impure: opts.impure,
        forceCache: opts.forceCache,
    });
}

export async function workspace_mutation(opts) {
    _memo_trace.push({ event: "effect", kind: "workspace_mutation", display: opts.display ?? (opts.argv && opts.argv[0]) });
    return __host_workspace_mutation(opts);
}
"##;

// ---------------------------------------------------------------------------
// Public data types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Target {
    pub address: String,
    pub kind: String,
    pub fields: BTreeMap<String, String>,
    pub dependencies: Vec<Dependency>,
    /// The QuickJS numeric id of this target's handle object (`{ __imp: true, __id: N }`).
    /// Stored so product tasks can reconstruct a valid handle to pass to product functions.
    #[serde(skip)]
    pub js_id: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Dependency {
    pub address: String,
    pub mode: DependencyMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DependencyMode {
    Auto,
    /// The dependency edge requests a specific named product from the dep target,
    /// overriding the rule's `dependencyProduct`. Well-known values are
    /// `"sources"`, `"link"`, and `"runtime"`.
    Named(String),
}

/// Execution backend — where task commands are dispatched.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Executor {
    /// Native `std::process::Command` on the local machine.
    Local,
    /// PowerShell bridge through WSL (model only — not yet implemented).
    Wsl,
    /// Container runtime (future).
    Container,
}

impl Executor {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "local" => Some(Self::Local),
            "wsl" => Some(Self::Wsl),
            "container" => Some(Self::Container),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Wsl => "wsl",
            Self::Container => "container",
        }
    }
}

/// A registered platform: bundles executor (where to run) and target (what to build for).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformDef {
    pub name: String,
    pub executor: Executor,
    /// Opaque OS-arch string, e.g. `"linux-x86_64"` or `"windows-x86_64"`.
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub target_kind: String,
    pub product: String,
    pub action: ActionSpec,
    pub requires_own_sources: bool,
    pub dependency_product: DependencyProduct,
    /// Name of the JS global storing this rule's `exec(target, ctx)` function,
    /// if one was provided. `None` means the rule uses the legacy `action` path.
    pub exec_fn: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DependencyProduct {
    None,
    Named(String),
    Default,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Goal {
    pub name: String,
    pub product_policy: GoalProductPolicy,
}

/// How a goal selects a product from each matching target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GoalProductPolicy {
    /// Use the target's default product (first non-`"sources"` rule).
    Default,
    /// Request this specific product; targets lacking a rule for it are skipped.
    Named(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionSpec {
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
    pub platform: Option<String>,
    pub inputs: Vec<ArtifactSpec>,
    pub outputs: Vec<ArtifactSpec>,
    pub display: String,
    pub impure: bool,
    pub force_cache: bool,
}

impl ActionSpec {
    fn legacy(display: String) -> Self {
        Self {
            argv: Vec::new(),
            cwd: None,
            env: BTreeMap::new(),
            platform: None,
            inputs: Vec::new(),
            outputs: Vec::new(),
            display,
            impure: false,
            force_cache: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactSpec {
    pub id: Option<String>,
    pub kind: String,
    pub path: Option<String>,
    pub value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Artifact {
    pub id: String,
    pub kind: String,
    pub path: Option<String>,
    pub value: Option<String>,
    pub producer: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Action {
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
    pub platform: Option<String>,
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    pub display: String,
    #[serde(default)]
    pub impure: bool,
    #[serde(default)]
    pub force_cache: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub target: String,
    pub product: String,
    pub fields: BTreeMap<String, String>,
    pub inputs: Vec<Artifact>,
    pub outputs: Vec<Artifact>,
    pub action: Action,
    pub exec_fn: Option<String>,
    pub dependencies: Vec<String>,
    /// JS handle id for this task's target. Used to reconstruct `{ __imp: true, __id }` for product tasks.
    #[serde(default)]
    pub js_id: u32,
    /// True when this task was created from a `product()` registration rather than a `rule()`.
    #[serde(default)]
    pub is_product: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    pub goal: String,
    pub roots: Vec<String>,
    pub named_caches: Vec<NamedCache>,
    pub tasks: Vec<Task>,
}

#[derive(Debug, Clone, Default)]
pub struct Workspace {
    pub rules: BTreeMap<(String, String), Rule>,
    pub targets: BTreeMap<String, Target>,
    pub products: BTreeMap<(String, String), String>,
    pub named_caches: BTreeMap<String, NamedCache>,
    pub goals: BTreeMap<String, Goal>,
    pub platforms: BTreeMap<String, PlatformDef>,
}

/// A loaded workspace with a live QuickJS runtime.
///
/// Keeps the runtime and context alive so that rule `exec` functions can be
/// called during task execution. Use `Deref` to access the underlying
/// [`Workspace`] for planning and inspection.
pub struct LiveWorkspace {
    pub workspace: Workspace,
    pub(super) runtime: Runtime,
    pub(super) ctx: Mutex<JsContext>,
    /// Workspace root made available to host functions during task execution.
    pub(super) exec_root: Arc<Mutex<Option<PathBuf>>>,
}

impl std::fmt::Debug for LiveWorkspace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveWorkspace")
            .field("workspace", &self.workspace)
            .field("runtime", &"Runtime { .. }")
            .field("ctx", &"Context { .. }")
            .field("exec_root", &"Arc<Mutex<..>>")
            .finish()
    }
}

impl std::ops::Deref for LiveWorkspace {
    type Target = Workspace;
    fn deref(&self) -> &Workspace {
        &self.workspace
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamedCache {
    pub name: String,
    pub env_var: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionMode {
    DryRun,
    Local,
}

#[derive(Debug, Clone)]
pub struct ExecutionOptions {
    pub mode: ExecutionMode,
    pub jobs: usize,
    /// Name of the active platform; only tasks whose `action.platform` matches
    /// (or is `None`) are executed. Defaults to `"local"`.
    pub platform: String,
}

impl ExecutionOptions {
    pub fn new(mode: ExecutionMode, jobs: usize) -> Self {
        Self {
            mode,
            jobs: jobs.max(1),
            platform: "local".to_owned(),
        }
    }

    pub fn with_platform(mut self, platform: impl Into<String>) -> Self {
        self.platform = platform.into();
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskExecutionStatus {
    WouldRun,
    CacheHit,
    Ran,
    Noop,
    /// Task was not executed because its platform requirement doesn't match the
    /// active platform.
    SkippedPlatform,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskExecution {
    pub task_id: String,
    pub status: TaskExecutionStatus,
    pub command: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionReport {
    pub tasks: Vec<TaskExecution>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct SandboxManifest {
    task_id: String,
    sandbox_root: PathBuf,
    cache_root: PathBuf,
    input_runlist: Vec<SandboxInput>,
    output_runlist: Vec<SandboxOutput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct SandboxInput {
    artifact_id: String,
    source: PathBuf,
    sandbox_path: PathBuf,
    kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct SandboxOutput {
    artifact_id: String,
    sandbox_path: PathBuf,
    cache_path: PathBuf,
    kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CacheInputDigest {
    pub artifact_id: String,
    pub kind: String,
    pub path: Option<String>,
    pub value: Option<String>,
    pub digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct CacheDirectoryEntry {
    path: String,
    digest: String,
    bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SourceFileEntry {
    path: String,
    digest: String,
    bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct CachedArtifact {
    artifact_id: String,
    kind: String,
    path: Option<String>,
    value: Option<String>,
    digest: String,
    bytes: Option<u64>,
    files: Vec<CacheDirectoryEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct TaskCacheRecord {
    version: u32,
    task_id: String,
    task_key: String,
    action_digest: String,
    input_digests: Vec<CacheInputDigest>,
    dependency_keys: Vec<(String, String)>,
    named_caches: Vec<NamedCacheBinding>,
    outputs: Vec<CachedArtifact>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamedCacheBinding {
    pub name: String,
    pub env_var: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TaskCacheSummary {
    task_id: String,
    task_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TaskCacheEvaluation {
    cacheable: bool,
    task_key: String,
    action_digest: String,
    input_digests: Vec<CacheInputDigest>,
    dependency_keys: Vec<(String, String)>,
    named_caches: Vec<NamedCacheBinding>,
    hit: bool,
    miss_reason: Option<String>,
    record: Option<TaskCacheRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheExplanation {
    pub task_id: String,
    pub cacheable: bool,
    pub impure: bool,
    pub force_cache: bool,
    pub task_key: String,
    pub action_digest: String,
    pub input_digests: Vec<CacheInputDigest>,
    pub dependency_keys: Vec<(String, String)>,
    pub named_caches: Vec<NamedCacheBinding>,
    pub hit: bool,
    pub miss_reason: Option<String>,
}

// ---------------------------------------------------------------------------
// Internal host state
// ---------------------------------------------------------------------------

struct HostState {
    next_id: u32,
    next_exec: u32,
    pending: BTreeMap<u32, PendingTarget>,
    rules: BTreeMap<(String, String), Rule>,
    products: BTreeMap<(String, String), String>,
    named_caches: BTreeMap<String, NamedCache>,
    goals: BTreeMap<String, Goal>,
    platforms: BTreeMap<String, PlatformDef>,
}

impl Default for HostState {
    fn default() -> Self {
        let mut goals = BTreeMap::new();
        for (name, policy) in [
            ("build", GoalProductPolicy::Default),
            ("test", GoalProductPolicy::Named("test".to_owned())),
            ("fmt", GoalProductPolicy::Named("fmt".to_owned())),
            ("lint", GoalProductPolicy::Named("lint".to_owned())),
            ("package", GoalProductPolicy::Named("package".to_owned())),
            ("run", GoalProductPolicy::Named("run".to_owned())),
        ] {
            goals.insert(
                name.to_owned(),
                Goal {
                    name: name.to_owned(),
                    product_policy: policy,
                },
            );
        }
        let mut platforms = BTreeMap::new();
        let local_target = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
        platforms.insert(
            "local".to_owned(),
            PlatformDef {
                name: "local".to_owned(),
                executor: Executor::Local,
                target: local_target,
            },
        );
        Self {
            next_id: 0,
            next_exec: 0,
            pending: BTreeMap::new(),
            rules: BTreeMap::new(),
            products: BTreeMap::new(),
            named_caches: BTreeMap::new(),
            goals,
            platforms,
        }
    }
}

struct PendingTarget {
    kind: String,
    fields: BTreeMap<String, String>,
    dep_ids: Vec<(u32, Option<String>)>,
}

// ---------------------------------------------------------------------------
// QuickJS module resolver / loader
// ---------------------------------------------------------------------------

struct ImpResolver {
    workspace_root: PathBuf,
    module_mounts: Arc<Mutex<Vec<ModuleMount>>>,
}

struct ImpLoader {
    workspace_root: PathBuf,
    module_mounts: Arc<Mutex<Vec<ModuleMount>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ModuleMount {
    prefix: String,
    root: PathBuf,
}

impl Resolver for ImpResolver {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
    ) -> rquickjs::Result<String> {
        if name == "imp:core" {
            return Ok(name.to_owned());
        }

        if name.starts_with("imp:") {
            let mounts = self.module_mounts.lock().unwrap();
            return Err(rquickjs::Error::new_resolving_message(
                base,
                name,
                format!(
                    "unknown built-in module '{name}' while importing from {}",
                    module_location_with_mounts(&self.workspace_root, &mounts, base)
                ),
            ));
        }

        if name.starts_with("//") {
            let mounts = self.module_mounts.lock().unwrap();
            let resolution =
                resolve_workspace_module_with_mounts(&self.workspace_root, &mounts, name).map_err(
                    |message| {
                        rquickjs::Error::new_resolving_message(
                            base,
                            name,
                            format!(
                                "{message} while importing from {}",
                                module_location_with_mounts(&self.workspace_root, &mounts, base)
                            ),
                        )
                    },
                )?;
            return Ok(resolution.name);
        }

        if name.starts_with('.') {
            let mounts = self.module_mounts.lock().unwrap();
            let importer = module_location_with_mounts(&self.workspace_root, &mounts, base);
            let message = if module_kind_with_mounts(&self.workspace_root, &mounts, base)
                == ModuleKind::Build
            {
                format!(
                    "relative import '{name}' is prohibited in BUILD.js module {importer}; use workspace-rooted //... imports or imp:* built-ins"
                )
            } else {
                format!(
                    "relative import '{name}' is unsupported in module {importer}; use workspace-rooted //... imports or imp:* built-ins"
                )
            };
            return Err(rquickjs::Error::new_resolving_message(base, name, message));
        }

        Err(rquickjs::Error::new_resolving_message(
            base,
            name,
            format!(
                "module specifier '{name}' is unsupported while importing from {}; use //... or imp:*",
                {
                    let mounts = self.module_mounts.lock().unwrap();
                    module_location_with_mounts(&self.workspace_root, &mounts, base)
                }
            ),
        ))
    }
}

impl Loader for ImpLoader {
    fn load<'js>(&mut self, ctx: &Ctx<'js>, name: &str) -> rquickjs::Result<Module<'js, Declared>> {
        if name == "imp:core" {
            return Module::declare(ctx.clone(), name, CORE_JS);
        }

        if name.starts_with("//") {
            let resolution = {
                let mounts = self.module_mounts.lock().unwrap();
                resolve_workspace_module_with_mounts(&self.workspace_root, &mounts, name)
                    .map_err(|message| rquickjs::Error::new_loading_message(name, message))?
            };
            let source = std::fs::read_to_string(&resolution.path).map_err(|e| {
                rquickjs::Error::new_loading_message(
                    name,
                    format!("read {}: {e}", resolution.path.display()),
                )
            })?;
            return Module::declare(ctx.clone(), name, source);
        }

        Err(rquickjs::Error::new_loading(name))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ModuleKind {
    BuiltIn,
    Build,
    Extension,
    Workspace,
    Unknown,
}

struct WorkspaceModuleResolution {
    name: String,
    path: PathBuf,
    kind: ModuleKind,
}

fn resolve_workspace_module(
    root: &Path,
    name: &str,
) -> std::result::Result<WorkspaceModuleResolution, String> {
    resolve_workspace_module_with_mounts(root, &[], name)
}

fn resolve_workspace_module_with_mounts(
    root: &Path,
    mounts: &[ModuleMount],
    name: &str,
) -> std::result::Result<WorkspaceModuleResolution, String> {
    let rel = name
        .strip_prefix("//")
        .ok_or_else(|| format!("workspace module '{name}' must start with //"))?;
    validate_workspace_module_path(name, rel)?;

    if let Some((mount, mounted_rel)) = matching_mount(mounts, name) {
        return resolve_workspace_module_in_root(&mount.root, name, &mounted_rel);
    }

    resolve_workspace_module_in_root(root, name, rel)
}

fn resolve_workspace_module_in_root(
    root: &Path,
    name: &str,
    rel: &str,
) -> std::result::Result<WorkspaceModuleResolution, String> {
    let mut candidates = Vec::new();

    if rel.is_empty() {
        let build_path = root.join(BUILD_FILE);
        candidates.push(build_path.clone());
        if build_path.is_file() {
            return Ok(WorkspaceModuleResolution {
                name: name.to_owned(),
                path: build_path,
                kind: ModuleKind::Build,
            });
        }
    } else {
        if rel == "BUILD" || rel.ends_with("/BUILD") {
            let build_path = root.join(format!("{rel}.js"));
            candidates.push(build_path.clone());
            if build_path.is_file() {
                return Ok(WorkspaceModuleResolution {
                    name: name.to_owned(),
                    path: build_path,
                    kind: ModuleKind::Build,
                });
            }
        }

        let js_path = root.join(format!("{rel}.js"));
        candidates.push(js_path.clone());
        if js_path.is_file() {
            return Ok(WorkspaceModuleResolution {
                name: name.to_owned(),
                path: js_path,
                kind: ModuleKind::Extension,
            });
        }

        let index_path = root.join(rel).join("index.js");
        candidates.push(index_path.clone());
        if index_path.is_file() {
            return Ok(WorkspaceModuleResolution {
                name: name.to_owned(),
                path: index_path,
                kind: ModuleKind::Extension,
            });
        }

        let build_path = root.join(rel).join(BUILD_FILE);
        candidates.push(build_path.clone());
        if build_path.is_file() {
            return Ok(WorkspaceModuleResolution {
                name: name.to_owned(),
                path: build_path,
                kind: ModuleKind::Build,
            });
        }
    }

    let tried = candidates
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "cannot resolve workspace module '{name}'; tried {tried}"
    ))
}

fn matching_mount<'a>(mounts: &'a [ModuleMount], name: &str) -> Option<(&'a ModuleMount, String)> {
    let mount = mounts
        .iter()
        .filter(|mount| name == mount.prefix || name.starts_with(&format!("{}/", mount.prefix)))
        .max_by_key(|mount| mount.prefix.len())?;
    let mounted_rel = name
        .strip_prefix(&mount.prefix)
        .unwrap_or("")
        .strip_prefix('/')
        .unwrap_or("");
    Some((mount, mounted_rel.to_owned()))
}

fn validate_workspace_module_path(name: &str, rel: &str) -> std::result::Result<(), String> {
    if rel.starts_with('/') {
        return Err(format!("workspace module '{name}' must be relative to //"));
    }

    for component in Path::new(rel).components() {
        use std::path::Component;
        match component {
            Component::Normal(_) => {}
            _ => {
                return Err(format!(
                    "workspace module '{name}' must not contain '.', '..', or platform prefixes"
                ));
            }
        }
    }
    Ok(())
}

fn module_kind_with_mounts(root: &Path, mounts: &[ModuleMount], name: &str) -> ModuleKind {
    if name == "imp:core" {
        ModuleKind::BuiltIn
    } else if name == WORKSPACE_FILE {
        ModuleKind::Workspace
    } else if name.starts_with("//") {
        resolve_workspace_module_with_mounts(root, mounts, name)
            .map(|resolution| resolution.kind)
            .unwrap_or(ModuleKind::Unknown)
    } else {
        ModuleKind::Unknown
    }
}

fn module_location_with_mounts(root: &Path, mounts: &[ModuleMount], name: &str) -> String {
    if name == "imp:core" {
        return "built-in imp:core".to_owned();
    }
    if name == WORKSPACE_FILE {
        return root.join(WORKSPACE_FILE).display().to_string();
    }
    if name.starts_with("//") {
        if let Ok(resolution) = resolve_workspace_module_with_mounts(root, mounts, name) {
            return resolution.path.display().to_string();
        }
    }
    name.to_owned()
}

// ---------------------------------------------------------------------------
// Workspace discovery
// ---------------------------------------------------------------------------

/// Find the nearest ancestor directory that contains `imp.workspace.js`.
pub fn find_workspace_root(start: &Path) -> Result<PathBuf> {
    let mut directory = start
        .canonicalize()
        .with_context(|| format!("canonicalize workspace start {}", start.display()))?;
    if directory.is_file() {
        directory = directory
            .parent()
            .ok_or_else(|| anyhow::anyhow!("workspace start has no parent"))?
            .to_owned();
    }
    loop {
        if directory.join(WORKSPACE_FILE).is_file() {
            return Ok(directory);
        }
        if !directory.pop() {
            bail!(
                "could not find {} above {}",
                WORKSPACE_FILE,
                start.display()
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Workspace loading
// ---------------------------------------------------------------------------

/// Load the workspace rooted at `root`.  Evaluates `imp.workspace.js` (for
/// rule registration) then every `BUILD.js` found below `root`, assigns
/// addresses from export names, and resolves dependency IDs to addresses.
///
/// Returns a [`LiveWorkspace`] that keeps the QuickJS runtime alive so rule
/// `exec` functions can be invoked during task execution.
pub fn load_workspace(root: &Path) -> Result<LiveWorkspace> {
    let root = root
        .canonicalize()
        .with_context(|| format!("canonicalize workspace root {}", root.display()))?;

    let state: Arc<Mutex<HostState>> = Arc::new(Mutex::new(HostState::default()));
    let module_mounts: Arc<Mutex<Vec<ModuleMount>>> = Arc::new(Mutex::new(Vec::new()));
    let exec_root: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));

    // ----- QuickJS runtime + context -----
    let rt = Runtime::new().context("create QuickJS runtime")?;
    rt.set_loader(
        ImpResolver {
            workspace_root: root.clone(),
            module_mounts: Arc::clone(&module_mounts),
        },
        ImpLoader {
            workspace_root: root.clone(),
            module_mounts: Arc::clone(&module_mounts),
        },
    );
    let ctx = JsContext::full(&rt).context("create QuickJS context")?;

    // ----- Register host globals -----
    {
        let state_clone = Arc::clone(&state);
        let mounts_clone = Arc::clone(&module_mounts);
        ctx.with(|ctx| -> rquickjs::Result<()> {
            register_globals(ctx, state_clone, root.clone(), mounts_clone, Arc::clone(&exec_root))
        })
        .map_err(|e| anyhow::anyhow!("register QuickJS globals: {e}"))?;
    }

    // ----- Evaluate imp.workspace.js if present -----
    let workspace_js = root.join(WORKSPACE_FILE);
    if workspace_js.is_file() {
        let source = std::fs::read_to_string(&workspace_js)
            .with_context(|| format!("read {}", workspace_js.display()))?;
        ctx.with(|ctx| -> Result<()> {
            let module = Module::declare(ctx.clone(), WORKSPACE_FILE, source)
                .catch(&ctx)
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            let (_, promise) = module
                .eval()
                .catch(&ctx)
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            promise
                .finish::<rquickjs::Value>()
                .catch(&ctx)
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            Ok(())
        })
        .with_context(|| format!("evaluate {}", workspace_js.display()))?;
    }

    // ----- Collect BUILD.js files -----
    let mut build_files: Vec<PathBuf> = WalkDir::new(&root)
        .into_iter()
        .filter_entry(|e| {
            !matches!(
                e.file_name().to_str(),
                Some(".git" | "target" | ".toolchain" | ".claude")
            )
        })
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && e.file_name() == BUILD_FILE)
        .map(|e| e.into_path())
        .collect();
    build_files.sort();

    if build_files.is_empty() {
        bail!("no {} files found below {}", BUILD_FILE, root.display());
    }

    // ----- Evaluate each BUILD.js and collect named exports -----
    // We use dynamic `import()` so that QuickJS handles caching: if a BUILD.js
    // was already loaded (because another BUILD.js imported it), we get the
    // cached namespace without re-evaluating.
    let mut named_exports: Vec<(String, u32)> = Vec::new(); // (address, pending_id)

    for build_file in &build_files {
        let scope = scope_for(&root, build_file)?;
        let module_name = build_module_name_for(&root, build_file, &scope)?;

        let exports = ctx
            .with(|ctx| -> Result<Vec<(String, u32)>> {
                // dynamic import → Promise<namespace>
                let promise = Module::import(&ctx, module_name.as_str())
                    .catch(&ctx)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
                let ns: Object = promise
                    .finish()
                    .catch(&ctx)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;

                let mut result = Vec::new();
                for entry in ns.own_props::<String, Value>(Filter::default()) {
                    let (key, val) = entry.map_err(|e| anyhow::anyhow!("{e}"))?;
                    if let Some(obj) = val.as_object() {
                        if let Ok(true) = obj.get::<_, bool>("__imp") {
                            if let Ok(id) = obj.get::<_, u32>("__id") {
                                result.push((key, id));
                            }
                        }
                    }
                }
                Ok(result)
            })
            .with_context(|| format!("process {}", build_file.display()))?;

        for (name, id) in exports {
            named_exports.push((format!("{scope}:{name}"), id));
        }
    }

    // ----- Resolve dep IDs to addresses -----
    let hs = state.lock().unwrap();
    let mut id_to_address: BTreeMap<u32, String> = named_exports
        .iter()
        .map(|(addr, id)| (*id, addr.clone()))
        .collect();

    let mut targets = BTreeMap::new();
    let mut visiting = BTreeSet::new();
    for (address, id) in &named_exports {
        materialize_pending_target(
            &hs,
            &mut id_to_address,
            &mut targets,
            &mut visiting,
            *id,
            address.clone(),
        )?;
    }

    Ok(LiveWorkspace {
        workspace: Workspace {
            rules: hs.rules.clone(),
            targets,
            products: hs.products.clone(),
            named_caches: hs.named_caches.clone(),
            goals: hs.goals.clone(),
            platforms: hs.platforms.clone(),
        },
        runtime: rt,
        ctx: Mutex::new(ctx),
        exec_root,
    })
}

fn materialize_pending_target(
    hs: &HostState,
    id_to_address: &mut BTreeMap<u32, String>,
    targets: &mut BTreeMap<String, Target>,
    visiting: &mut BTreeSet<u32>,
    id: u32,
    fallback_address: String,
) -> Result<String> {
    let address = id_to_address
        .entry(id)
        .or_insert_with(|| fallback_address.clone())
        .clone();
    if targets.contains_key(&address) {
        return Ok(address);
    }
    if !visiting.insert(id) {
        bail!("target dependency cycle includes pending id {id}");
    }

    let pending = hs
        .pending
        .get(&id)
        .ok_or_else(|| anyhow::anyhow!("no pending target for id {id}"))?;
    let mut deps = Vec::new();
    for (index, (dep_id, mode_str)) in pending.dep_ids.iter().enumerate() {
        let dep_address = id_to_address
            .get(dep_id)
            .cloned()
            .unwrap_or_else(|| format!("{address}__implicit{index}"));
        let dep_address =
            materialize_pending_target(hs, id_to_address, targets, visiting, *dep_id, dep_address)?;
        let mode = match mode_str.as_deref() {
            None | Some("auto") => DependencyMode::Auto,
            Some(m) => DependencyMode::Named(m.to_owned()),
        };
        deps.push(Dependency {
            address: dep_address,
            mode,
        });
    }

    visiting.remove(&id);
    targets.insert(
        address.clone(),
        Target {
            address: address.clone(),
            kind: pending.kind.clone(),
            fields: pending.fields.clone(),
            dependencies: deps,
            js_id: id,
        },
    );
    Ok(address)
}

/// Register host globals on `ctx`.
fn register_globals<'js>(
    ctx: Ctx<'js>,
    state: Arc<Mutex<HostState>>,
    workspace_root: PathBuf,
    module_mounts: Arc<Mutex<Vec<ModuleMount>>>,
    exec_root: Arc<Mutex<Option<PathBuf>>>,
) -> rquickjs::Result<()> {
    let globals = ctx.globals();

    // ------------------------------------------------------------------
    // __host_target(kind, fields, depIds, depModes) → { __imp: true, __id: N }
    // depIds: Array<number>, depModes: Array<string|null> (parallel arrays)
    // ------------------------------------------------------------------
    let state_t = Arc::clone(&state);
    let host_target = Function::new(
        ctx.clone(),
        move |ctx: Ctx<'js>,
              kind: String,
              fields: Object<'js>,
              dep_ids: Array<'js>,
              dep_modes: Array<'js>|
              -> rquickjs::Result<Object<'js>> {
            let mut hs = state_t.lock().unwrap();
            let id = hs.next_id;
            hs.next_id += 1;

            // Extract string-valued fields from the JS object.
            let mut field_map: BTreeMap<String, String> = BTreeMap::new();
            for entry in fields.own_props::<String, Value>(Filter::default()) {
                let (k, v) = entry?;
                let s: String = v.get()?;
                field_map.insert(k, s);
            }

            // Extract (dep_id, mode) pairs from the two parallel arrays.
            let len = dep_ids.len();
            let mut dep_id_list: Vec<(u32, Option<String>)> = Vec::with_capacity(len);
            for i in 0..len {
                let dep_id: u32 = dep_ids.get(i)?;
                let mode_val: Value = dep_modes.get(i)?;
                let mode = if mode_val.is_null() || mode_val.is_undefined() {
                    None
                } else {
                    Some(mode_val.get::<String>()?)
                };
                dep_id_list.push((dep_id, mode));
            }

            hs.pending.insert(
                id,
                PendingTarget {
                    kind,
                    fields: field_map,
                    dep_ids: dep_id_list,
                },
            );

            // Return handle object.
            let handle = Object::new(ctx)?;
            handle.set("__imp", true)?;
            handle.set("__id", id)?;
            Ok(handle)
        },
    )?;
    globals.set("__host_target", host_target)?;

    // ------------------------------------------------------------------
    // __host_rule(kind, product, action, requiresOwnSources, depProduct)
    // ------------------------------------------------------------------
    let state_r = Arc::clone(&state);
    let host_rule = Function::new(
        ctx.clone(),
        move |ctx: Ctx<'js>,
              kind: String,
              product: String,
              action_value: Value<'js>,
              requires_own_sources: bool,
              dep_prod_val: Value<'js>,
              exec_val: Value<'js>|
              -> rquickjs::Result<()> {
            let action = parse_rule_action(action_value)?;
            let dependency_product = if dep_prod_val.is_null() || dep_prod_val.is_undefined() {
                DependencyProduct::None
            } else {
                let s: String = dep_prod_val.get()?;
                if s == "default" {
                    DependencyProduct::Default
                } else {
                    DependencyProduct::Named(s)
                }
            };

            let exec_fn = if exec_val.is_null() || exec_val.is_undefined() {
                None
            } else {
                let name = {
                    let mut hs = state_r.lock().unwrap();
                    let n = format!("__imp_exec_{}", hs.next_exec);
                    hs.next_exec += 1;
                    n
                };
                ctx.globals().set(name.as_str(), exec_val)?;
                Some(name)
            };

            let key = (kind.clone(), product.clone());
            let mut hs = state_r.lock().unwrap();
            if !hs.rules.contains_key(&key) {
                hs.rules.insert(
                    key,
                    Rule {
                        target_kind: kind,
                        product,
                        action,
                        requires_own_sources,
                        dependency_product,
                        exec_fn,
                    },
                );
            }
            Ok(())
        },
    )?;
    globals.set("__host_rule", host_rule)?;

    // ------------------------------------------------------------------
    // __host_product(kind, name, fn)
    // ------------------------------------------------------------------
    let state_p = Arc::clone(&state);
    let host_product = Function::new(
        ctx.clone(),
        move |ctx: Ctx<'js>, kind: String, name: String, fn_val: Value<'js>|
              -> rquickjs::Result<()> {
            let exec_name = {
                let mut hs = state_p.lock().unwrap();
                let n = format!("__imp_exec_{}", hs.next_exec);
                hs.next_exec += 1;
                n
            };
            ctx.globals().set(exec_name.as_str(), fn_val)?;
            state_p
                .lock()
                .unwrap()
                .products
                .insert((kind, name), exec_name);
            Ok(())
        },
    )?;
    globals.set("__host_product", host_product)?;

    // ------------------------------------------------------------------
    // __host_named_cache(name)
    // ------------------------------------------------------------------
    let state_c = Arc::clone(&state);
    let host_named_cache =
        Function::new(ctx.clone(), move |name: String| -> rquickjs::Result<()> {
            let cache = named_cache_from_name(&name)?;
            let mut hs = state_c.lock().unwrap();
            if let Some(existing) = hs.named_caches.get(&cache.name) {
                if existing != &cache {
                    return Err(action_spec_error(format!(
                        "named cache '{}' was declared with conflicting metadata",
                        cache.name
                    )));
                }
                return Ok(());
            }
            if let Some(existing) = hs
                .named_caches
                .values()
                .find(|existing| existing.env_var == cache.env_var)
            {
                return Err(action_spec_error(format!(
                    "named cache '{}' maps to env var {} already used by '{}'",
                    cache.name, cache.env_var, existing.name
                )));
            }
            hs.named_caches.insert(cache.name.clone(), cache);
            Ok(())
        })?;
    globals.set("__host_named_cache", host_named_cache)?;

    // ------------------------------------------------------------------
    // __host_goal(name, productPolicy)
    // ------------------------------------------------------------------
    let state_g = Arc::clone(&state);
    let host_goal = Function::new(
        ctx.clone(),
        move |name: String, policy_val: Value| -> rquickjs::Result<()> {
            if name.is_empty() {
                return Err(action_spec_error("goal name must not be empty".to_owned()));
            }
            let product_policy = {
                let s: String = policy_val.get().map_err(|_| {
                    action_spec_error("goal productPolicy must be a string".to_owned())
                })?;
                if s == "default" {
                    GoalProductPolicy::Default
                } else {
                    GoalProductPolicy::Named(s)
                }
            };
            let mut hs = state_g.lock().unwrap();
            if !hs.goals.contains_key(&name) {
                hs.goals.insert(
                    name.clone(),
                    Goal {
                        name,
                        product_policy,
                    },
                );
            }
            Ok(())
        },
    )?;
    globals.set("__host_goal", host_goal)?;

    // ------------------------------------------------------------------
    // __host_platform(name, executor, target)
    // ------------------------------------------------------------------
    let state_p = Arc::clone(&state);
    let host_platform = Function::new(
        ctx.clone(),
        move |name: String, executor_str: String, target: String| -> rquickjs::Result<()> {
            if name.is_empty() {
                return Err(action_spec_error(
                    "platform name must not be empty".to_owned(),
                ));
            }
            let executor = Executor::from_str(&executor_str).ok_or_else(|| {
                action_spec_error(format!(
                    "unknown executor '{executor_str}'; known: local, wsl, container"
                ))
            })?;
            let mut hs = state_p.lock().unwrap();
            if !hs.platforms.contains_key(&name) {
                hs.platforms.insert(
                    name.clone(),
                    PlatformDef {
                        name,
                        executor,
                        target,
                    },
                );
            }
            Ok(())
        },
    )?;
    globals.set("__host_platform", host_platform)?;

    // ------------------------------------------------------------------
    // __host_download(url) → path string
    // ------------------------------------------------------------------
    let host_download = Function::new(ctx.clone(), |url: String| -> rquickjs::Result<String> {
        let path = toolchain::host_download(&url)
            .map_err(|e| rquickjs::Error::new_loading_message("download", format!("{e:#}")))?;
        Ok(path.to_string_lossy().into_owned())
    })?;
    globals.set("__host_download", host_download)?;

    // ------------------------------------------------------------------
    // __host_extract(archive, dest, format, strip_components)
    // ------------------------------------------------------------------
    let host_extract = Function::new(
        ctx.clone(),
        |archive: String, dest: String, format: String, strip: u32| -> rquickjs::Result<()> {
            toolchain::host_extract(Path::new(&archive), Path::new(&dest), &format, strip)
                .map_err(|e| rquickjs::Error::new_loading_message("extract", format!("{e:#}")))?;
            Ok(())
        },
    )?;
    globals.set("__host_extract", host_extract)?;

    // ------------------------------------------------------------------
    // __host_platform() → JSON string { "os": "...", "arch": "..." }
    // ------------------------------------------------------------------
    let host_platform_fn = Function::new(ctx.clone(), || -> rquickjs::Result<String> {
        let (os, arch) = toolchain::host_detect_platform()
            .map_err(|e| rquickjs::Error::new_loading_message("platform", format!("{e:#}")))?;
        Ok(format!(r#"{{"os":"{os}","arch":"{arch}"}}"#))
    })?;
    globals.set("__host_platform_info", host_platform_fn)?;

    // ------------------------------------------------------------------
    // __host_sha256(path) → hex string
    // ------------------------------------------------------------------
    let host_sha256 = Function::new(ctx.clone(), |path: String| -> rquickjs::Result<String> {
        toolchain::host_sha256(Path::new(&path))
            .map_err(|e| rquickjs::Error::new_loading_message("sha256", format!("{e:#}")))
    })?;
    globals.set("__host_sha256", host_sha256)?;

    // ------------------------------------------------------------------
    // __host_cache_put(name, key, source)
    // __host_cache_get(name, key) → path | null
    // __host_cache_has(name, key) → bool
    // ------------------------------------------------------------------
    let wc = workspace_root.clone();
    let host_cache_put = Function::new(
        ctx.clone(),
        move |name: String, key: String, source: String| -> rquickjs::Result<()> {
            let target = named_cache_key_path(&wc, &name, &key)
                .map_err(|e| rquickjs::Error::new_loading_message("cache", format!("{e:#}")))?;
            std::fs::create_dir_all(&target).map_err(|e| {
                rquickjs::Error::new_loading_message("cache", format!("create {target:?}: {e}"))
            })?;
            let src = Path::new(&source);
            if src.is_dir() {
                copy_dir_into(src, &target).map_err(|e| {
                    rquickjs::Error::new_loading_message("cache", format!("copy dir {source}: {e}"))
                })?;
            } else {
                let file_name = src.file_name().ok_or_else(|| {
                    rquickjs::Error::new_loading_message(
                        "cache",
                        "source has no filename".to_owned(),
                    )
                })?;
                std::fs::copy(src, target.join(file_name)).map_err(|e| {
                    rquickjs::Error::new_loading_message("cache", format!("copy {source}: {e}"))
                })?;
            }
            Ok(())
        },
    )?;
    globals.set("__host_cache_put", host_cache_put)?;

    let wc = workspace_root.clone();
    let host_cache_get = Function::new(
        ctx.clone(),
        move |name: String, key: String| -> rquickjs::Result<Option<String>> {
            match named_cache_key_path(&wc, &name, &key) {
                Ok(p) if p.is_dir() => Ok(Some(p.to_string_lossy().into_owned())),
                _ => Ok(None),
            }
        },
    )?;
    globals.set("__host_cache_get", host_cache_get)?;

    let wc = workspace_root.clone();
    let host_cache_has = Function::new(
        ctx.clone(),
        move |name: String, key: String| -> rquickjs::Result<bool> {
            Ok(named_cache_key_path(&wc, &name, &key)
                .map(|p| p.is_dir())
                .unwrap_or(false))
        },
    )?;
    globals.set("__host_cache_has", host_cache_has)?;

    // ------------------------------------------------------------------
    // __host_workspace_files(root, suffix) → JSON string ["//path/module"]
    // ------------------------------------------------------------------
    let wc = workspace_root.clone();
    let host_workspace_files = Function::new(
        ctx.clone(),
        move |root: String, suffix: String| -> rquickjs::Result<String> {
            workspace_files(&wc, &root, &suffix)
                .and_then(|files| serde_json::to_string(&files).context("encode workspace files"))
                .map_err(|e| {
                    rquickjs::Error::new_loading_message("workspaceFiles", format!("{e:#}"))
                })
        },
    )?;
    globals.set("__host_workspace_files", host_workspace_files)?;

    // ------------------------------------------------------------------
    // __host_workspace_source_files(root, includeJson, excludeJson)
    // ------------------------------------------------------------------
    let wc = workspace_root.clone();
    let host_workspace_source_files = Function::new(
        ctx.clone(),
        move |root: String,
              include_json: String,
              exclude_json: String|
              -> rquickjs::Result<String> {
            let include: Vec<String> = serde_json::from_str(&include_json).map_err(|e| {
                rquickjs::Error::new_loading_message(
                    "workspaceSourceFiles",
                    format!("parse include regexes: {e}"),
                )
            })?;
            let exclude: Vec<String> = serde_json::from_str(&exclude_json).map_err(|e| {
                rquickjs::Error::new_loading_message(
                    "workspaceSourceFiles",
                    format!("parse exclude regexes: {e}"),
                )
            })?;
            workspace_source_files(&wc, &root, &include, &exclude)
                .and_then(|files| serde_json::to_string(&files).context("encode source files"))
                .map_err(|e| {
                    rquickjs::Error::new_loading_message("workspaceSourceFiles", format!("{e:#}"))
                })
        },
    )?;
    globals.set("__host_workspace_source_files", host_workspace_source_files)?;

    // ------------------------------------------------------------------
    // __host_workspace_source_entries(root, includeJson, excludeJson)
    // ------------------------------------------------------------------
    let wc = workspace_root.clone();
    let host_workspace_source_entries = Function::new(
        ctx.clone(),
        move |root: String,
              include_json: String,
              exclude_json: String|
              -> rquickjs::Result<String> {
            let include: Vec<String> = serde_json::from_str(&include_json).map_err(|e| {
                rquickjs::Error::new_loading_message(
                    "workspaceSourceEntries",
                    format!("parse include regexes: {e}"),
                )
            })?;
            let exclude: Vec<String> = serde_json::from_str(&exclude_json).map_err(|e| {
                rquickjs::Error::new_loading_message(
                    "workspaceSourceEntries",
                    format!("parse exclude regexes: {e}"),
                )
            })?;
            workspace_source_entries(&wc, &root, &include, &exclude)
                .and_then(|entries| serde_json::to_string(&entries).context("encode source entries"))
                .map_err(|e| {
                    rquickjs::Error::new_loading_message("workspaceSourceEntries", format!("{e:#}"))
                })
        },
    )?;
    globals.set("__host_workspace_source_entries", host_workspace_source_entries)?;

    // ------------------------------------------------------------------
    // __host_workspace_mount(prefix, path)
    // ------------------------------------------------------------------
    let wc = workspace_root.clone();
    let host_workspace_mount = Function::new(
        ctx.clone(),
        move |prefix: String, path: String| -> rquickjs::Result<()> {
            let mount = module_mount_from_args(&wc, &prefix, &path)?;
            let mut mounts = module_mounts.lock().unwrap();
            if let Some(existing) = mounts
                .iter()
                .find(|existing| existing.prefix == mount.prefix)
            {
                if existing.root == mount.root {
                    return Ok(());
                }
                return Err(rquickjs::Error::new_loading_message(
                    "workspaceMount",
                    format!(
                        "module prefix '{}' is already mounted at {}",
                        existing.prefix,
                        existing.root.display()
                    ),
                ));
            }
            mounts.push(mount);
            Ok(())
        },
    )?;
    globals.set("__host_workspace_mount", host_workspace_mount)?;

    // ------------------------------------------------------------------
    // __host_hydrate_target(id) → JSON { kind, fields, deps: [{handle, mode}] }
    // ------------------------------------------------------------------
    let state_h = Arc::clone(&state);
    let host_hydrate_target = Function::new(
        ctx.clone(),
        move |id: u32| -> rquickjs::Result<String> {
            let hs = state_h.lock().unwrap();
            let pending = hs.pending.get(&id).ok_or_else(|| {
                rquickjs::Error::new_loading_message(
                    "hydrateTarget",
                    format!("no pending target for id {id}"),
                )
            })?;
            let deps: Vec<serde_json::Value> = pending
                .dep_ids
                .iter()
                .map(|(dep_id, mode)| {
                    serde_json::json!({
                        "handle": { "__imp": true, "__id": dep_id },
                        "mode": mode,
                    })
                })
                .collect();
            let json = serde_json::json!({
                "kind": pending.kind,
                "fields": pending.fields,
                "deps": deps,
            });
            serde_json::to_string(&json).map_err(|e| {
                rquickjs::Error::new_loading_message("hydrateTarget", e.to_string())
            })
        },
    )?;
    globals.set("__host_hydrate_target", host_hydrate_target)?;

    // ------------------------------------------------------------------
    // __host_cas_tree_store(entriesJson) → digest
    // __host_cas_tree_get(digest) → entriesJson
    // __host_cas_tree_merge(digestsJson) → digest
    // ------------------------------------------------------------------
    let host_cas_tree_store = Function::new(
        ctx.clone(),
        move |entries_json: String| -> rquickjs::Result<String> {
            let entries: Vec<SourceFileEntry> =
                serde_json::from_str(&entries_json).map_err(|e| {
                    rquickjs::Error::new_loading_message("casTreeStore", e.to_string())
                })?;
            cas_tree_store(&entries).map_err(|e| {
                rquickjs::Error::new_loading_message("casTreeStore", format!("{e:#}"))
            })
        },
    )?;
    globals.set("__host_cas_tree_store", host_cas_tree_store)?;

    let host_cas_tree_get = Function::new(
        ctx.clone(),
        move |digest: String| -> rquickjs::Result<String> {
            let entries = cas_tree_get(&digest).map_err(|e| {
                rquickjs::Error::new_loading_message("casTreeGet", format!("{e:#}"))
            })?;
            serde_json::to_string(&entries).map_err(|e| {
                rquickjs::Error::new_loading_message("casTreeGet", e.to_string())
            })
        },
    )?;
    globals.set("__host_cas_tree_get", host_cas_tree_get)?;

    let host_cas_tree_merge = Function::new(
        ctx.clone(),
        move |digests_json: String| -> rquickjs::Result<String> {
            let digests: Vec<String> =
                serde_json::from_str(&digests_json).map_err(|e| {
                    rquickjs::Error::new_loading_message("casTreeMerge", e.to_string())
                })?;
            let refs: Vec<&str> = digests.iter().map(|s| s.as_str()).collect();
            cas_tree_merge(&refs).map_err(|e| {
                rquickjs::Error::new_loading_message("casTreeMerge", format!("{e:#}"))
            })
        },
    )?;
    globals.set("__host_cas_tree_merge", host_cas_tree_merge)?;

    // ------------------------------------------------------------------
    // Tracked runtime APIs (Phase 3)
    // ------------------------------------------------------------------

    // __host_glob(root, includeJson, excludeJson) → JSON string[]
    // Same logic as __host_workspace_source_files but accessible from memos.
    let wc = workspace_root.clone();
    let host_glob = Function::new(
        ctx.clone(),
        move |root: String, include_json: String, exclude_json: String| -> rquickjs::Result<String> {
            let include: Vec<String> = serde_json::from_str(&include_json)
                .map_err(|e| rquickjs::Error::new_loading_message("glob", e.to_string()))?;
            let exclude: Vec<String> = serde_json::from_str(&exclude_json)
                .map_err(|e| rquickjs::Error::new_loading_message("glob", e.to_string()))?;
            workspace_source_files(&wc, &root, &include, &exclude)
                .and_then(|f| serde_json::to_string(&f).context("encode glob results"))
                .map_err(|e| rquickjs::Error::new_loading_message("glob", format!("{e:#}")))
        },
    )?;
    globals.set("__host_glob", host_glob)?;

    // __host_env(name) → string | null
    let host_env = Function::new(
        ctx.clone(),
        move |name: String| -> rquickjs::Result<Option<String>> {
            Ok(std::env::var(&name).ok())
        },
    )?;
    globals.set("__host_env", host_env)?;

    // __host_which(name) → string | null
    let host_which = Function::new(
        ctx.clone(),
        move |name: String| -> rquickjs::Result<Option<String>> {
            Ok(which_executable(&name))
        },
    )?;
    globals.set("__host_which", host_which)?;

    // __host_read_file(path) → string
    let exec_root_rf = Arc::clone(&exec_root);
    let wc_rf = workspace_root.clone();
    let host_read_file = Function::new(
        ctx.clone(),
        move |path: String| -> rquickjs::Result<String> {
            let p = std::path::Path::new(&path);
            let resolved = if p.is_absolute() {
                p.to_owned()
            } else {
                let root = exec_root_rf.lock().unwrap().clone().unwrap_or_else(|| wc_rf.clone());
                root.join(p)
            };
            std::fs::read_to_string(&resolved).map_err(|e| {
                rquickjs::Error::new_loading_message("read_file", format!("{}: {e}", resolved.display()))
            })
        },
    )?;
    globals.set("__host_read_file", host_read_file)?;

    // __host_run(opts) → { stdout, stderr, exitCode }
    // Delegates to exec_run_inner with the active exec workspace root.
    let exec_root_run = Arc::clone(&exec_root);
    let host_run = Function::new(
        ctx.clone(),
        move |ctx: Ctx<'js>, opts: Object<'js>| -> rquickjs::Result<Object<'js>> {
            let root = exec_root_run.lock().unwrap().clone().ok_or_else(|| {
                rquickjs::Error::new_loading_message("run", "run() called outside of execution context")
            })?;
            let run_opts = parse_exec_run_opts(opts)?;
            let result = exec_run_inner(&root, run_opts)
                .map_err(|e| rquickjs::Error::new_loading_message("run", format!("{e:#}")))?;
            let obj = Object::new(ctx)?;
            obj.set("stdout", result.stdout)?;
            obj.set("stderr", result.stderr)?;
            obj.set("exitCode", result.exit_code)?;
            Ok(obj)
        },
    )?;
    globals.set("__host_run", host_run)?;

    // __host_workspace_mutation(opts) → { stdout, stderr, exitCode }
    // Runs a command directly in the workspace root (not a sandbox). Always impure.
    let exec_root_wm = Arc::clone(&exec_root);
    let host_workspace_mutation = Function::new(
        ctx.clone(),
        move |ctx: Ctx<'js>, opts: Object<'js>| -> rquickjs::Result<Object<'js>> {
            let root = exec_root_wm.lock().unwrap().clone().ok_or_else(|| {
                rquickjs::Error::new_loading_message(
                    "workspace_mutation",
                    "workspace_mutation() called outside of execution context",
                )
            })?;
            let argv: Vec<String> = opts.get("argv")?;
            let display: Option<String> = opts.get("display")?;
            let display = display.unwrap_or_else(|| argv.join(" "));
            let (program, args) = argv.split_first().ok_or_else(|| {
                rquickjs::Error::new_loading_message("workspace_mutation", "argv must not be empty")
            })?;
            let output = std::process::Command::new(program)
                .args(args)
                .current_dir(&root)
                .output()
                .map_err(|e| {
                    rquickjs::Error::new_loading_message(
                        "workspace_mutation",
                        format!("spawn {display}: {e}"),
                    )
                })?;
            let exit_code = output.status.code().unwrap_or(-1);
            let obj = Object::new(ctx)?;
            obj.set("stdout", String::from_utf8_lossy(&output.stdout).to_string())?;
            obj.set("stderr", String::from_utf8_lossy(&output.stderr).to_string())?;
            obj.set("exitCode", exit_code)?;
            Ok(obj)
        },
    )?;
    globals.set("__host_workspace_mutation", host_workspace_mutation)?;

    Ok(())
}

fn which_executable(name: &str) -> Option<String> {
    let path_var = std::env::var("PATH").ok()?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
        #[cfg(windows)]
        {
            let with_exe = dir.join(format!("{name}.exe"));
            if with_exe.is_file() {
                return Some(with_exe.to_string_lossy().into_owned());
            }
        }
    }
    None
}

fn parse_exec_run_opts<'js>(opts: Object<'js>) -> rquickjs::Result<ExecRunOpts> {
    let argv: Vec<String> = opts.get("argv")?;
    let display: Option<String> = opts.get("display")?;
    let display = display.unwrap_or_else(|| argv.join(" "));
    let env_obj: Option<Object<'js>> = opts.get("env")?;
    let mut env = BTreeMap::new();
    if let Some(e) = env_obj {
        for entry in e.own_props::<String, String>(Filter::default()) {
            let (k, v) = entry?;
            env.insert(k, v);
        }
    }
    let inputs = parse_io_specs(opts.get::<_, Option<Vec<Object>>>("inputs")?.unwrap_or_default())?;
    let outputs = parse_io_specs(opts.get::<_, Option<Vec<Object>>>("outputs")?.unwrap_or_default())?;
    let tools = parse_tool_specs(opts.get::<_, Option<Vec<Object>>>("tools")?.unwrap_or_default())?;
    let impure = opts.get::<_, Option<bool>>("impure")?.unwrap_or(false);
    let force_cache = opts.get::<_, Option<bool>>("forceCache")?.unwrap_or(false);
    Ok(ExecRunOpts { argv, display, env, inputs, outputs, tools, impure, force_cache })
}

fn module_mount_from_args(
    workspace_root: &Path,
    prefix: &str,
    path: &str,
) -> rquickjs::Result<ModuleMount> {
    let prefix = normalize_mount_prefix(prefix)
        .map_err(|message| rquickjs::Error::new_loading_message("workspaceMount", message))?;
    let source = Path::new(path);
    let source = if source.is_absolute() {
        source.to_owned()
    } else {
        workspace_root.join(source)
    };
    let root = source.canonicalize().map_err(|e| {
        rquickjs::Error::new_loading_message(
            "workspaceMount",
            format!("canonicalize mount path {}: {e}", source.display()),
        )
    })?;
    if !root.is_dir() {
        return Err(rquickjs::Error::new_loading_message(
            "workspaceMount",
            format!("mount path {} is not a directory", root.display()),
        ));
    }
    Ok(ModuleMount { prefix, root })
}

fn normalize_mount_prefix(prefix: &str) -> std::result::Result<String, String> {
    if !prefix.starts_with("//") {
        return Err(format!(
            "workspace mount prefix '{prefix}' must start with //"
        ));
    }
    let normalized = prefix.trim_end_matches('/');
    if normalized.len() <= 2 {
        return Err("workspace mount prefix must name a non-root prefix".to_owned());
    }
    let rel = normalized
        .strip_prefix("//")
        .expect("checked prefix starts with //");
    validate_workspace_module_path(normalized, rel)?;
    Ok(normalized.to_owned())
}

fn workspace_files(workspace_root: &Path, root: &str, suffix: &str) -> Result<Vec<String>> {
    let rel = root
        .strip_prefix("//")
        .ok_or_else(|| anyhow::anyhow!("workspaceFiles root '{root}' must start with //"))?;
    validate_workspace_module_path(root, rel).map_err(anyhow::Error::msg)?;

    let directory = workspace_root.join(rel);
    if !directory.is_dir() {
        bail!(
            "workspaceFiles root '{}' is not a directory",
            directory.display()
        );
    }

    let mut files = Vec::new();
    for entry in WalkDir::new(&directory)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
    {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.ends_with(".js") || !name.ends_with(suffix) {
            continue;
        }
        let relative = path
            .strip_prefix(workspace_root)
            .with_context(|| format!("relativize {}", path.display()))?;
        let mut module = relative.to_string_lossy().replace('\\', "/");
        module.truncate(module.len() - ".js".len());
        files.push(format!("//{module}"));
    }
    files.sort();
    Ok(files)
}

fn workspace_source_files(
    workspace_root: &Path,
    root: &str,
    include: &[String],
    exclude: &[String],
) -> Result<Vec<String>> {
    matching_workspace_source_paths(workspace_root, root, include, exclude)
}

fn workspace_source_entries(
    workspace_root: &Path,
    root: &str,
    include: &[String],
    exclude: &[String],
) -> Result<Vec<SourceFileEntry>> {
    let paths = matching_workspace_source_paths(workspace_root, root, include, exclude)?;
    paths
        .into_iter()
        .map(|path| {
            let source = workspace_root.join(artifact_relative_path(&path)?);
            let (digest, bytes) = store_file_blob(&source, "source")?;
            Ok(SourceFileEntry {
                path,
                digest,
                bytes,
            })
        })
        .collect()
}

fn matching_workspace_source_paths(
    workspace_root: &Path,
    root: &str,
    include: &[String],
    exclude: &[String],
) -> Result<Vec<String>> {
    if include.is_empty() {
        bail!("workspaceSourceFiles include must not be empty");
    }
    let include = compile_regexes("include", include)?;
    let exclude = compile_regexes("exclude", exclude)?;
    let directory = workspace_root.join(workspace_relative_directory(root)?);
    if !directory.is_dir() {
        bail!(
            "workspaceSourceFiles root '{}' is not a directory",
            directory.display()
        );
    }

    let mut files = Vec::new();
    for entry in WalkDir::new(&directory)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
    {
        let relative = entry
            .path()
            .strip_prefix(workspace_root)
            .with_context(|| format!("relativize {}", entry.path().display()))?;
        let relative = relative
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        if include.iter().any(|regex| regex.is_match(&relative))
            && !exclude.iter().any(|regex| regex.is_match(&relative))
        {
            files.push(relative);
        }
    }
    files.sort();
    Ok(files)
}

fn compile_regexes(label: &str, patterns: &[String]) -> Result<Vec<Regex>> {
    patterns
        .iter()
        .map(|pattern| {
            Regex::new(pattern).with_context(|| format!("compile {label} source regex {pattern:?}"))
        })
        .collect()
}

fn workspace_relative_directory(path: &str) -> Result<PathBuf> {
    if path.is_empty() || path == "." {
        return Ok(PathBuf::new());
    }
    artifact_relative_path(path)
}

fn named_cache_key_path(workspace_root: &Path, name: &str, key: &str) -> Result<PathBuf> {
    let root = cache_root()?
        .join("named")
        .join(workspace_cache_id(workspace_root))
        .join(name)
        .join(key);
    Ok(root)
}

/// Recursively copy the contents of `src` into `dst` (which already exists as a
/// directory). Unlike `std::fs::rename` this works across mount boundaries.
fn copy_dir_into(src: &Path, dst: &Path) -> Result<()> {
    for entry in std::fs::read_dir(src).with_context(|| format!("read {}", src.display()))? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            std::fs::create_dir_all(&target)?;
            copy_dir_into(&entry.path(), &target)?;
        } else {
            std::fs::copy(&entry.path(), &target).with_context(|| {
                format!("copy {} -> {}", entry.path().display(), target.display())
            })?;
        }
    }
    Ok(())
}

fn named_cache_from_name(name: &str) -> rquickjs::Result<NamedCache> {
    if name.is_empty() {
        return Err(action_spec_error(
            "named cache name must not be empty".to_owned(),
        ));
    }
    if !name
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '-' | '_'))
    {
        return Err(action_spec_error(format!(
            "named cache '{name}' must contain only lowercase ASCII letters, digits, '-' or '_'"
        )));
    }
    let env_suffix = name.replace('-', "_").to_ascii_uppercase();
    Ok(NamedCache {
        name: name.to_owned(),
        env_var: format!("IMP_NAMED_CACHE_{env_suffix}"),
    })
}

fn parse_rule_action<'js>(action_value: Value<'js>) -> rquickjs::Result<ActionSpec> {
    if action_value.is_string() {
        return Ok(ActionSpec::legacy(action_value.get()?));
    }

    if !action_value.is_object() || action_value.is_array() {
        return Err(action_spec_error(format!(
            "rule action must be a string or object, got {}",
            action_value.type_name()
        )));
    }

    let action = action_value
        .as_object()
        .expect("checked object above")
        .clone();
    let argv = optional_string_array(&action, "argv", "action")?.unwrap_or_default();
    let cwd = optional_string(&action, "cwd", "action")?;
    let env = optional_string_map(&action, "env", "action")?.unwrap_or_default();
    let platform = optional_string(&action, "platform", "action")?;
    let inputs = optional_artifact_array(&action, "inputs")?.unwrap_or_default();
    let outputs = optional_artifact_array(&action, "outputs")?.unwrap_or_default();
    let display = optional_string(&action, "display", "action")?.unwrap_or_else(|| argv.join(" "));

    let impure = optional_bool(&action, "impure", "action")?.unwrap_or(false);
    let force_cache = optional_bool(&action, "force_cache", "action")?.unwrap_or(false);

    Ok(ActionSpec {
        argv,
        cwd,
        env,
        platform,
        inputs,
        outputs,
        display,
        impure,
        force_cache,
    })
}

fn optional_bool<'js>(
    object: &Object<'js>,
    key: &'static str,
    context: &'static str,
) -> rquickjs::Result<Option<bool>> {
    if !object.contains_key(key)? {
        return Ok(None);
    }
    let value: Value = object.get(key)?;
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    if !value.is_bool() {
        return Err(action_spec_error(format!(
            "{context}.{key} must be a boolean, got {}",
            value.type_name()
        )));
    }
    value.get().map(Some)
}

fn optional_string<'js>(
    object: &Object<'js>,
    key: &'static str,
    context: &'static str,
) -> rquickjs::Result<Option<String>> {
    if !object.contains_key(key)? {
        return Ok(None);
    }
    let value: Value = object.get(key)?;
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    if !value.is_string() {
        return Err(action_spec_error(format!(
            "{context}.{key} must be a string, got {}",
            value.type_name()
        )));
    }
    value.get().map(Some)
}

fn optional_string_array<'js>(
    object: &Object<'js>,
    key: &'static str,
    context: &'static str,
) -> rquickjs::Result<Option<Vec<String>>> {
    if !object.contains_key(key)? {
        return Ok(None);
    }
    let value: Value = object.get(key)?;
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    if !value.is_array() {
        return Err(action_spec_error(format!(
            "{context}.{key} must be an array of strings, got {}",
            value.type_name()
        )));
    }
    let array: Array = value.get()?;
    let mut strings = Vec::with_capacity(array.len());
    for i in 0..array.len() {
        let item: Value = array.get(i)?;
        if !item.is_string() {
            return Err(action_spec_error(format!(
                "{context}.{key}[{i}] must be a string, got {}",
                item.type_name()
            )));
        }
        strings.push(item.get()?);
    }
    Ok(Some(strings))
}

fn optional_string_map<'js>(
    object: &Object<'js>,
    key: &'static str,
    context: &'static str,
) -> rquickjs::Result<Option<BTreeMap<String, String>>> {
    if !object.contains_key(key)? {
        return Ok(None);
    }
    let value: Value = object.get(key)?;
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    if !value.is_object() || value.is_array() {
        return Err(action_spec_error(format!(
            "{context}.{key} must be an object with string values, got {}",
            value.type_name()
        )));
    }
    let object = value.as_object().expect("checked object above");
    let mut strings = BTreeMap::new();
    for entry in object.own_props::<String, Value>(Filter::default()) {
        let (field, value) = entry?;
        if !value.is_string() {
            return Err(action_spec_error(format!(
                "{context}.{key}.{field} must be a string, got {}",
                value.type_name()
            )));
        }
        strings.insert(field, value.get()?);
    }
    Ok(Some(strings))
}

fn optional_artifact_array<'js>(
    action: &Object<'js>,
    key: &'static str,
) -> rquickjs::Result<Option<Vec<ArtifactSpec>>> {
    if !action.contains_key(key)? {
        return Ok(None);
    }
    let value: Value = action.get(key)?;
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    if !value.is_array() {
        return Err(action_spec_error(format!(
            "action.{key} must be an array of artifact specs, got {}",
            value.type_name()
        )));
    }
    let array: Array = value.get()?;
    let mut artifacts = Vec::with_capacity(array.len());
    for i in 0..array.len() {
        let item: Value = array.get(i)?;
        if !item.is_object() || item.is_array() {
            return Err(action_spec_error(format!(
                "action.{key}[{i}] must be an object, got {}",
                item.type_name()
            )));
        }
        let object = item.as_object().expect("checked object above");
        let kind = optional_string(object, "kind", "artifact")?
            .ok_or_else(|| action_spec_error(format!("action.{key}[{i}].kind is required")))?;
        if !matches!(kind.as_str(), "file" | "directory" | "manifest" | "value") {
            return Err(action_spec_error(format!(
                "action.{key}[{i}].kind must be file, directory, manifest, or value"
            )));
        }
        artifacts.push(ArtifactSpec {
            id: optional_string(object, "id", "artifact")?,
            kind,
            path: optional_string(object, "path", "artifact")?,
            value: optional_string(object, "value", "artifact")?,
        });
    }
    Ok(Some(artifacts))
}

fn action_spec_error(message: String) -> rquickjs::Error {
    rquickjs::Error::new_from_js_message("value", "ActionSpec", message)
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

pub fn plan(workspace: &Workspace, goal: &str, selectors: &[String]) -> Result<Plan> {
    let goal_def = workspace.goals.get(goal).ok_or_else(|| {
        let known: Vec<_> = workspace.goals.keys().map(String::as_str).collect();
        anyhow::anyhow!(
            "unknown goal '{goal}'; registered goals: {}",
            known.join(", ")
        )
    })?;

    let roots = select_roots(workspace, goal_def, selectors)?;
    let mut planner = Planner {
        workspace,
        tasks: BTreeMap::new(),
    };
    let mut root_tasks = Vec::new();
    for (target, product) in &roots {
        root_tasks.push(planner.request(&target.address, product)?);
    }

    let tasks: Vec<Task> = planner.tasks.into_values().collect();

    // Validate that every task's platform constraint references a registered platform.
    for task in &tasks {
        if let Some(p) = task.action.platform.as_deref() {
            if !workspace.platforms.contains_key(p) {
                let known: Vec<_> = workspace.platforms.keys().map(String::as_str).collect();
                bail!(
                    "{}: unknown platform '{p}'; registered platforms: {}",
                    task.id,
                    known.join(", ")
                );
            }
        }
    }

    Ok(Plan {
        goal: goal.to_owned(),
        roots: root_tasks,
        named_caches: workspace.named_caches.values().cloned().collect(),
        tasks,
    })
}

fn select_roots<'a>(
    workspace: &'a Workspace,
    goal: &Goal,
    selectors: &[String],
) -> Result<Vec<(&'a Target, String)>> {
    let mut selected: BTreeMap<&str, (&Target, String)> = BTreeMap::new();
    if selectors.is_empty() {
        // If the workspace exports a `//:default` target, it acts as the
        // implicit root for selector-less invocations. Otherwise every target
        // that has a product for the current goal is selected.
        if let Some(default_target) = workspace.targets.get("//:default") {
            let product = goal_product_for_kind(workspace, goal, &default_target.kind)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "//:default has no {} product; add a rule for kind '{}'",
                        goal.name,
                        default_target.kind
                    )
                })?;
            selected.insert(default_target.address.as_str(), (default_target, product));
        } else {
            for target in workspace.targets.values() {
                if let Some(product) = goal_product_for_kind(workspace, goal, &target.kind) {
                    selected.insert(target.address.as_str(), (target, product));
                }
            }
        }
    } else {
        for selector in selectors {
            // A selector may contain a product override: "//:target#product".
            let (target_sel, product_override) = match selector.split_once('#') {
                Some((t, p)) => (t, Some(p)),
                None => (selector.as_str(), None),
            };
            let matches: Vec<_> = workspace
                .targets
                .values()
                .filter(|t| matches_selector(t, target_sel))
                .collect();
            if matches.is_empty() {
                bail!("no target matches selector '{selector}'");
            }
            for target in matches {
                let product = if let Some(p) = product_override {
                    let key = (target.kind.clone(), p.to_owned());
                    if !workspace.rules.contains_key(&key)
                        && !workspace.products.contains_key(&key)
                    {
                        bail!("{} has no product '{p}'", target.address);
                    }
                    p.to_owned()
                } else {
                    goal_product_for_kind(workspace, goal, &target.kind).ok_or_else(|| {
                        anyhow::anyhow!("{} has no {} product", target.address, goal.name)
                    })?
                };
                selected.insert(target.address.as_str(), (target, product));
            }
        }
    }
    Ok(selected.into_values().collect())
}

/// Return the product a goal would request for a given target kind, or `None`
/// if the goal has nothing to produce for that kind.
fn goal_product_for_kind(workspace: &Workspace, goal: &Goal, kind: &str) -> Option<String> {
    match &goal.product_policy {
        GoalProductPolicy::Default => {
            default_product_for_kind(workspace, kind).map(|s| s.to_owned())
        }
        GoalProductPolicy::Named(p) => {
            let key = (kind.to_owned(), p.clone());
            if workspace.rules.contains_key(&key) || workspace.products.contains_key(&key) {
                Some(p.clone())
            } else {
                None
            }
        }
    }
}

/// Infer the default product for a target kind from its registered rules.
/// Convention: the first non-config product is the default; if the only
/// rules produce config/source products, the kind has no build product.
fn default_product_for_kind<'a>(workspace: &'a Workspace, kind: &str) -> Option<&'a str> {
    let mut non_sources: Option<&str> = Option::None;

    for ((k, _), rule) in &workspace.rules {
        if k != kind {
            continue;
        }
        if !matches!(rule.product.as_str(), "sources" | "collection") {
            non_sources = Some(rule.product.as_str());
            break;
        }
    }

    if non_sources.is_some() {
        return non_sources;
    }

    // Also check registered products for a default.
    for ((k, p), _) in &workspace.products {
        if k == kind && !matches!(p.as_str(), "sources" | "collection") {
            return Some(p.as_str());
        }
    }

    Option::None
}

fn matches_selector(target: &Target, selector: &str) -> bool {
    target.address == selector
        || target.address.strip_prefix("//:") == Some(selector)
        || target.address.ends_with(&format!(":{selector}"))
}

struct Planner<'a> {
    workspace: &'a Workspace,
    tasks: BTreeMap<String, Task>,
}

impl Planner<'_> {
    fn default_product(&self, target: &Target) -> Result<String> {
        default_product_for_kind(self.workspace, &target.kind)
            .map(|s| s.to_owned())
            .ok_or_else(|| anyhow::anyhow!("{} has no build product", target.address))
    }

    fn request(&mut self, target_address: &str, product: &str) -> Result<String> {
        let id = format!("{target_address}#{product}");
        if self.tasks.contains_key(&id) {
            return Ok(id);
        }

        let target = self
            .workspace
            .targets
            .get(target_address)
            .ok_or_else(|| anyhow::anyhow!("target {target_address} does not exist"))?;

        let kind = target.kind.clone();
        let js_id = target.js_id;

        if let Some(rule) = self
            .workspace
            .rules
            .get(&(kind.clone(), product.to_owned()))
            .cloned()
        {
            let mut dependencies = Vec::new();
            if rule.requires_own_sources && product != "sources" {
                dependencies.push(self.request(&target.address, "sources")?);
            }
            for dep in &target.dependencies {
                // A named-mode edge overrides the rule's dependencyProduct.
                let dep_prod = match &dep.mode {
                    DependencyMode::Named(mode) => Some(mode.clone()),
                    DependencyMode::Auto => match &rule.dependency_product {
                        DependencyProduct::None => None,
                        DependencyProduct::Named(p) => Some(p.clone()),
                        DependencyProduct::Default => {
                            let dep_target = self
                                .workspace
                                .targets
                                .get(&dep.address)
                                .ok_or_else(|| {
                                    anyhow::anyhow!(
                                        "{} depends on missing target {}",
                                        target.address,
                                        dep.address
                                    )
                                })?;
                            Some(self.default_product(dep_target)?)
                        }
                    },
                };
                if let Some(prod) = dep_prod {
                    dependencies.push(self.request(&dep.address, &prod)?);
                }
            }

            let target = self.workspace.targets.get(target_address).unwrap();
            let (action, inputs, outputs) = lower_action(&rule.action, target, &id);
            self.tasks.insert(
                id.clone(),
                Task {
                    id: id.clone(),
                    target: target.address.clone(),
                    product: product.to_owned(),
                    fields: target.fields.clone(),
                    inputs,
                    outputs,
                    action,
                    exec_fn: rule.exec_fn.clone(),
                    dependencies,
                    js_id,
                    is_product: false,
                },
            );
        } else if let Some(exec_fn_name) = self
            .workspace
            .products
            .get(&(kind, product.to_owned()))
            .cloned()
        {
            // Product function path: no static dependencies, no real action.
            // Dependencies are discovered dynamically when the memoized function executes.
            let target = self.workspace.targets.get(target_address).unwrap();
            self.tasks.insert(
                id.clone(),
                Task {
                    id: id.clone(),
                    target: target.address.clone(),
                    product: product.to_owned(),
                    fields: target.fields.clone(),
                    inputs: Vec::new(),
                    outputs: Vec::new(),
                    action: Action {
                        argv: Vec::new(),
                        cwd: None,
                        env: BTreeMap::new(),
                        platform: None,
                        inputs: Vec::new(),
                        outputs: Vec::new(),
                        display: format!("product {product}"),
                        impure: false,
                        force_cache: false,
                    },
                    exec_fn: Some(exec_fn_name),
                    dependencies: Vec::new(),
                    js_id,
                    is_product: true,
                },
            );
        } else {
            bail!("{} cannot produce {product}", target_address);
        }

        Ok(id)
    }
}

// ---------------------------------------------------------------------------
// DOT rendering
// ---------------------------------------------------------------------------

pub fn render_dot(plan: &Plan) -> String {
    let node_ids: BTreeMap<_, _> = plan
        .tasks
        .iter()
        .enumerate()
        .map(|(i, t)| (t.id.as_str(), format!("task_{i}")))
        .collect();
    let root_ids: BTreeSet<_> = plan.roots.iter().map(String::as_str).collect();

    let mut dot = String::from(
        "digraph task_plan {\n  rankdir=TB;\n  node [shape=box, fontname=\"monospace\"];\n",
    );
    for task in &plan.tasks {
        let node_id = &node_ids[task.id.as_str()];
        let label = dot_escape(&format!("{}\n{}", task.id, task.action.display));
        let style = if root_ids.contains(task.id.as_str()) {
            ", peripheries=2"
        } else {
            ""
        };
        dot.push_str(&format!("  {node_id} [label=\"{label}\"{style}];\n"));
    }
    for task in &plan.tasks {
        let consumer = &node_ids[task.id.as_str()];
        for dep in &task.dependencies {
            if let Some(prereq) = node_ids.get(dep.as_str()) {
                dot.push_str(&format!("  {prereq} -> {consumer};\n"));
            }
        }
    }
    dot.push_str("}\n");
    dot
}

pub fn render_text_plan(plan: &Plan) -> String {
    use std::fmt::Write;

    let mut out = String::new();
    writeln!(&mut out, "{} plan:", plan.goal).expect("write to String");
    writeln!(&mut out, "  roots:").expect("write to String");
    for root in &plan.roots {
        writeln!(&mut out, "    {root}").expect("write to String");
    }
    writeln!(&mut out, "  tasks:").expect("write to String");
    for task in &plan.tasks {
        let dependencies = if task.dependencies.is_empty() {
            String::new()
        } else {
            format!(" <- {}", task.dependencies.join(", "))
        };
        writeln!(
            &mut out,
            "    {}: {}{}",
            task.id, task.action.display, dependencies
        )
        .expect("write to String");
    }
    out
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

#[allow(dead_code)]
pub fn execute_plan(
    plan: &Plan,
    workspace_root: &Path,
    mode: ExecutionMode,
) -> Result<ExecutionReport> {
    execute_plan_with_options(
        plan,
        None,
        workspace_root,
        ExecutionOptions::new(mode, 1),
        None,
    )
}

#[allow(dead_code)]
pub fn execute_plan_with_progress(
    plan: &Plan,
    workspace_root: &Path,
    mode: ExecutionMode,
    mut progress: Option<&mut prodash::tree::Item>,
) -> Result<ExecutionReport> {
    execute_plan_with_options(
        plan,
        None,
        workspace_root,
        ExecutionOptions::new(mode, 1),
        progress.as_deref_mut(),
    )
}

pub fn execute_plan_with_options(
    plan: &Plan,
    live: Option<&LiveWorkspace>,
    workspace_root: &Path,
    options: ExecutionOptions,
    progress: Option<&mut prodash::tree::Item>,
) -> Result<ExecutionReport> {
    let ordered = ordered_tasks(plan)?;

    if options.jobs > 1 {
        for task in &ordered {
            if task.exec_fn.is_some() {
                bail!(
                    "task {} uses an exec function; exec is not supported in parallel mode",
                    task.id
                );
            }
        }
    }

    let executions = if options.jobs <= 1 {
        execute_ordered_tasks_sequentially(
            &ordered,
            live,
            workspace_root,
            options.mode,
            &options.platform,
            &plan.named_caches,
            progress,
        )?
    } else {
        execute_ordered_tasks_parallel(&ordered, workspace_root, options, &plan.named_caches)?
    };
    Ok(ExecutionReport { tasks: executions })
}

fn execute_ordered_tasks_sequentially(
    ordered: &[&Task],
    live: Option<&LiveWorkspace>,
    workspace_root: &Path,
    mode: ExecutionMode,
    active_platform: &str,
    named_caches: &[NamedCache],
    mut progress: Option<&mut prodash::tree::Item>,
) -> Result<Vec<TaskExecution>> {
    let mut executions = Vec::with_capacity(ordered.len());
    let mut summaries = BTreeMap::new();
    let cancellation = AtomicBool::new(false);
    // Values produced by exec functions, keyed by task id.
    let mut exec_values: BTreeMap<String, String> = BTreeMap::new();

    for task in ordered {
        let mut task_progress = progress
            .as_deref_mut()
            .map(|progress| progress.add_child(format!("execute {}", task.id)));

        let (execution, summary) = if let (Some(live), true) = (live, task.exec_fn.is_some()) {
            let dep_values: Vec<String> = task
                .dependencies
                .iter()
                .filter_map(|dep_id| exec_values.get(dep_id).cloned())
                .collect();
            let (execution, summary, value) =
                execute_task_with_exec(task, live, workspace_root, &dep_values)?;
            if let Some(v) = value {
                exec_values.insert(task.id.clone(), v);
            }
            (execution, summary)
        } else {
            execute_one_task(
                task,
                workspace_root,
                mode,
                active_platform,
                named_caches,
                &summaries,
                task_progress.as_mut(),
                &cancellation,
            )?
        };

        summaries.insert(task.id.clone(), summary);
        executions.push(execution);
    }

    Ok(executions)
}

fn execute_ordered_tasks_parallel(
    ordered: &[&Task],
    workspace_root: &Path,
    options: ExecutionOptions,
    named_caches: &[NamedCache],
) -> Result<Vec<TaskExecution>> {
    let mut task_by_id: BTreeMap<&str, &Task> = ordered
        .iter()
        .map(|task| (task.id.as_str(), *task))
        .collect();
    let plan_index: BTreeMap<&str, usize> = ordered
        .iter()
        .enumerate()
        .map(|(i, task)| (task.id.as_str(), i))
        .collect();
    let mut completed = BTreeSet::new();
    let mut summaries = BTreeMap::new();
    let mut running = BTreeSet::new();
    let mut executions: Vec<Option<TaskExecution>> = vec![None; ordered.len()];
    let (sender, receiver) = mpsc::channel();
    let cancellation = Arc::new(AtomicBool::new(false));
    let mut first_error = None;

    while completed.len() < ordered.len() {
        if first_error.is_none() {
            let ready_ids: Vec<String> = task_by_id
                .iter()
                .filter_map(|(id, task)| {
                    let ready = !running.contains(*id)
                        && !completed.contains(*id)
                        && task.dependencies.iter().all(|dep| completed.contains(dep));
                    ready.then(|| (*id).to_owned())
                })
                .take(options.jobs.saturating_sub(running.len()))
                .collect();

            for id in ready_ids {
                let task = task_by_id
                    .remove(id.as_str())
                    .expect("ready id came from pending tasks");
                running.insert(id.clone());
                let sender = sender.clone();
                let workspace_root = workspace_root.to_owned();
                let mode = options.mode;
                let active_platform = options.platform.clone();
                let named_caches = named_caches.to_vec();
                let dependency_summaries = summaries.clone();
                let task = task.clone();
                let cancellation = Arc::clone(&cancellation);
                thread::spawn(move || {
                    let id = task.id.clone();
                    let result = execute_one_task(
                        &task,
                        &workspace_root,
                        mode,
                        &active_platform,
                        &named_caches,
                        &dependency_summaries,
                        None,
                        &cancellation,
                    );
                    let _ = sender.send((id, result));
                });
            }
        }

        if running.is_empty() {
            if let Some(error) = first_error {
                return Err(error);
            }
            let unresolved = task_by_id.keys().copied().collect::<Vec<_>>().join(", ");
            bail!("task graph has unresolved dependencies or a cycle: {unresolved}");
        }

        let (id, result) = receiver
            .recv()
            .context("parallel task worker channel closed unexpectedly")?;
        running.remove(id.as_str());
        match result {
            Ok((execution, summary)) => {
                let index = *plan_index
                    .get(id.as_str())
                    .ok_or_else(|| anyhow::anyhow!("completed unknown task {id}"))?;
                executions[index] = Some(execution);
                summaries.insert(id.clone(), summary);
                completed.insert(id);
            }
            Err(error) => {
                if first_error.is_none() {
                    cancellation.store(true, Ordering::SeqCst);
                    first_error = Some(error);
                }
            }
        }
    }

    if let Some(error) = first_error {
        return Err(error);
    }

    executions
        .into_iter()
        .map(|execution| execution.ok_or_else(|| anyhow::anyhow!("missing task execution result")))
        .collect()
}

fn execute_one_task(
    task: &Task,
    workspace_root: &Path,
    mode: ExecutionMode,
    active_platform: &str,
    named_caches: &[NamedCache],
    completed_dependencies: &BTreeMap<String, TaskCacheSummary>,
    mut progress: Option<&mut prodash::tree::Item>,
    cancellation: &AtomicBool,
) -> Result<(TaskExecution, TaskCacheSummary)> {
    let command = task.action.argv.clone();

    // Platform check: tasks with a platform constraint only run on that platform.
    let task_platform = task.action.platform.as_deref().unwrap_or("local");
    if task_platform != active_platform {
        if let Some(progress) = progress.as_mut() {
            progress.done("skipped (platform)");
        }
        return Ok((
            TaskExecution {
                task_id: task.id.clone(),
                status: TaskExecutionStatus::SkippedPlatform,
                command,
            },
            TaskCacheSummary {
                task_id: task.id.clone(),
                task_key: String::new(),
            },
        ));
    }

    let status = match mode {
        ExecutionMode::DryRun => {
            if let Some(progress) = progress.as_mut() {
                progress.done("would run");
            }
            TaskExecutionStatus::WouldRun
        }
        ExecutionMode::Local if command.is_empty() && task.outputs.is_empty() => {
            if let Some(progress) = progress.as_mut() {
                progress.done("noop");
            }
            TaskExecutionStatus::Noop
        }
        ExecutionMode::Local if command.is_empty() => {
            let evaluation =
                evaluate_task_cache(task, workspace_root, named_caches, completed_dependencies)?;
            if evaluation.hit {
                let record = evaluation
                    .record
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("cache hit for {} had no record", task.id))?;
                materialize_cached_outputs(record, workspace_root)?;
                if let Some(progress) = progress.as_mut() {
                    progress.done("cache hit");
                }
                return Ok((
                    TaskExecution {
                        task_id: task.id.clone(),
                        status: TaskExecutionStatus::CacheHit,
                        command,
                    },
                    TaskCacheSummary {
                        task_id: task.id.clone(),
                        task_key: evaluation.task_key,
                    },
                ));
            }

            materialize_embedded_output_task(task, workspace_root, &evaluation)?;
            if let Some(progress) = progress.as_mut() {
                progress.done("done");
            }
            TaskExecutionStatus::Ran
        }
        ExecutionMode::Local => {
            let evaluation =
                evaluate_task_cache(task, workspace_root, named_caches, completed_dependencies)?;
            if evaluation.hit {
                let record = evaluation
                    .record
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("cache hit for {} had no record", task.id))?;
                materialize_cached_outputs(record, workspace_root)?;
                if let Some(progress) = progress.as_mut() {
                    progress.done("cache hit");
                }
                return Ok((
                    TaskExecution {
                        task_id: task.id.clone(),
                        status: TaskExecutionStatus::CacheHit,
                        command,
                    },
                    TaskCacheSummary {
                        task_id: task.id.clone(),
                        task_key: evaluation.task_key,
                    },
                ));
            }

            if let Err(error) = run_local_task(
                task,
                workspace_root,
                progress.as_deref(),
                cancellation,
                &evaluation,
            ) {
                if let Some(progress) = progress.as_mut() {
                    progress.fail("failed");
                }
                return Err(error);
            }
            if let Some(progress) = progress.as_mut() {
                progress.done("done");
            }
            TaskExecutionStatus::Ran
        }
    };

    let summary_key = match mode {
        ExecutionMode::DryRun => digest_bytes(task.id.as_bytes()),
        ExecutionMode::Local => {
            evaluate_task_cache(task, workspace_root, named_caches, completed_dependencies)?
                .task_key
        }
    };
    Ok((
        TaskExecution {
            task_id: task.id.clone(),
            status,
            command,
        },
        TaskCacheSummary {
            task_id: task.id.clone(),
            task_key: summary_key,
        },
    ))
}

fn ordered_tasks(plan: &Plan) -> Result<Vec<&Task>> {
    let mut pending: BTreeMap<&str, &Task> = plan
        .tasks
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect();
    let mut completed = BTreeSet::new();
    let mut ordered = Vec::with_capacity(plan.tasks.len());

    while !pending.is_empty() {
        let ready_ids: Vec<String> = pending
            .iter()
            .filter_map(|(id, task)| {
                let ready = task.dependencies.iter().all(|dep| completed.contains(dep));
                ready.then(|| (*id).to_owned())
            })
            .collect();

        if ready_ids.is_empty() {
            let unresolved = pending
                .values()
                .map(|task| task.id.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            bail!("task graph has unresolved dependencies or a cycle: {unresolved}");
        }

        for id in ready_ids {
            let task = pending
                .remove(id.as_str())
                .expect("ready id came from pending");
            for dep in &task.dependencies {
                if !completed.contains(dep)
                    && !plan.tasks.iter().any(|candidate| &candidate.id == dep)
                {
                    bail!("{} depends on missing task {dep}", task.id);
                }
            }
            completed.insert(id);
            ordered.push(task);
        }
    }

    Ok(ordered)
}

fn run_local_task(
    task: &Task,
    workspace_root: &Path,
    progress: Option<&prodash::tree::Item>,
    cancellation: &AtomicBool,
    cache: &TaskCacheEvaluation,
) -> Result<()> {
    if cancellation.load(Ordering::SeqCst) {
        bail!("{} canceled before execution", task.id);
    }

    let sandbox = prepare_sandbox(task, workspace_root)?;
    let manifest_path = sandbox.sandbox_root.join("imp-sandbox.json");
    std::fs::write(&manifest_path, serde_json::to_string_pretty(&sandbox)?)
        .with_context(|| format!("write sandbox manifest {}", manifest_path.display()))?;

    let cwd = task
        .action
        .cwd
        .as_deref()
        .map(|cwd| resolve_sandbox_path(&sandbox.sandbox_root, cwd))
        .transpose()?
        .unwrap_or_else(|| sandbox.sandbox_root.clone());
    std::fs::create_dir_all(&cwd).with_context(|| format!("create cwd {}", cwd.display()))?;
    let (program, args) = task
        .action
        .argv
        .split_first()
        .ok_or_else(|| anyhow::anyhow!("{} has no argv", task.id))?;

    let mut command = Command::new(program);
    for binding in &cache.named_caches {
        std::fs::create_dir_all(&binding.path)
            .with_context(|| format!("create named cache {}", binding.path.display()))?;
        command.env(&binding.env_var, &binding.path);
    }
    command
        .args(args)
        .current_dir(&cwd)
        .envs(&task.action.env)
        .env("IMP_SANDBOX_ROOT", &sandbox.sandbox_root)
        .env("IMP_CACHE_ROOT", &sandbox.cache_root)
        .env("IMP_SANDBOX_MANIFEST", &manifest_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .with_context(|| format!("execute {} in {}", task.id, cwd.display()))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("{} stdout was not piped", task.id))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow::anyhow!("{} stderr was not piped", task.id))?;
    let (sender, receiver) = mpsc::channel();
    let stdout_thread = spawn_output_reader(stdout, ProcessStream::Stdout, sender.clone());
    let stderr_thread = spawn_output_reader(stderr, ProcessStream::Stderr, sender);

    let mut stdout = String::new();
    let mut stderr = String::new();
    let status = loop {
        if cancellation.load(Ordering::SeqCst) {
            terminate_child(&mut child);
            let _ = child.wait();
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            drain_process_lines(&receiver, progress, &mut stdout, &mut stderr);
            bail!("{} canceled", task.id);
        }
        drain_process_lines(&receiver, progress, &mut stdout, &mut stderr);
        if let Some(status) = child
            .try_wait()
            .with_context(|| format!("wait for {}", task.id))?
        {
            break status;
        }
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(line) => record_process_line(line, progress, &mut stdout, &mut stderr),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {}
        }
    };

    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    drain_process_lines(&receiver, progress, &mut stdout, &mut stderr);

    if !status.success() {
        bail!(
            "{} failed with status {}\nstdout:\n{}\nstderr:\n{}",
            task.id,
            status,
            stdout.trim_end(),
            stderr.trim_end()
        );
    }

    let outputs = ingest_task_outputs(task, &sandbox)?;
    if cache.cacheable {
        let record = TaskCacheRecord {
            version: 1,
            task_id: task.id.clone(),
            task_key: cache.task_key.clone(),
            action_digest: cache.action_digest.clone(),
            input_digests: cache.input_digests.clone(),
            dependency_keys: cache.dependency_keys.clone(),
            named_caches: cache.named_caches.clone(),
            outputs,
        };
        write_task_cache_record(&record)?;
        materialize_cached_outputs(&record, workspace_root)?;
    }
    Ok(())
}

fn materialize_embedded_output_task(
    task: &Task,
    workspace_root: &Path,
    cache: &TaskCacheEvaluation,
) -> Result<()> {
    if !task_has_embedded_outputs(task) {
        bail!(
            "{} has no executable argv and contains outputs that cannot be materialized from embedded values",
            task.id
        );
    }
    let mut outputs = Vec::new();
    for artifact in &task.outputs {
        let value = artifact.value.as_deref().unwrap_or_default();
        outputs.push(CachedArtifact {
            artifact_id: artifact.id.clone(),
            kind: artifact.kind.clone(),
            path: artifact.path.clone(),
            value: artifact.value.clone(),
            digest: store_blob(value.as_bytes(), &artifact.kind)?,
            bytes: Some(value.len() as u64),
            files: Vec::new(),
        });
    }

    if cache.cacheable {
        let record = TaskCacheRecord {
            version: 1,
            task_id: task.id.clone(),
            task_key: cache.task_key.clone(),
            action_digest: cache.action_digest.clone(),
            input_digests: cache.input_digests.clone(),
            dependency_keys: cache.dependency_keys.clone(),
            named_caches: cache.named_caches.clone(),
            outputs,
        };
        write_task_cache_record(&record)?;
        materialize_cached_outputs(&record, workspace_root)?;
    }
    Ok(())
}

fn terminate_child(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let group = format!("-{}", child.id());
        if Command::new("kill")
            .args(["-TERM", "--", group.as_str()])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
        {
            return;
        }
    }
    let _ = child.kill();
}

fn prepare_sandbox(task: &Task, workspace_root: &Path) -> Result<SandboxManifest> {
    let sandbox_root = create_sandbox_root()?;
    let cache_root = cache_root()?;
    let mut input_runlist = Vec::new();
    let mut output_runlist = Vec::new();

    for artifact in &task.inputs {
        let Some(path) = &artifact.path else {
            continue;
        };
        let relative = artifact_relative_path(path)?;
        let source = workspace_root.join(&relative);
        let sandbox_path = sandbox_root.join(&relative);
        copy_artifact_into_sandbox(artifact, &source, &sandbox_path)?;
        input_runlist.push(SandboxInput {
            artifact_id: artifact.id.clone(),
            source,
            sandbox_path,
            kind: artifact.kind.clone(),
        });
    }

    for artifact in &task.outputs {
        let Some(path) = &artifact.path else {
            continue;
        };
        let relative = artifact_relative_path(path)?;
        let sandbox_path = sandbox_root.join(&relative);
        let cache_path = cache_root.join(&relative);
        output_runlist.push(SandboxOutput {
            artifact_id: artifact.id.clone(),
            sandbox_path,
            cache_path,
            kind: artifact.kind.clone(),
        });
    }

    Ok(SandboxManifest {
        task_id: task.id.clone(),
        sandbox_root,
        cache_root,
        input_runlist,
        output_runlist,
    })
}

fn create_sandbox_root() -> Result<PathBuf> {
    let base = PathBuf::from("/tmp/imp");
    std::fs::create_dir_all(&base).with_context(|| format!("create {}", base.display()))?;
    let unique = format!(
        "sandbox-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let root = base.join(unique);
    std::fs::create_dir(&root).with_context(|| format!("create sandbox {}", root.display()))?;
    Ok(root)
}

fn cache_root() -> Result<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(cache) = std::env::var_os("XDG_CACHE_HOME") {
        candidates.push(PathBuf::from(cache).join("imp"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join(".cache").join("imp"));
    }
    candidates.push(PathBuf::from("/tmp/imp/cache"));

    let mut last_error = None;
    for candidate in candidates {
        match std::fs::create_dir_all(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) => last_error = Some((candidate, error)),
        }
    }

    if let Some((candidate, error)) = last_error {
        bail!("create cache root {}: {error}", candidate.display());
    }
    bail!("no cache root candidates available")
}

fn workspace_cache_id(workspace_root: &Path) -> String {
    digest_bytes(workspace_root.to_string_lossy().as_bytes())
}

fn named_cache_bindings(
    workspace_root: &Path,
    named_caches: &[NamedCache],
) -> Result<Vec<NamedCacheBinding>> {
    let root = cache_root()?
        .join("named")
        .join(workspace_cache_id(workspace_root));
    let mut bindings = Vec::with_capacity(named_caches.len());
    for cache in named_caches {
        let path = root.join(&cache.name);
        bindings.push(NamedCacheBinding {
            name: cache.name.clone(),
            env_var: cache.env_var.clone(),
            path,
        });
    }
    Ok(bindings)
}

fn cas_blob_path(digest: &str) -> Result<PathBuf> {
    Ok(cache_root()?.join("cas").join("blobs").join(digest))
}

fn cas_meta_path(digest: &str) -> Result<PathBuf> {
    Ok(cache_root()?
        .join("cas")
        .join("meta")
        .join(format!("{digest}.json")))
}

fn task_record_path(task_key: &str) -> Result<PathBuf> {
    Ok(cache_root()?.join("tasks").join(format!("{task_key}.json")))
}

fn digest_bytes(bytes: &[u8]) -> String {
    format!("{:x}", md5::compute(bytes))
}

fn digest_json<T: Serialize>(value: &T) -> Result<String> {
    let encoded = serde_json::to_vec(value).context("serialize digest input")?;
    Ok(digest_bytes(&encoded))
}

fn store_blob(bytes: &[u8], kind: &str) -> Result<String> {
    let digest = digest_bytes(bytes);
    let blob_path = cas_blob_path(&digest)?;
    if !blob_path.is_file() {
        if let Some(parent) = blob_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let temp = temp_sibling_path(&blob_path, "tmp-blob");
        std::fs::write(&temp, bytes).with_context(|| format!("write {}", temp.display()))?;
        std::fs::rename(&temp, &blob_path).with_context(|| {
            format!("publish blob {} to {}", temp.display(), blob_path.display())
        })?;
    }

    let meta_path = cas_meta_path(&digest)?;
    if !meta_path.is_file() {
        if let Some(parent) = meta_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let metadata = serde_json::json!({
            "digest": digest,
            "kind": kind,
            "bytes": bytes.len(),
        });
        std::fs::write(&meta_path, serde_json::to_vec_pretty(&metadata)?)
            .with_context(|| format!("write {}", meta_path.display()))?;
    }
    Ok(digest)
}

fn store_file_blob(path: &Path, kind: &str) -> Result<(String, u64)> {
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let size = bytes.len() as u64;
    Ok((store_blob(&bytes, kind)?, size))
}

fn directory_entries(path: &Path) -> Result<Vec<CacheDirectoryEntry>> {
    let mut entries = Vec::new();
    for entry in WalkDir::new(path) {
        let entry = entry.with_context(|| format!("walk {}", path.display()))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(path)
            .with_context(|| format!("strip {} from {}", path.display(), entry.path().display()))?;
        let relative = relative
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        let (digest, bytes) = store_file_blob(entry.path(), "directory-entry")?;
        entries.push(CacheDirectoryEntry {
            path: relative,
            digest,
            bytes,
        });
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

fn cas_tree_path(digest: &str) -> Result<PathBuf> {
    Ok(cache_root()?.join("cas").join("trees").join(digest))
}

fn cas_tree_store(entries: &[SourceFileEntry]) -> Result<String> {
    let mut sorted = entries.to_vec();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));
    let bytes = serde_json::to_vec(&sorted).context("serialize tree")?;
    let digest = digest_bytes(&bytes);
    let tree_path = cas_tree_path(&digest)?;
    if !tree_path.is_file() {
        if let Some(parent) = tree_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let temp = temp_sibling_path(&tree_path, "tmp-tree");
        std::fs::write(&temp, &bytes).with_context(|| format!("write {}", temp.display()))?;
        std::fs::rename(&temp, &tree_path).with_context(|| {
            format!("publish tree {} to {}", temp.display(), tree_path.display())
        })?;
    }
    Ok(digest)
}

fn cas_tree_get(digest: &str) -> Result<Vec<SourceFileEntry>> {
    let tree_path = cas_tree_path(digest)?;
    let bytes = std::fs::read(&tree_path)
        .with_context(|| format!("read tree {}", tree_path.display()))?;
    serde_json::from_slice(&bytes).context("deserialize tree")
}

fn cas_tree_merge(digests: &[&str]) -> Result<String> {
    let mut seen: BTreeMap<String, SourceFileEntry> = BTreeMap::new();
    for digest in digests {
        for entry in cas_tree_get(digest)? {
            if let Some(existing) = seen.get(&entry.path) {
                if existing.digest != entry.digest {
                    bail!("tree merge: conflicting content for '{}'", entry.path);
                }
            } else {
                seen.insert(entry.path.clone(), entry);
            }
        }
    }
    let merged: Vec<SourceFileEntry> = seen.into_values().collect();
    cas_tree_store(&merged)
}

fn artifact_relative_path(path: &str) -> Result<PathBuf> {
    let path = Path::new(path);
    if path.is_absolute() {
        bail!(
            "artifact path {} must be relative for sandbox execution",
            path.display()
        );
    }

    let mut relative = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(component) => relative.push(component),
            std::path::Component::CurDir => {}
            _ => bail!(
                "artifact path {} must not contain parent or prefix components",
                path.display()
            ),
        }
    }
    if relative.as_os_str().is_empty() {
        bail!("artifact path must not be empty");
    }
    Ok(relative)
}

fn resolve_sandbox_path(root: &Path, path: &str) -> Result<PathBuf> {
    let relative = artifact_relative_path(path)?;
    Ok(root.join(relative))
}

fn copy_artifact_into_sandbox(
    artifact: &Artifact,
    source: &Path,
    destination: &Path,
) -> Result<()> {
    match artifact.kind.as_str() {
        "file" | "manifest" => {
            if !source.is_file() {
                bail!(
                    "{} declared {} input {} but it is not a file",
                    artifact.id,
                    artifact.kind,
                    source.display()
                );
            }
            copy_file(source, destination)?;
        }
        "directory" => {
            if !source.is_dir() {
                bail!(
                    "{} declared directory input {} but it is not a directory",
                    artifact.id,
                    source.display()
                );
            }
            copy_directory(source, destination)?;
        }
        "value" => {}
        other => bail!(
            "{} has unsupported input artifact kind {other}",
            artifact.id
        ),
    }
    Ok(())
}

fn evaluate_task_cache(
    task: &Task,
    workspace_root: &Path,
    named_caches: &[NamedCache],
    completed_dependencies: &BTreeMap<String, TaskCacheSummary>,
) -> Result<TaskCacheEvaluation> {
    let bindings = named_cache_bindings(workspace_root, named_caches)?;
    let input_digests = digest_task_inputs(task, workspace_root)?;
    let mut dependency_keys = Vec::new();
    for dependency in &task.dependencies {
        if let Some(summary) = completed_dependencies.get(dependency) {
            dependency_keys.push((dependency.clone(), summary.task_key.clone()));
        } else {
            dependency_keys.push((dependency.clone(), "<missing>".to_owned()));
        }
    }
    let action_digest = digest_json(&serde_json::json!({
        "task_id": task.id,
        "target": task.target,
        "product": task.product,
        "action": task.action,
        "outputs": task.outputs,
    }))?;
    let task_key = digest_json(&serde_json::json!({
        "version": 1u32,
        "task_id": task.id,
        "action_digest": action_digest,
        "input_digests": input_digests,
        "dependency_keys": dependency_keys,
        "named_caches": bindings,
    }))?;
    let cacheable = if task.action.force_cache {
        true
    } else if task.action.impure {
        false
    } else {
        !task.outputs.is_empty()
            && (!task.action.argv.is_empty() || task_has_embedded_outputs(task))
    };
    if !cacheable {
        let miss_reason = if task.action.impure && !task.action.force_cache {
            "task is marked impure (set force_cache: true to override)".to_owned()
        } else {
            "task has no executable argv or embedded declared outputs".to_owned()
        };
        return Ok(TaskCacheEvaluation {
            cacheable,
            task_key,
            action_digest,
            input_digests,
            dependency_keys,
            named_caches: bindings,
            hit: false,
            miss_reason: Some(miss_reason),
            record: None,
        });
    }

    let record_path = task_record_path(&task_key)?;
    let record = match std::fs::read_to_string(&record_path) {
        Ok(encoded) => {
            let record: TaskCacheRecord = serde_json::from_str(&encoded)
                .with_context(|| format!("parse task cache record {}", record_path.display()))?;
            Some(record)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(error)
                .with_context(|| format!("read task cache record {}", record_path.display()));
        }
    };

    let (hit, miss_reason) = match &record {
        None => (false, Some("no task cache record".to_owned())),
        Some(record) if record.task_key != task_key => {
            (false, Some("task cache record key mismatch".to_owned()))
        }
        Some(record) => match cached_outputs_present(record) {
            Ok(()) => (true, None),
            Err(error) => (false, Some(format!("{error:#}"))),
        },
    };

    Ok(TaskCacheEvaluation {
        cacheable,
        task_key,
        action_digest,
        input_digests,
        dependency_keys,
        named_caches: bindings,
        hit,
        miss_reason,
        record,
    })
}

fn task_has_embedded_outputs(task: &Task) -> bool {
    !task.outputs.is_empty()
        && task
            .outputs
            .iter()
            .all(|artifact| match artifact.kind.as_str() {
                "file" | "manifest" => artifact.value.is_some(),
                "value" => true,
                _ => false,
            })
}

fn digest_task_inputs(task: &Task, workspace_root: &Path) -> Result<Vec<CacheInputDigest>> {
    let mut digests = Vec::new();
    for artifact in &task.inputs {
        let digest = match artifact.kind.as_str() {
            "file" | "manifest" => {
                let path = artifact
                    .path
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("{} input has no path", artifact.id))?;
                let relative = artifact_relative_path(path)?;
                let source = workspace_root.join(relative);
                if !source.is_file() {
                    bail!(
                        "{} declared {} input {} but it is not a file",
                        artifact.id,
                        artifact.kind,
                        source.display()
                    );
                }
                let (digest, _) = store_file_blob(&source, &artifact.kind)?;
                digest
            }
            "directory" => {
                let path = artifact.path.as_deref().ok_or_else(|| {
                    anyhow::anyhow!("{} directory input has no path", artifact.id)
                })?;
                let relative = artifact_relative_path(path)?;
                let source = workspace_root.join(relative);
                if !source.is_dir() {
                    bail!(
                        "{} declared directory input {} but it is not a directory",
                        artifact.id,
                        source.display()
                    );
                }
                digest_json(&directory_entries(&source)?)?
            }
            "value" => {
                let value = artifact.value.as_deref().unwrap_or_default();
                store_blob(value.as_bytes(), "value")?
            }
            other => bail!(
                "{} has unsupported input artifact kind {other}",
                artifact.id
            ),
        };
        digests.push(CacheInputDigest {
            artifact_id: artifact.id.clone(),
            kind: artifact.kind.clone(),
            path: artifact.path.clone(),
            value: artifact.value.clone(),
            digest,
        });
    }
    Ok(digests)
}

fn cached_outputs_present(record: &TaskCacheRecord) -> Result<()> {
    for output in &record.outputs {
        match output.kind.as_str() {
            "file" | "manifest" => {
                let path = cas_blob_path(&output.digest)?;
                if !path.is_file() {
                    bail!(
                        "{} cached blob {} is missing",
                        output.artifact_id,
                        path.display()
                    );
                }
            }
            "directory" => {
                for file in &output.files {
                    let path = cas_blob_path(&file.digest)?;
                    if !path.is_file() {
                        bail!(
                            "{} cached directory blob {} is missing",
                            output.artifact_id,
                            path.display()
                        );
                    }
                }
            }
            "value" => {}
            other => bail!(
                "{} has unsupported cached artifact kind {other}",
                output.artifact_id
            ),
        }
    }
    Ok(())
}

fn ingest_task_outputs(task: &Task, sandbox: &SandboxManifest) -> Result<Vec<CachedArtifact>> {
    let outputs_by_id: BTreeMap<&str, &SandboxOutput> = sandbox
        .output_runlist
        .iter()
        .map(|output| (output.artifact_id.as_str(), output))
        .collect();
    let mut cached = Vec::new();
    for artifact in &task.outputs {
        let cached_artifact = match artifact.kind.as_str() {
            "file" | "manifest" => {
                let output = outputs_by_id.get(artifact.id.as_str()).ok_or_else(|| {
                    anyhow::anyhow!("{} output was not present in sandbox runlist", artifact.id)
                })?;
                if !output.sandbox_path.is_file() {
                    bail!(
                        "{} declared {} output {} but it was not created as a file in sandbox",
                        task.id,
                        output.kind,
                        output.sandbox_path.display()
                    );
                }
                let (digest, bytes) = store_file_blob(&output.sandbox_path, &artifact.kind)?;
                CachedArtifact {
                    artifact_id: artifact.id.clone(),
                    kind: artifact.kind.clone(),
                    path: artifact.path.clone(),
                    value: artifact.value.clone(),
                    digest,
                    bytes: Some(bytes),
                    files: Vec::new(),
                }
            }
            "directory" => {
                let output = outputs_by_id.get(artifact.id.as_str()).ok_or_else(|| {
                    anyhow::anyhow!("{} output was not present in sandbox runlist", artifact.id)
                })?;
                if !output.sandbox_path.is_dir() {
                    bail!(
                        "{} declared directory output {} but it was not created in sandbox",
                        task.id,
                        output.sandbox_path.display()
                    );
                }
                let files = directory_entries(&output.sandbox_path)?;
                let digest = digest_json(&files)?;
                CachedArtifact {
                    artifact_id: artifact.id.clone(),
                    kind: artifact.kind.clone(),
                    path: artifact.path.clone(),
                    value: artifact.value.clone(),
                    digest,
                    bytes: None,
                    files,
                }
            }
            "value" => {
                let value = artifact.value.as_deref().unwrap_or_default();
                CachedArtifact {
                    artifact_id: artifact.id.clone(),
                    kind: artifact.kind.clone(),
                    path: artifact.path.clone(),
                    value: artifact.value.clone(),
                    digest: store_blob(value.as_bytes(), "value")?,
                    bytes: Some(value.len() as u64),
                    files: Vec::new(),
                }
            }
            other => bail!(
                "{} has unsupported output artifact kind {other}",
                artifact.id
            ),
        };
        cached.push(cached_artifact);
    }
    Ok(cached)
}

fn write_task_cache_record(record: &TaskCacheRecord) -> Result<()> {
    let path = task_record_path(&record.task_key)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let temp = temp_sibling_path(&path, "tmp-record");
    std::fs::write(&temp, serde_json::to_vec_pretty(record)?)
        .with_context(|| format!("write {}", temp.display()))?;
    std::fs::rename(&temp, &path)
        .with_context(|| format!("publish task cache record {}", path.display()))?;
    Ok(())
}

fn materialize_cached_outputs(record: &TaskCacheRecord, workspace_root: &Path) -> Result<()> {
    for output in &record.outputs {
        let Some(path) = &output.path else {
            continue;
        };
        let destination = workspace_root.join(artifact_relative_path(path)?);
        match output.kind.as_str() {
            "file" | "manifest" => {
                let source = cas_blob_path(&output.digest)?;
                publish_file_atomically(&source, &destination)?;
            }
            "directory" => materialize_cached_directory(output, &destination)?,
            "value" => {}
            other => bail!(
                "{} has unsupported cached output artifact kind {other}",
                output.artifact_id
            ),
        }
    }
    Ok(())
}

fn materialize_cached_directory(output: &CachedArtifact, destination: &Path) -> Result<()> {
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let temp = temp_sibling_path(destination, "tmp-dir");
    remove_path_if_exists(&temp)?;
    std::fs::create_dir_all(&temp).with_context(|| format!("create {}", temp.display()))?;
    for file in &output.files {
        let relative = artifact_relative_path(&file.path)?;
        let source = cas_blob_path(&file.digest)?;
        copy_file(&source, &temp.join(relative))?;
    }
    remove_path_if_exists(destination)?;
    std::fs::rename(&temp, destination).with_context(|| {
        format!(
            "publish directory {} to {}",
            temp.display(),
            destination.display()
        )
    })?;
    Ok(())
}

fn remove_path_if_exists(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(path)
            .with_context(|| format!("remove directory {}", path.display())),
        Ok(_) => {
            std::fs::remove_file(path).with_context(|| format!("remove file {}", path.display()))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("stat {}", path.display())),
    }
}

fn publish_file_atomically(source: &Path, destination: &Path) -> Result<()> {
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let temp = temp_sibling_path(destination, "tmp-file");
    copy_file(source, &temp)?;
    std::fs::rename(&temp, destination).with_context(|| {
        format!(
            "publish file {} to {}",
            temp.display(),
            destination.display()
        )
    })?;
    Ok(())
}

fn temp_sibling_path(destination: &Path, suffix: &str) -> PathBuf {
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("artifact");
    let temp_name = format!(
        ".{file_name}.{suffix}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    destination.with_file_name(temp_name)
}

fn copy_file(source: &Path, destination: &Path) -> Result<()> {
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    std::fs::copy(source, destination)
        .with_context(|| format!("copy {} to {}", source.display(), destination.display()))?;
    Ok(())
}

fn copy_directory(source: &Path, destination: &Path) -> Result<()> {
    for entry in WalkDir::new(source) {
        let entry = entry.with_context(|| format!("walk {}", source.display()))?;
        let relative = entry.path().strip_prefix(source).with_context(|| {
            format!("strip {} from {}", source.display(), entry.path().display())
        })?;
        let target = destination.join(relative);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&target)
                .with_context(|| format!("create {}", target.display()))?;
        } else if entry.file_type().is_file() {
            copy_file(entry.path(), &target)?;
        }
    }
    Ok(())
}

pub fn explain_task_cache(
    plan: &Plan,
    workspace_root: &Path,
    task_selector: &str,
) -> Result<CacheExplanation> {
    let ordered = ordered_tasks(plan)?;
    let selected_id = if ordered.iter().any(|task| task.id == task_selector) {
        task_selector.to_owned()
    } else if plan.roots.len() == 1 {
        plan.roots[0].clone()
    } else {
        bail!("cache explain selector '{task_selector}' did not match a task id");
    };

    let mut summaries = BTreeMap::new();
    for task in ordered {
        let evaluation = evaluate_task_cache(task, workspace_root, &plan.named_caches, &summaries)?;
        if task.id == selected_id {
            return Ok(CacheExplanation {
                task_id: task.id.clone(),
                cacheable: evaluation.cacheable,
                impure: task.action.impure,
                force_cache: task.action.force_cache,
                task_key: evaluation.task_key,
                action_digest: evaluation.action_digest,
                input_digests: evaluation.input_digests,
                dependency_keys: evaluation.dependency_keys,
                named_caches: evaluation.named_caches,
                hit: evaluation.hit,
                miss_reason: evaluation.miss_reason,
            });
        }
        summaries.insert(
            task.id.clone(),
            TaskCacheSummary {
                task_id: task.id.clone(),
                task_key: evaluation.task_key,
            },
        );
    }

    bail!("task {selected_id} was not present in the plan")
}

pub fn format_cache_explanation(
    explanation: &CacheExplanation,
    w: &mut String,
) -> std::fmt::Result {
    use std::fmt::Write;

    writeln!(w, "Cache explanation for {}", explanation.task_id)?;
    writeln!(w, "  cacheable: {}", explanation.cacheable)?;
    if explanation.impure {
        if explanation.force_cache {
            writeln!(w, "  impure: true (force_cache override — caching anyway)")?;
        } else {
            writeln!(w, "  impure: true (caching disabled)")?;
        }
    }
    writeln!(
        w,
        "  status: {}",
        if explanation.hit { "hit" } else { "miss" }
    )?;
    if let Some(reason) = &explanation.miss_reason {
        writeln!(w, "  miss reason: {reason}")?;
    }
    writeln!(w, "  task key: {}", explanation.task_key)?;
    writeln!(w, "  action digest: {}", explanation.action_digest)?;
    writeln!(w, "  inputs:")?;
    if explanation.input_digests.is_empty() {
        writeln!(w, "    (none)")?;
    } else {
        for input in &explanation.input_digests {
            let path = input.path.as_deref().unwrap_or("<value>");
            writeln!(
                w,
                "    {} {} {} {}",
                input.artifact_id, input.kind, path, input.digest
            )?;
        }
    }
    writeln!(w, "  dependencies:")?;
    if explanation.dependency_keys.is_empty() {
        writeln!(w, "    (none)")?;
    } else {
        for (task, key) in &explanation.dependency_keys {
            writeln!(w, "    {task} {key}")?;
        }
    }
    writeln!(w, "  named caches:")?;
    if explanation.named_caches.is_empty() {
        writeln!(w, "    (none)")?;
    } else {
        for binding in &explanation.named_caches {
            writeln!(
                w,
                "    {} {} {}",
                binding.name,
                binding.env_var,
                binding.path.display()
            )?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Selection and formatting
// ---------------------------------------------------------------------------

pub fn select_targets<'a>(
    workspace: &'a Workspace,
    selectors: &[String],
) -> Result<Vec<&'a Target>> {
    if selectors.is_empty() {
        return Ok(workspace.targets.values().collect());
    }
    let mut selected = BTreeMap::new();
    for selector in selectors {
        let matches: Vec<_> = workspace
            .targets
            .values()
            .filter(|t| matches_selector(t, selector))
            .collect();
        if matches.is_empty() {
            bail!("no target matches selector '{selector}'");
        }
        for t in matches {
            selected.insert(t.address.as_str(), t);
        }
    }
    Ok(selected.into_values().collect())
}

pub fn format_targets(targets: &[&Target], w: &mut String) -> std::fmt::Result {
    use std::fmt::Write;
    for target in targets {
        writeln!(w, "{} ({})", target.address, target.kind)?;
        if let Some(sources) = target.fields.get("sources") {
            if !sources.is_empty() {
                writeln!(w, "  sources: {sources}")?;
            }
        }
        if let Some(ep) = target.fields.get("entrypoint") {
            writeln!(w, "  entrypoint: {ep}")?;
        }
        if let Some(version) = target.fields.get("version") {
            writeln!(w, "  version: {version}")?;
        }
        if !target.dependencies.is_empty() {
            let deps: Vec<_> = target
                .dependencies
                .iter()
                .map(|d| d.address.as_str())
                .collect();
            writeln!(w, "  dependencies: {}", deps.join(", "))?;
        }
    }
    Ok(())
}

pub fn format_dependencies(
    workspace: &Workspace,
    selectors: &[String],
    w: &mut String,
) -> Result<()> {
    let targets = if selectors.is_empty() {
        // Show roots (targets not depended on by any other target).
        let mut child_addrs: BTreeSet<&str> = BTreeSet::new();
        for t in workspace.targets.values() {
            for d in &t.dependencies {
                child_addrs.insert(d.address.as_str());
            }
        }
        let roots: Vec<_> = workspace
            .targets
            .values()
            .filter(|t| !child_addrs.contains(t.address.as_str()))
            .collect();
        if roots.is_empty() {
            workspace.targets.values().collect()
        } else {
            roots
        }
    } else {
        select_targets(workspace, selectors)?
    };

    for target in targets {
        let mut visited = BTreeSet::new();
        format_dep_tree(workspace, target, "", true, &mut visited, true, None, w)?;
    }
    Ok(())
}

fn format_dep_tree(
    workspace: &Workspace,
    target: &Target,
    prefix: &str,
    is_last: bool,
    visited: &mut BTreeSet<String>,
    is_root: bool,
    edge_mode: Option<&DependencyMode>,
    w: &mut String,
) -> Result<()> {
    use std::fmt::Write;
    let already = visited.contains(&target.address);

    let mode_suffix = match edge_mode {
        Some(DependencyMode::Named(m)) => format!(" [{}]", m),
        _ => String::new(),
    };

    if is_root {
        if already {
            writeln!(w, "{}{} (*)", target.address, mode_suffix)?;
        } else {
            writeln!(w, "{}{}", target.address, mode_suffix)?;
        }
    } else {
        let marker = if is_last { "└── " } else { "├── " };
        if already {
            writeln!(
                w,
                "{}{}{}{} (*)",
                prefix, marker, target.address, mode_suffix
            )?;
        } else {
            writeln!(w, "{}{}{}{}", prefix, marker, target.address, mode_suffix)?;
        }
    }

    if already {
        return Ok(());
    }
    visited.insert(target.address.clone());

    let next_prefix = if is_root {
        String::new()
    } else {
        format!("{}{}", prefix, if is_last { "    " } else { "│   " })
    };

    let count = target.dependencies.len();
    for (i, dep) in target.dependencies.iter().enumerate() {
        let dep_is_last = i == count - 1;
        if let Some(dep_target) = workspace.targets.get(&dep.address) {
            format_dep_tree(
                workspace,
                dep_target,
                &next_prefix,
                dep_is_last,
                visited,
                false,
                Some(&dep.mode),
                w,
            )?;
        } else {
            let marker = if dep_is_last {
                "└── "
            } else {
                "├── "
            };
            let mode_sfx = match &dep.mode {
                DependencyMode::Named(m) => format!(" [{}]", m),
                DependencyMode::Auto => String::new(),
            };
            writeln!(
                w,
                "{}{}{}{} <missing>",
                next_prefix, marker, dep.address, mode_sfx
            )?;
        }
    }
    Ok(())
}

pub fn format_rules(workspace: &Workspace, w: &mut String) -> std::fmt::Result {
    use std::fmt::Write;

    // Infer known kinds from registered rules.
    let kinds: BTreeSet<&str> = workspace.rules.keys().map(|(k, _)| k.as_str()).collect();

    writeln!(w, "Target Kinds:")?;
    if kinds.is_empty() {
        writeln!(w, "  (none)")?;
    } else {
        for kind in &kinds {
            let default_prod = default_product_for_kind(workspace, kind).unwrap_or("<none>");
            writeln!(w, "  - {kind} (default product: {default_prod})")?;
        }
    }
    writeln!(w)?;
    writeln!(w, "Rules:")?;
    if workspace.rules.is_empty() {
        writeln!(w, "  (none)")?;
    } else {
        let mut current_kind: Option<&str> = Option::None;
        for ((kind, _), rule) in &workspace.rules {
            if current_kind != Some(kind.as_str()) {
                current_kind = Some(kind.as_str());
                writeln!(w, "  {kind}:")?;
            }
            let dep_prod = match &rule.dependency_product {
                DependencyProduct::None => "none".to_owned(),
                DependencyProduct::Default => "default".to_owned(),
                DependencyProduct::Named(p) => format!("\"{p}\""),
            };
            writeln!(w, "    - {}:", rule.product)?;
            writeln!(w, "        action: {}", rule.action.display)?;
            writeln!(
                w,
                "        requires own sources: {}",
                rule.requires_own_sources
            )?;
            writeln!(w, "        dependency product: {dep_prod}")?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn scope_for(root: &Path, build_file: &Path) -> Result<String> {
    let directory = build_file
        .parent()
        .ok_or_else(|| anyhow::anyhow!("{} has no parent directory", BUILD_FILE))?;
    let relative = directory
        .strip_prefix(root)
        .with_context(|| format!("{} is outside workspace", build_file.display()))?;
    if relative.as_os_str().is_empty() {
        return Ok("//".to_owned());
    }
    Ok(format!(
        "//{}",
        relative
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/")
    ))
}

fn build_module_name_for(root: &Path, build_file: &Path, scope: &str) -> Result<String> {
    if resolve_workspace_module(root, scope)
        .map(|resolution| resolution.kind == ModuleKind::Build && resolution.path == build_file)
        .unwrap_or(false)
    {
        return Ok(scope.to_owned());
    }

    let relative = build_file
        .strip_prefix(root)
        .with_context(|| format!("{} is outside workspace", build_file.display()))?;
    let mut module = relative
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/");
    if !module.ends_with(".js") {
        bail!("{} is not a JavaScript module", build_file.display());
    }
    module.truncate(module.len() - ".js".len());
    Ok(format!("//{module}"))
}

#[allow(dead_code)]
fn target_address(scope: &str, name: &str) -> Result<String> {
    if name.is_empty() || name.contains(':') || name.contains('/') {
        bail!("target name '{name}' must be a simple name");
    }
    Ok(format!("{scope}:{name}"))
}

#[allow(dead_code)]
fn parse_dependency(scope: &str, value: &str) -> Result<Dependency> {
    let value = value.strip_prefix("auto:").unwrap_or(value);
    let address = if value.starts_with("//") {
        value.to_owned()
    } else if value.starts_with(':') {
        format!("{scope}{value}")
    } else {
        bail!("dependency '{value}' must be an absolute or local target address");
    };
    Ok(Dependency {
        address,
        mode: DependencyMode::Auto,
    })
}

#[derive(Debug, Clone, Copy)]
enum ProcessStream {
    Stdout,
    Stderr,
}

struct ProcessLine {
    stream: ProcessStream,
    line: String,
}

fn spawn_output_reader<R: Read + Send + 'static>(
    reader: R,
    stream: ProcessStream,
    sender: mpsc::Sender<ProcessLine>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let reader = BufReader::new(reader);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if sender.send(ProcessLine { stream, line }).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = sender.send(ProcessLine {
                        stream: ProcessStream::Stderr,
                        line: format!("failed to read process output: {error}"),
                    });
                    break;
                }
            }
        }
    })
}

fn drain_process_lines(
    receiver: &mpsc::Receiver<ProcessLine>,
    progress: Option<&prodash::tree::Item>,
    stdout: &mut String,
    stderr: &mut String,
) {
    while let Ok(line) = receiver.try_recv() {
        record_process_line(line, progress, stdout, stderr);
    }
}

fn record_process_line(
    line: ProcessLine,
    progress: Option<&prodash::tree::Item>,
    stdout: &mut String,
    stderr: &mut String,
) {
    let level = match line.stream {
        ProcessStream::Stdout => prodash::messages::MessageLevel::Info,
        ProcessStream::Stderr => prodash::messages::MessageLevel::Failure,
    };
    if let Some(progress) = progress {
        progress.message(level, line.line.clone());
    }
    match line.stream {
        ProcessStream::Stdout => {
            stdout.push_str(&line.line);
            stdout.push('\n');
        }
        ProcessStream::Stderr => {
            stderr.push_str(&line.line);
            stderr.push('\n');
        }
    }
}

fn lower_action(
    spec: &ActionSpec,
    target: &Target,
    task_id: &str,
) -> (Action, Vec<Artifact>, Vec<Artifact>) {
    let inputs = lower_artifacts(&spec.inputs, target, task_id, "input", None);
    let outputs = lower_artifacts(&spec.outputs, target, task_id, "output", Some(task_id));
    let action = Action {
        argv: spec
            .argv
            .iter()
            .map(|value| expand_template(value, target))
            .collect(),
        cwd: spec
            .cwd
            .as_deref()
            .map(|value| expand_template(value, target)),
        env: spec
            .env
            .iter()
            .map(|(key, value)| (key.clone(), expand_template(value, target)))
            .collect(),
        platform: spec
            .platform
            .as_deref()
            .map(|value| expand_template(value, target)),
        inputs: inputs.iter().map(|artifact| artifact.id.clone()).collect(),
        outputs: outputs.iter().map(|artifact| artifact.id.clone()).collect(),
        display: expand_template(&spec.display, target),
        impure: spec.impure,
        force_cache: spec.force_cache,
    };
    (action, inputs, outputs)
}

fn lower_artifacts(
    specs: &[ArtifactSpec],
    target: &Target,
    task_id: &str,
    role: &str,
    producer: Option<&str>,
) -> Vec<Artifact> {
    specs
        .iter()
        .enumerate()
        .map(|(i, spec)| Artifact {
            id: spec
                .id
                .as_deref()
                .map(|value| expand_template(value, target))
                .unwrap_or_else(|| format!("{task_id}:{role}{i}")),
            kind: spec.kind.clone(),
            path: spec
                .path
                .as_deref()
                .map(|value| expand_template(value, target)),
            value: spec
                .value
                .as_deref()
                .map(|value| expand_template(value, target)),
            producer: producer.map(str::to_owned),
        })
        .collect()
}

fn expand_template(template: &str, target: &Target) -> String {
    let sources = target.fields.get("sources").cloned().unwrap_or_default();
    let entrypoint = target.fields.get("entrypoint").cloned().unwrap_or_default();
    let name = target.fields.get("name").cloned().unwrap_or_default();
    let path = target.fields.get("path").cloned().unwrap_or_default();
    let version = target.fields.get("version").cloned().unwrap_or_default();
    let expanded = template
        .replace("{address}", &target.address)
        .replace("{sources}", &sources)
        .replace("{entrypoint}", &entrypoint)
        .replace("{name}", &name)
        .replace("{path}", &path)
        .replace("{version}", &version);
    target
        .fields
        .iter()
        .fold(expanded, |expanded, (field, value)| {
            expanded.replace(&format!("{{{field}}}"), value)
        })
}

fn dot_escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

// ---------------------------------------------------------------------------
// Exec context for rule exec() functions
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct ExecRunResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

struct ExecRunOpts {
    argv: Vec<String>,
    display: String,
    env: BTreeMap<String, String>,
    inputs: Vec<ExecIoSpec>,
    outputs: Vec<ExecIoSpec>,
    tools: Vec<ExecToolSpec>,
    impure: bool,
    force_cache: bool,
}

struct ExecIoSpec {
    path: String,
    kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct ExecToolSpec {
    name: String,
    cache: String,
    key: String,
    path: PathBuf,
    bin_dirs: Vec<String>,
}

/// Build a JS `ctx` object for `exec(target, ctx)` functions.
///
/// The returned object provides:
/// * `ctx.platform` — `{ os, arch }`
/// * `ctx.run(opts)` — cached subprocess execution
/// * `ctx.output(value)` — records a string value produced by this exec task
/// * `ctx.tool(spec)` — resolves a named-cache-backed tool descriptor
/// * `ctx.inSandbox(opts)` — cached subprocess execution with tool PATH setup
pub(super) fn build_exec_ctx<'js>(
    ctx: Ctx<'js>,
    workspace_root: &Path,
    output_cell: Arc<Mutex<Option<String>>>,
) -> rquickjs::Result<Object<'js>> {
    let obj = Object::new(ctx.clone())?;

    // output method — records a string value produced by this exec task
    let output_fn = Function::new(
        ctx.clone(),
        move |value: String| -> rquickjs::Result<()> {
            *output_cell.lock().unwrap() = Some(value);
            Ok(())
        },
    )?;
    obj.set("output", output_fn)?;

    // platform property
    let (os, arch) = toolchain::host_detect_platform()
        .map_err(|e| rquickjs::Error::new_loading_message("platform", format!("{e:#}")))?;
    let plat = Object::new(ctx.clone())?;
    plat.set("os", &*os)?;
    plat.set("arch", &*arch)?;
    obj.set("platform", plat)?;

    // tool method
    let tool_workspace = workspace_root.to_owned();
    let tool_fn = Function::new(
        ctx.clone(),
        move |ctx: Ctx<'js>, spec: Object<'js>| -> rquickjs::Result<Object<'js>> {
            let name: String = spec.get("name")?;
            let cache: String = spec.get("cache")?;
            let key: String = spec.get("key")?;
            let bin_dirs: Option<Vec<String>> = spec.get("binDirs")?;
            let bin_dirs = bin_dirs.unwrap_or_else(|| vec!["bin".to_owned()]);
            let path = named_cache_key_path(&tool_workspace, &cache, &key)
                .map_err(|e| rquickjs::Error::new_loading_message("tool", format!("{e:#}")))?;
            if !path.is_dir() {
                return Err(rquickjs::Error::new_loading_message(
                    "tool",
                    format!(
                        "tool {name} is not installed in named cache {cache}/{key} ({})",
                        path.display()
                    ),
                ));
            }

            let tool = Object::new(ctx.clone())?;
            tool.set("kind", "tool")?;
            tool.set("name", name)?;
            tool.set("cache", cache)?;
            tool.set("key", key)?;
            tool.set("path", path.to_string_lossy().as_ref())?;
            let dirs = Array::new(ctx)?;
            for (i, dir) in bin_dirs.iter().enumerate() {
                dirs.set(i, dir.as_str())?;
            }
            tool.set("binDirs", dirs)?;
            Ok(tool)
        },
    )?;
    obj.set("tool", tool_fn)?;

    // run/inSandbox method
    let wr = workspace_root.to_owned();
    let run_fn = Function::new(
        ctx.clone(),
        move |ctx: Ctx<'js>, opts: Object<'js>| -> rquickjs::Result<Object<'js>> {
            let argv: Vec<String> = opts.get("argv")?;
            let display: Option<String> = opts.get("display")?;
            let display = display.unwrap_or_else(|| argv.join(" "));
            let env_obj: Option<Object<'js>> = opts.get("env")?;
            let mut env = BTreeMap::new();
            if let Some(e) = env_obj {
                for entry in e.own_props::<String, String>(Filter::default()) {
                    let (k, v) = entry?;
                    env.insert(k, v);
                }
            }
            let inputs = parse_io_specs(
                opts.get::<_, Option<Vec<Object>>>("inputs")?
                    .unwrap_or_default(),
            )?;
            let outputs = parse_io_specs(
                opts.get::<_, Option<Vec<Object>>>("outputs")?
                    .unwrap_or_default(),
            )?;
            let tools = parse_tool_specs(
                opts.get::<_, Option<Vec<Object>>>("tools")?
                    .unwrap_or_default(),
            )?;
            let impure: Option<bool> = opts.get("impure")?;
            let impure = impure.unwrap_or(false);
            let force_cache: Option<bool> = opts.get("forceCache")?;
            let force_cache = force_cache.unwrap_or(false);

            let run_opts = ExecRunOpts {
                argv,
                display,
                env,
                inputs,
                outputs,
                tools,
                impure,
                force_cache,
            };

            let result = exec_run_inner(&wr, run_opts)
                .map_err(|e| rquickjs::Error::new_loading_message("run", format!("{e:#}")))?;

            let obj = Object::new(ctx)?;
            obj.set("stdout", &result.stdout)?;
            obj.set("stderr", &result.stderr)?;
            obj.set("exitCode", result.exit_code)?;
            Ok(obj)
        },
    )?;
    obj.set("run", run_fn.clone())?;
    obj.set("inSandbox", run_fn)?;

    Ok(obj)
}

fn parse_io_specs<'js>(vals: Vec<Object<'js>>) -> rquickjs::Result<Vec<ExecIoSpec>> {
    let mut specs = Vec::new();
    for val in vals {
        let path: Option<String> = val.get("path")?;
        let Some(path) = path else {
            continue;
        };
        let kind: Option<String> = val.get("kind")?;
        let kind = kind.unwrap_or_else(|| "file".to_owned());
        specs.push(ExecIoSpec { path, kind });
    }
    Ok(specs)
}

fn parse_tool_specs<'js>(vals: Vec<Object<'js>>) -> rquickjs::Result<Vec<ExecToolSpec>> {
    let mut specs = Vec::new();
    for val in vals {
        let name: Option<String> = val.get("name")?;
        let Some(name) = name else {
            continue;
        };
        let cache: String = val.get("cache")?;
        let key: String = val.get("key")?;
        let path: String = val.get("path")?;
        let bin_dirs: Option<Vec<String>> = val.get("binDirs")?;
        specs.push(ExecToolSpec {
            name,
            cache,
            key,
            path: PathBuf::from(path),
            bin_dirs: bin_dirs.unwrap_or_else(|| vec!["bin".to_owned()]),
        });
    }
    Ok(specs)
}

fn materialize_tools_into_sandbox(
    tools: &[ExecToolSpec],
    sandbox_root: &Path,
) -> Result<Vec<PathBuf>> {
    let tools_root = sandbox_root.join(".imp").join("tools");
    let mut path_entries = Vec::new();

    for tool in tools {
        validate_tool_name(&tool.name)?;
        if !tool.path.is_dir() {
            bail!(
                "tool {} cache path {} is not a directory",
                tool.name,
                tool.path.display()
            );
        }

        std::fs::create_dir_all(&tools_root)
            .with_context(|| format!("create {}", tools_root.display()))?;
        let sandbox_tool_root = tools_root.join(&tool.name);
        symlink_tool_root(&tool.path, &sandbox_tool_root)?;

        for bin_dir in &tool.bin_dirs {
            path_entries.push(resolve_tool_bin_dir(&sandbox_tool_root, bin_dir)?);
        }
    }

    Ok(path_entries)
}

fn validate_tool_name(name: &str) -> Result<()> {
    if name.is_empty()
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        bail!("tool name '{name}' must contain only ASCII letters, digits, '-', '_' or '.'");
    }
    Ok(())
}

#[cfg(unix)]
fn symlink_tool_root(source: &Path, destination: &Path) -> Result<()> {
    std::os::unix::fs::symlink(source, destination)
        .with_context(|| format!("symlink {} -> {}", destination.display(), source.display()))
}

#[cfg(not(unix))]
fn symlink_tool_root(source: &Path, destination: &Path) -> Result<()> {
    copy_directory(source, destination)
}

fn resolve_tool_bin_dir(tool_root: &Path, bin_dir: &str) -> Result<PathBuf> {
    if bin_dir == "." {
        return Ok(tool_root.to_owned());
    }
    if bin_dir.is_empty() {
        bail!("tool binDir must not be empty");
    }
    let relative = artifact_relative_path(bin_dir)?;
    Ok(tool_root.join(relative))
}

fn sandbox_command_env(
    env: &BTreeMap<String, String>,
    tool_path_entries: &[PathBuf],
) -> Result<BTreeMap<String, String>> {
    let mut command_env = env.clone();
    if tool_path_entries.is_empty() {
        return Ok(command_env);
    }

    let mut entries = tool_path_entries.to_vec();
    if let Some(existing) = env.get("PATH") {
        entries.extend(std::env::split_paths(existing));
    } else if let Some(existing) = std::env::var_os("PATH") {
        entries.extend(std::env::split_paths(&existing));
    }
    let joined = std::env::join_paths(entries).context("join tool PATH entries")?;
    command_env.insert("PATH".to_owned(), joined.to_string_lossy().into_owned());
    Ok(command_env)
}

fn exec_run_inner(workspace_root: &Path, opts: ExecRunOpts) -> Result<ExecRunResult> {
    let sandbox_root = create_sandbox_root()?;
    let tool_path_entries = materialize_tools_into_sandbox(&opts.tools, &sandbox_root)?;

    // Copy inputs into sandbox.
    for input in &opts.inputs {
        let relative = artifact_relative_path(&input.path)?;
        let source = workspace_root.join(&relative);
        let sandbox_path = sandbox_root.join(&relative);
        if let Some(parent) = sandbox_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        match input.kind.as_str() {
            "file" | "manifest" => copy_file(&source, &sandbox_path)?,
            "directory" => copy_directory(&source, &sandbox_path)?,
            other => bail!("run() input {} has unsupported kind {other}", input.path),
        }
    }

    // Compute input digests.
    let mut input_digests = Vec::new();
    for input in &opts.inputs {
        let relative = artifact_relative_path(&input.path)?;
        let sandbox_path = sandbox_root.join(&relative);
        let (digest, kind) = match input.kind.as_str() {
            "file" | "manifest" => {
                let (d, _) = store_file_blob(&sandbox_path, &input.kind)?;
                (d, input.kind.clone())
            }
            "directory" => {
                let entries = directory_entries(&sandbox_path)?;
                (digest_json(&entries)?, "directory".to_owned())
            }
            other => bail!("run() input {} has unsupported kind {other}", input.path),
        };
        input_digests.push(CacheInputDigest {
            artifact_id: input.path.clone(),
            kind,
            path: Some(input.path.clone()),
            value: None,
            digest,
        });
    }

    // Compute action digest.
    let action_digest = digest_json(&serde_json::json!({
        "argv": opts.argv,
        "env": opts.env,
        "display": opts.display,
        "tools": opts.tools,
    }))?;

    // Compute task key.
    let out_specs: Vec<serde_json::Value> = opts
        .outputs
        .iter()
        .map(|o| serde_json::json!({ "path": o.path, "kind": o.kind }))
        .collect();
    let task_key = digest_json(&serde_json::json!({
        "version": 1,
        "action_digest": action_digest,
        "input_digests": input_digests,
        "outputs": out_specs,
    }))?;

    // Check cache.
    let cacheable = !opts.impure || opts.force_cache;
    let record_path = task_record_path(&task_key)?;
    let cached_outputs_opt: Option<Vec<CachedArtifact>> = if cacheable {
        match std::fs::read_to_string(&record_path) {
            Ok(encoded) => {
                let record: TaskCacheRecord =
                    serde_json::from_str(&encoded).with_context(|| {
                        format!("parse exec cache record {}", record_path.display())
                    })?;
                match cached_outputs_present(&record) {
                    Ok(()) => Some(record.outputs),
                    Err(_) => None,
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                return Err(e).with_context(|| format!("read {}", record_path.display()));
            }
        }
    } else {
        None
    };

    if let Some(outputs) = cached_outputs_opt {
        let record = TaskCacheRecord {
            version: 1,
            task_id: task_key.clone(),
            task_key,
            action_digest,
            input_digests,
            dependency_keys: vec![],
            named_caches: vec![],
            outputs,
        };
        materialize_cached_outputs(&record, workspace_root)?;
        return Ok(ExecRunResult {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: 0,
        });
    }

    // Cache miss — run the command.
    let (program, args) = opts
        .argv
        .split_first()
        .ok_or_else(|| anyhow::anyhow!("run() argv must not be empty"))?;

    let command_env = sandbox_command_env(&opts.env, &tool_path_entries)?;
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(&sandbox_root)
        .envs(&command_env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);

    let mut child = command
        .spawn()
        .with_context(|| format!("run() command in {}", sandbox_root.display()))?;

    let stdout_handle = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("run() stdout was not piped"))?;
    let stderr_handle = child
        .stderr
        .take()
        .ok_or_else(|| anyhow::anyhow!("run() stderr was not piped"))?;

    let (sender, receiver) = mpsc::channel();
    let stdout_reader = spawn_output_reader(stdout_handle, ProcessStream::Stdout, sender.clone());
    let stderr_reader = spawn_output_reader(stderr_handle, ProcessStream::Stderr, sender);

    let mut stdout = String::new();
    let mut stderr = String::new();
    let status = loop {
        drain_process_lines(&receiver, None, &mut stdout, &mut stderr);
        if let Some(status) = child
            .try_wait()
            .with_context(|| format!("wait for {}", opts.display))?
        {
            break status;
        }
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(line) => record_process_line(line, None, &mut stdout, &mut stderr),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {}
        }
    };

    let _ = stdout_reader.join();
    let _ = stderr_reader.join();
    drain_process_lines(&receiver, None, &mut stdout, &mut stderr);

    let exit_code = status.code().unwrap_or(-1);
    if !status.success() {
        bail!(
            "{} failed with exit code {}\nstdout:\n{}\nstderr:\n{}",
            opts.display,
            exit_code,
            stdout.trim_end(),
            stderr.trim_end()
        );
    }

    // Ingest outputs into CAS.
    let mut cached_outputs = Vec::new();
    for output in &opts.outputs {
        let relative = artifact_relative_path(&output.path)?;
        let sandbox_path = sandbox_root.join(&relative);
        match output.kind.as_str() {
            "file" | "manifest" => {
                if !sandbox_path.is_file() {
                    bail!(
                        "run() output {} was not created as a file in sandbox",
                        output.path
                    );
                }
                let (digest, bytes) = store_file_blob(&sandbox_path, &output.kind)?;
                cached_outputs.push(CachedArtifact {
                    artifact_id: output.path.clone(),
                    kind: output.kind.clone(),
                    path: Some(output.path.clone()),
                    value: None,
                    digest,
                    bytes: Some(bytes),
                    files: Vec::new(),
                });
            }
            "directory" => {
                if !sandbox_path.is_dir() {
                    bail!(
                        "run() output {} was not created as a directory in sandbox",
                        output.path
                    );
                }
                let files = directory_entries(&sandbox_path)?;
                let digest = digest_json(&files)?;
                cached_outputs.push(CachedArtifact {
                    artifact_id: output.path.clone(),
                    kind: output.kind.clone(),
                    path: Some(output.path.clone()),
                    value: None,
                    digest,
                    bytes: None,
                    files,
                });
            }
            other => bail!("run() output {} has unsupported kind {other}", output.path),
        }
    }

    // Cache record and materialize.
    if cacheable {
        let record = TaskCacheRecord {
            version: 1,
            task_id: task_key.clone(),
            task_key,
            action_digest,
            input_digests,
            dependency_keys: vec![],
            named_caches: vec![],
            outputs: cached_outputs,
        };
        write_task_cache_record(&record)?;
        materialize_cached_outputs(&record, workspace_root)?;
    }

    Ok(ExecRunResult {
        stdout,
        stderr,
        exit_code,
    })
}

/// Build a JS `target` object for an `exec(target, ctx)` call.
fn build_exec_target<'js>(
    ctx: Ctx<'js>,
    task: &Task,
    dep_values: &[String],
) -> rquickjs::Result<Object<'js>> {
    if task.is_product {
        // Product functions receive the target handle ({ __imp: true, __id: N })
        // rather than the task context object used by rule exec functions.
        let obj = Object::new(ctx.clone())?;
        obj.set("__imp", true)?;
        obj.set("__id", task.js_id)?;
        return Ok(obj);
    }
    let obj = Object::new(ctx.clone())?;
    obj.set("id", task.id.as_str())?;
    obj.set("target", task.target.as_str())?;
    obj.set("product", task.product.as_str())?;
    let fields = Object::new(ctx.clone())?;
    for (k, v) in &task.fields {
        fields.set(k.as_str(), v.as_str())?;
    }
    obj.set("fields", fields)?;
    let dep_outputs = Array::new(ctx)?;
    for (i, v) in dep_values.iter().enumerate() {
        dep_outputs.set(i, v.as_str())?;
    }
    obj.set("depOutputs", dep_outputs)?;
    Ok(obj)
}

/// Execute a task whose rule has an `exec` function.
///
/// The exec function is looked up from the QuickJS globals (registered during
/// workspace loading) and called with a `target` and `ctx` JS object.
/// Returns `(execution, summary, output_value)` where `output_value` is the
/// string produced by `ctx.output(...)`, if any.
fn execute_task_with_exec(
    task: &Task,
    live: &LiveWorkspace,
    workspace_root: &Path,
    dep_values: &[String],
) -> Result<(TaskExecution, TaskCacheSummary, Option<String>)> {
    let exec_fn_name = task
        .exec_fn
        .as_deref()
        .expect("execute_task_with_exec called on task without exec_fn");

    let output_cell: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    // Make the workspace root accessible to __host_run, __host_glob, etc.
    *live.exec_root.lock().unwrap() = Some(workspace_root.to_owned());

    let ctx_guard = live.ctx.lock().unwrap();
    let eval_result = ctx_guard
        .with(|ctx| -> rquickjs::Result<()> {
            let exec_fn: Function = ctx.globals().get(exec_fn_name)?;
            let target_obj = build_exec_target(ctx.clone(), task, dep_values)?;
            let result: MaybePromise = if task.is_product {
                // Product functions take only the target handle; no exec ctx needed.
                exec_fn
                    .call((target_obj,))
                    .catch(&ctx)
                    .map_err(|e| rquickjs::Error::new_loading_message("exec", format!("{e}")))?
            } else {
                let ctx_obj =
                    build_exec_ctx(ctx.clone(), workspace_root, Arc::clone(&output_cell))?;
                exec_fn
                    .call((target_obj, ctx_obj))
                    .catch(&ctx)
                    .map_err(|e| rquickjs::Error::new_loading_message("exec", format!("{e}")))?
            };
            result
                .finish::<()>()
                .catch(&ctx)
                .map_err(|e| rquickjs::Error::new_loading_message("exec", format!("{e}")))?;
            Ok(())
        })
        .map_err(|e| {
            anyhow::anyhow!("exec function '{exec_fn_name}' failed for {}: {e}", task.id)
        });
    drop(ctx_guard);
    *live.exec_root.lock().unwrap() = None;
    eval_result?;

    let output_value = output_cell.lock().unwrap().take();
    let task_key = digest_bytes(task.id.as_bytes());
    Ok((
        TaskExecution {
            task_id: task.id.clone(),
            status: TaskExecutionStatus::Ran,
            command: task.action.argv.clone(),
        },
        TaskCacheSummary {
            task_id: task.id.clone(),
            task_key,
        },
        output_value,
    ))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // ---- Common rule JS strings ----------------------------------------

    const CPP_RULES_JS: &str = r#"
import { target, rule } from "imp:core";

function snapshotSourcesExec(target, ctx) {}
function cmakeBuildExec(target, ctx) {}

rule({ kind: "cpp-sources",  product: "sources",             action: "snapshot {sources}",        exec: snapshotSourcesExec, requiresOwnSources: false, dependencyProduct: null });
rule({ kind: "cmake-lib",    product: "native-link-library", action: "cmake --build {entrypoint}", exec: cmakeBuildExec, requiresOwnSources: false, dependencyProduct: "sources" });

export function cppSources({ srcs }) {
    return target({ kind: "cpp-sources", fields: { sources: srcs.join(",") } });
}
export function cmakeLib({ entrypoint, deps = [] }) {
    return target({ kind: "cmake-lib", fields: { entrypoint }, deps });
}
"#;

    const ODIN_RULES_JS: &str = r#"
import { target, rule } from "imp:core";

function snapshotSourcesExec(target, ctx) {}
function odinBuildExec(target, ctx) {}

rule({ kind: "odin-package", product: "sources",      action: "snapshot {sources}", exec: snapshotSourcesExec, requiresOwnSources: false, dependencyProduct: null });
rule({ kind: "odin-package", product: "odin-package", action: "odin build",         exec: odinBuildExec, requiresOwnSources: true,  dependencyProduct: "default" });

export function odinPackage({ srcs, deps = [] }) {
    return target({ kind: "odin-package", fields: { sources: srcs.join(",") }, deps });
}
"#;

    const ASSET_RULES_JS: &str = r#"
import { target, rule } from "imp:core";

function snapshotSourcesExec(target, ctx) {}
function bundleExec(target, ctx) {}

rule({ kind: "asset", product: "sources", action: "snapshot {sources}", exec: snapshotSourcesExec, requiresOwnSources: false, dependencyProduct: null });
rule({ kind: "asset", product: "bundle",  action: "bundle {sources}",   exec: bundleExec, requiresOwnSources: true,  dependencyProduct: null });

export function asset({ srcs }) {
    return target({ kind: "asset", fields: { sources: srcs.join(",") } });
}
"#;

    // ---- Fixture -------------------------------------------------------

    fn fixture() -> TempDir {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        // imp.workspace.js
        std::fs::write(
            p.join(WORKSPACE_FILE),
            r#"
import "//rules/c/cmake";
import "//rules/odin";
import "//rules/asset";
"#,
        )
        .unwrap();

        let rules = p.join("rules");
        std::fs::create_dir_all(&rules).unwrap();
        std::fs::create_dir_all(rules.join("c/cmake")).unwrap();
        std::fs::write(rules.join("c/cmake/index.js"), CPP_RULES_JS).unwrap();
        std::fs::write(rules.join("odin.js"), ODIN_RULES_JS).unwrap();
        std::fs::write(rules.join("asset.js"), ASSET_RULES_JS).unwrap();

        // src/cpp/joltphysics/BUILD.js
        let cpp = p.join("src/cpp/joltphysics");
        std::fs::create_dir_all(&cpp).unwrap();
        std::fs::write(
            cpp.join(BUILD_FILE),
            r#"
import { cppSources, cmakeLib } from "//rules/c/cmake";

export const joltphysics = cppSources({ srcs: ["**/*.h", "**/*.cpp"] });
export const cmake = cmakeLib({ entrypoint: "CMakeLists.txt", deps: [joltphysics] });
"#,
        )
        .unwrap();

        // library/jodin/BUILD.js
        let odin = p.join("library/jodin");
        std::fs::create_dir_all(&odin).unwrap();
        std::fs::write(
            odin.join(BUILD_FILE),
            r#"
import { odinPackage } from "//rules/odin";
import { cmake } from "//src/cpp/joltphysics";

export const jodin = odinPackage({ srcs: ["*.odin"], deps: [cmake] });
"#,
        )
        .unwrap();

        // assets/BUILD.js
        let assets = p.join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(
            assets.join(BUILD_FILE),
            r#"
import { asset } from "//rules/asset";

export const ui = asset({ srcs: ["**/*.png"] });
"#,
        )
        .unwrap();

        root
    }

    fn write_file(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }

    fn js_string_path(path: &Path) -> String {
        path.to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
    }

    fn executable_task(id: &str, deps: &[&str], argv: &[&str], output: Option<&str>) -> Task {
        let outputs = output
            .map(|path| {
                vec![Artifact {
                    id: format!("{id}:out"),
                    kind: "file".to_owned(),
                    path: Some(path.to_owned()),
                    value: None,
                    producer: Some(id.to_owned()),
                }]
            })
            .unwrap_or_default();

        Task {
            id: id.to_owned(),
            target: "//:fixture".to_owned(),
            product: "fixture".to_owned(),
            fields: BTreeMap::new(),
            inputs: Vec::new(),
            action: Action {
                argv: argv.iter().map(|arg| (*arg).to_owned()).collect(),
                cwd: None,
                env: BTreeMap::new(),
                platform: None,
                inputs: Vec::new(),
                outputs: outputs.iter().map(|artifact| artifact.id.clone()).collect(),
                display: argv.join(" "),
                impure: false,
                force_cache: false,
            },
            exec_fn: None,
            outputs,
            dependencies: deps.iter().map(|dep| (*dep).to_owned()).collect(),
            js_id: 0,
            is_product: false,
        }
    }

    fn unique_task_id(prefix: &str) -> String {
        format!(
            "{prefix}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }

    // ---- Tests ---------------------------------------------------------

    #[test]
    fn workspace_loads_config_before_build_files() {
        let root = fixture();
        let workspace = load_workspace(root.path()).unwrap();

        // Rules registered by workspace.js imports.
        assert!(workspace
            .rules
            .contains_key(&("odin-package".into(), "odin-package".into())));
        assert!(workspace
            .rules
            .contains_key(&("asset".into(), "bundle".into())));

        // Targets declared by BUILD.js files.
        assert!(workspace
            .targets
            .contains_key("//src/cpp/joltphysics:joltphysics"));
        assert_eq!(
            workspace.targets["//src/cpp/joltphysics:cmake"].dependencies[0].address,
            "//src/cpp/joltphysics:joltphysics"
        );
        assert!(workspace.targets.contains_key("//library/jodin:jodin"));
    }

    #[test]
    fn workspace_can_mount_external_rule_packages() {
        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let p = root.path();
        let external_rules = external.path().join("rules");

        write_file(
            &external_rules.join("external/helper.js"),
            r#"
export const actionName = "external build {address}";
"#,
        );
        write_file(
            &external_rules.join("external/index.js"),
            r#"
import { target, rule } from "imp:core";
import { actionName } from "//rules/external/helper";

rule({ kind: "external", product: "external-product", action: actionName, requiresOwnSources: false, dependencyProduct: null });

export function externalThing(name) {
    return target({ kind: "external", fields: { name } });
}
"#,
        );

        write_file(
            &p.join(WORKSPACE_FILE),
            &format!(
                r#"
import {{ workspaceMount }} from "imp:core";

workspaceMount({{ prefix: "//rules", path: "{rules}" }});
await import("//rules/external");
"#,
                rules = js_string_path(&external_rules),
            ),
        );
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { externalThing } from "//rules/external";

export const app = externalThing("app");
"#,
        );

        let workspace = load_workspace(p).unwrap();
        assert!(workspace
            .rules
            .contains_key(&("external".into(), "external-product".into())));
        assert_eq!(workspace.targets["//:app"].fields["name"], "app");

        let plan = plan(&workspace, "build", &["app".into()]).unwrap();
        assert_eq!(plan.roots, ["//:app#external-product"]);
        assert_eq!(plan.tasks[0].action.display, "external build //:app");
    }

    #[test]
    fn implicit_dependency_targets_are_materialized() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let repo_rules = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("rules");

        write_file(&p.join("app/main.odin"), "package app\n");
        write_file(
            &p.join(WORKSPACE_FILE),
            &format!(
                r#"
import {{ workspaceMount }} from "imp:core";

workspaceMount({{ prefix: "//rules", path: "{rules}" }});
await import("//rules/odin");
"#,
                rules = js_string_path(&repo_rules),
            ),
        );
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { odinPackage } from "//rules/odin";

export const app = odinPackage({
    path: "app",
    srcs: ["^app/.*\\.odin$"],
    toolchain: "dev-2026-05",
});
"#,
        );

        let workspace = load_workspace(p).unwrap();
        let source_address = &workspace.targets["//:app"].dependencies[0].address;
        let source_target = &workspace.targets[source_address];
        assert_eq!(source_target.kind, "source-set");
        assert_eq!(source_target.fields["files"], "app/main.odin");

        let plan = plan(&workspace, "build", &["app".into()]).unwrap();
        let source_task = plan
            .tasks
            .iter()
            .find(|task| task.target == *source_address && task.product == "sources")
            .unwrap();
        // source-set tasks now produce tree digests via exec, not manifest file outputs
        assert!(source_task.exec_fn.is_some());
        assert!(source_task.outputs.is_empty());
    }

    #[test]
    fn workspace_root_is_discovered_from_a_nested_directory() {
        let root = fixture();
        let nested = root.path().join("library/jodin");
        assert_eq!(find_workspace_root(&nested).unwrap(), root.path());
    }

    #[test]
    fn build_goal_plans_transitive_products() {
        let root = fixture();
        let workspace = load_workspace(root.path()).unwrap();
        let plan = plan(&workspace, "build", &["//library/jodin:jodin".into()]).unwrap();

        assert_eq!(plan.roots, ["//library/jodin:jodin#odin-package"]);
        assert_eq!(plan.tasks.len(), 4);

        let jodin = plan
            .tasks
            .iter()
            .find(|t| t.id == "//library/jodin:jodin#odin-package")
            .unwrap();
        assert_eq!(
            jodin.dependencies,
            [
                "//library/jodin:jodin#sources",
                "//src/cpp/joltphysics:cmake#native-link-library",
            ]
        );
    }

    #[test]
    fn odin_collections_are_namespace_config_not_package_sets() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import "//rules/odin";
"#,
        );
        write_file(
            &p.join("rules/odin.js"),
            r#"
import { target, rule } from "imp:core";

rule({ kind: "odin-collection", product: "collection", action: "odin collection {name}={path}", requiresOwnSources: false, dependencyProduct: null });
rule({ kind: "odin-package", product: "sources", action: "snapshot {sources}", requiresOwnSources: false, dependencyProduct: null });
rule({ kind: "odin-package", product: "odin-package", action: "odin build", requiresOwnSources: true, dependencyProduct: "default" });

export function odinCollection({ name, path }) {
    return target({ kind: "odin-collection", fields: { name, path } });
}

export function odinPackage({ srcs, collections = [] }) {
    const collectionDeps = collections.map((collection) => ({ target: collection, mode: "collection" }));
    return target({ kind: "odin-package", fields: { sources: srcs.join(",") }, deps: collectionDeps });
}
"#,
        );
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { odinCollection, odinPackage } from "//rules/odin";

export const lib = odinCollection({ name: "lib", path: "library" });
export const pkg = odinPackage({ srcs: ["*.odin"], collections: [lib] });
"#,
        );

        let workspace = load_workspace(p).unwrap();
        let pkg_plan = plan(&workspace, "build", &["pkg".into()]).unwrap();

        let collection = pkg_plan
            .tasks
            .iter()
            .find(|task| task.id == "//:lib#collection")
            .unwrap();
        assert_eq!(collection.dependencies, Vec::<String>::new());
        assert_eq!(collection.action.display, "odin collection lib=library");

        let package = pkg_plan
            .tasks
            .iter()
            .find(|task| task.id == "//:pkg#odin-package")
            .unwrap();
        assert_eq!(
            package.dependencies,
            ["//:pkg#sources", "//:lib#collection"]
        );

        let all = plan(&workspace, "build", &[]).unwrap();
        assert_eq!(all.roots, ["//:pkg#odin-package"]);
    }

    #[test]
    fn new_target_kinds_and_rules_need_no_rust_changes() {
        let root = fixture();
        let workspace = load_workspace(root.path()).unwrap();
        let plan = plan(&workspace, "build", &["//assets:ui".into()]).unwrap();

        assert_eq!(plan.roots, ["//assets:ui#bundle"]);
        assert_eq!(plan.tasks.len(), 2);
        assert!(plan
            .tasks
            .iter()
            .any(|t| t.action.display.contains("**/*.png")));
    }

    #[test]
    fn legacy_action_plans_round_trip_through_json() {
        let root = fixture();
        let workspace = load_workspace(root.path()).unwrap();
        let plan = plan(&workspace, "build", &["jodin".into()]).unwrap();

        let encoded = serde_json::to_string_pretty(&plan).unwrap();
        assert!(encoded.contains("\"goal\": \"build\""));
        assert!(encoded.contains("\"display\": \"odin build\""));

        let decoded: Plan = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, plan);
        assert_eq!(render_dot(&decoded), render_dot(&plan));
    }

    #[test]
    fn structured_rule_actions_lower_to_serializable_tasks() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import "//rules/generator";
"#,
        );
        write_file(
            &p.join("rules/generator.js"),
            r#"
import { target, rule } from "imp:core";

rule({
  kind: "generator",
  product: "generated",
  action: {
    argv: ["gen-tool", "{sources}"],
    cwd: "{entrypoint}",
    env: { TARGET: "{address}" },
    platform: "local",
    inputs: [{ kind: "file", path: "{sources}" }],
    outputs: [{ id: "{address}#out", kind: "file", path: "build/{entrypoint}.out" }],
    display: "generate {sources}"
  }
});

export function generator({ srcs, entrypoint }) {
  return target({ kind: "generator", fields: { sources: srcs.join(","), entrypoint } });
}
"#,
        );
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { generator } from "//rules/generator";

export const schema = generator({ srcs: ["schema.idl"], entrypoint: "schemas" });
"#,
        );

        let workspace = load_workspace(p).unwrap();
        let plan = plan(&workspace, "build", &["schema".into()]).unwrap();
        let task = plan
            .tasks
            .iter()
            .find(|task| task.id == "//:schema#generated")
            .unwrap();

        assert_eq!(task.action.argv, ["gen-tool", "schema.idl"]);
        assert_eq!(task.action.cwd.as_deref(), Some("schemas"));
        assert_eq!(task.action.env["TARGET"], "//:schema");
        assert_eq!(task.action.platform.as_deref(), Some("local"));
        assert_eq!(task.action.display, "generate schema.idl");
        assert_eq!(task.inputs[0].id, "//:schema#generated:input0");
        assert_eq!(task.inputs[0].kind, "file");
        assert_eq!(task.inputs[0].path.as_deref(), Some("schema.idl"));
        assert_eq!(task.inputs[0].producer, None);
        assert_eq!(task.outputs[0].id, "//:schema#out");
        assert_eq!(task.outputs[0].path.as_deref(), Some("build/schemas.out"));
        assert_eq!(
            task.outputs[0].producer.as_deref(),
            Some("//:schema#generated")
        );
        assert_eq!(task.action.inputs, ["//:schema#generated:input0"]);
        assert_eq!(task.action.outputs, ["//:schema#out"]);
    }

    #[test]
    fn dry_run_executor_uses_dependency_order_without_running_commands() {
        let root = tempfile::tempdir().unwrap();
        let plan = Plan {
            goal: "build".to_owned(),
            roots: vec!["consumer".to_owned()],
            named_caches: Vec::new(),
            tasks: vec![
                executable_task("consumer", &["producer"], &["sh", "-c", "exit 1"], None),
                executable_task("producer", &[], &["sh", "-c", "exit 1"], None),
            ],
        };

        let report = execute_plan(&plan, root.path(), ExecutionMode::DryRun).unwrap();
        let ids: Vec<_> = report
            .tasks
            .iter()
            .map(|execution| execution.task_id.as_str())
            .collect();
        assert_eq!(ids, ["producer", "consumer"]);
        assert!(report
            .tasks
            .iter()
            .all(|execution| execution.status == TaskExecutionStatus::WouldRun));
    }

    #[test]
    fn local_executor_materializes_embedded_manifest_outputs() {
        let root = tempfile::tempdir().unwrap();
        let task_id = unique_task_id("source-manifest");
        let mut task = executable_task(&task_id, &[], &[], None);
        task.outputs = vec![Artifact {
            id: format!("{task_id}:manifest"),
            kind: "manifest".to_owned(),
            path: Some(".imp/sources/app.json".to_owned()),
            value: Some("{\"files\":[\"app/main.odin\"]}\n".to_owned()),
            producer: Some(task_id.clone()),
        }];
        task.action.outputs = task
            .outputs
            .iter()
            .map(|artifact| artifact.id.clone())
            .collect();

        let plan = Plan {
            goal: "build".to_owned(),
            roots: vec![task_id.clone()],
            named_caches: Vec::new(),
            tasks: vec![task],
        };

        let report = execute_plan(&plan, root.path(), ExecutionMode::Local).unwrap();
        assert_eq!(report.tasks[0].status, TaskExecutionStatus::Ran);
        assert_eq!(
            std::fs::read_to_string(root.path().join(".imp/sources/app.json")).unwrap(),
            "{\"files\":[\"app/main.odin\"]}\n"
        );
    }

    #[test]
    fn parallel_executor_runs_independent_ready_tasks() {
        let root = tempfile::tempdir().unwrap();
        let first_id = unique_task_id("parallel-a");
        let second_id = unique_task_id("parallel-b");
        let plan = Plan {
            goal: "build".to_owned(),
            roots: vec![first_id.clone(), second_id.clone()],
            named_caches: Vec::new(),
            tasks: vec![
                executable_task(
                    &first_id,
                    &[],
                    &["sh", "-c", "mkdir -p build && printf a > build/a.txt"],
                    Some("build/a.txt"),
                ),
                executable_task(
                    &second_id,
                    &[],
                    &["sh", "-c", "mkdir -p build && printf b > build/b.txt"],
                    Some("build/b.txt"),
                ),
            ],
        };

        let report = execute_plan_with_options(
            &plan,
            None,
            root.path(),
            ExecutionOptions::new(ExecutionMode::Local, 2),
            None,
        )
        .unwrap();
        let ids: Vec<_> = report
            .tasks
            .iter()
            .map(|execution| execution.task_id.as_str())
            .collect();
        assert_eq!(ids, [first_id.as_str(), second_id.as_str()]);
        assert_eq!(
            std::fs::read_to_string(root.path().join("build/a.txt")).unwrap(),
            "a"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("build/b.txt")).unwrap(),
            "b"
        );
    }

    #[test]
    fn parallel_executor_waits_for_dependencies() {
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("producer.marker");
        let producer_id = unique_task_id("producer");
        let consumer_id = unique_task_id("consumer");
        let producer_cmd = format!("sleep 0.05 && printf ready > {}", marker.display());
        let consumer_cmd = format!(
            "test -f {} && mkdir -p build && printf consumer > build/consumer.txt",
            marker.display()
        );
        let plan = Plan {
            goal: "build".to_owned(),
            roots: vec![consumer_id.clone()],
            named_caches: Vec::new(),
            tasks: vec![
                executable_task(&producer_id, &[], &["sh", "-c", &producer_cmd], None),
                executable_task(
                    &consumer_id,
                    &[&producer_id],
                    &["sh", "-c", &consumer_cmd],
                    Some("build/consumer.txt"),
                ),
            ],
        };

        let report = execute_plan_with_options(
            &plan,
            None,
            root.path(),
            ExecutionOptions::new(ExecutionMode::Local, 2),
            None,
        )
        .unwrap();
        let ids: Vec<_> = report
            .tasks
            .iter()
            .map(|execution| execution.task_id.as_str())
            .collect();
        assert_eq!(ids, [producer_id.as_str(), consumer_id.as_str()]);
        assert_eq!(
            std::fs::read_to_string(root.path().join("build/consumer.txt")).unwrap(),
            "consumer"
        );
    }

    #[test]
    fn parallel_executor_failure_prevents_downstream_execution() {
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("downstream.marker");
        let failing_id = unique_task_id("failing");
        let downstream_id = unique_task_id("downstream");
        let downstream_cmd = format!("printf ran > {}", marker.display());
        let plan = Plan {
            goal: "build".to_owned(),
            roots: vec![downstream_id.clone()],
            named_caches: Vec::new(),
            tasks: vec![
                executable_task(&failing_id, &[], &["sh", "-c", "exit 7"], None),
                executable_task(
                    &downstream_id,
                    &[&failing_id],
                    &["sh", "-c", &downstream_cmd],
                    None,
                ),
            ],
        };

        let error = format!(
            "{:#}",
            execute_plan_with_options(
                &plan,
                None,
                root.path(),
                ExecutionOptions::new(ExecutionMode::Local, 2),
                None,
            )
            .unwrap_err()
        );
        assert!(error.contains("failed with status"), "{error}");
        assert!(!marker.exists());
    }

    #[test]
    fn parallel_executor_cancels_running_siblings_after_failure() {
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("slow.marker");
        let failing_id = unique_task_id("fail-fast");
        let slow_id = unique_task_id("slow-sibling");
        let slow_cmd = format!("sleep 1 && printf slow > {}", marker.display());
        let plan = Plan {
            goal: "build".to_owned(),
            roots: vec![failing_id.clone(), slow_id.clone()],
            named_caches: Vec::new(),
            tasks: vec![
                executable_task(&failing_id, &[], &["sh", "-c", "exit 9"], None),
                executable_task(&slow_id, &[], &["sh", "-c", &slow_cmd], None),
            ],
        };

        let started = std::time::Instant::now();
        let error = format!(
            "{:#}",
            execute_plan_with_options(
                &plan,
                None,
                root.path(),
                ExecutionOptions::new(ExecutionMode::Local, 2),
                None,
            )
            .unwrap_err()
        );

        assert!(
            started.elapsed() < Duration::from_secs(1),
            "cancellation waited for slow sibling to finish"
        );
        assert!(error.contains("failed with status"), "{error}");
        std::thread::sleep(Duration::from_millis(1100));
        assert!(!marker.exists());
    }

    #[test]
    fn jobs_one_preserves_sequential_execution_order() {
        let root = tempfile::tempdir().unwrap();
        let first_id = unique_task_id("seq-a");
        let second_id = unique_task_id("seq-b");
        let plan = Plan {
            goal: "build".to_owned(),
            roots: vec![first_id.clone(), second_id.clone()],
            named_caches: Vec::new(),
            tasks: vec![
                executable_task(&first_id, &[], &["sh", "-c", "true"], None),
                executable_task(&second_id, &[], &["sh", "-c", "true"], None),
            ],
        };

        let report = execute_plan_with_options(
            &plan,
            None,
            root.path(),
            ExecutionOptions::new(ExecutionMode::Local, 1),
            None,
        )
        .unwrap();
        let ids: Vec<_> = report
            .tasks
            .iter()
            .map(|execution| execution.task_id.as_str())
            .collect();
        assert_eq!(ids, [first_id.as_str(), second_id.as_str()]);
    }

    #[test]
    fn local_executor_runs_commands_and_checks_declared_outputs() {
        let root = tempfile::tempdir().unwrap();
        let task_id = unique_task_id("write");
        let plan = Plan {
            goal: "build".to_owned(),
            roots: vec![task_id.clone()],
            named_caches: Vec::new(),
            tasks: vec![executable_task(
                &task_id,
                &[],
                &["sh", "-c", "mkdir -p build && printf ok > build/out.txt"],
                Some("build/out.txt"),
            )],
        };

        let report = execute_plan(&plan, root.path(), ExecutionMode::Local).unwrap();
        assert_eq!(report.tasks[0].status, TaskExecutionStatus::Ran);
        assert_eq!(
            std::fs::read_to_string(root.path().join("build/out.txt")).unwrap(),
            "ok"
        );

        let temp_leftovers: Vec<_> = std::fs::read_dir(root.path().join("build"))
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains("tmp-file"))
            .collect();
        assert!(temp_leftovers.is_empty());
    }

    #[test]
    fn local_executor_gathers_declared_file_inputs_into_sandbox() {
        let root = tempfile::tempdir().unwrap();
        write_file(&root.path().join("inputs/message.txt"), "hello");
        let task_id = unique_task_id("copy-input");
        let mut task = executable_task(
            &task_id,
            &[],
            &[
                "sh",
                "-c",
                "mkdir -p build && cp inputs/message.txt build/out.txt",
            ],
            Some("build/out.txt"),
        );
        task.inputs = vec![Artifact {
            id: format!("{task_id}:in"),
            kind: "file".to_owned(),
            path: Some("inputs/message.txt".to_owned()),
            value: None,
            producer: None,
        }];
        task.action.inputs = task
            .inputs
            .iter()
            .map(|artifact| artifact.id.clone())
            .collect();
        let plan = Plan {
            goal: "build".to_owned(),
            roots: vec![task_id],
            named_caches: Vec::new(),
            tasks: vec![task],
        };

        execute_plan(&plan, root.path(), ExecutionMode::Local).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.path().join("build/out.txt")).unwrap(),
            "hello"
        );
    }

    #[test]
    fn local_executor_publishes_directory_outputs_atomically() {
        let root = tempfile::tempdir().unwrap();
        let task_id = unique_task_id("dir-output");
        let cached_dir = root.path().join("build/tree");
        std::fs::create_dir_all(&cached_dir).unwrap();
        std::fs::write(cached_dir.join("stale.txt"), "stale").unwrap();
        let mut task = executable_task(
            &task_id,
            &[],
            &[
                "sh",
                "-c",
                "mkdir -p build/tree/nested && printf fresh > build/tree/nested/out.txt",
            ],
            None,
        );
        task.outputs = vec![Artifact {
            id: format!("{task_id}:dir"),
            kind: "directory".to_owned(),
            path: Some("build/tree".to_owned()),
            value: None,
            producer: Some(task_id.clone()),
        }];
        task.action.outputs = task
            .outputs
            .iter()
            .map(|artifact| artifact.id.clone())
            .collect();
        let plan = Plan {
            goal: "build".to_owned(),
            roots: vec![task_id.clone()],
            named_caches: Vec::new(),
            tasks: vec![task],
        };

        execute_plan(&plan, root.path(), ExecutionMode::Local).unwrap();
        assert_eq!(
            std::fs::read_to_string(cached_dir.join("nested/out.txt")).unwrap(),
            "fresh"
        );
        assert!(!cached_dir.join("stale.txt").exists());
    }

    #[test]
    fn progress_executor_streams_process_output_path() {
        let root = tempfile::tempdir().unwrap();
        let task_id = unique_task_id("progress-write");
        let plan = Plan {
            goal: "build".to_owned(),
            roots: vec![task_id.clone()],
            named_caches: Vec::new(),
            tasks: vec![executable_task(
                &task_id,
                &[],
                &[
                    "sh",
                    "-c",
                    "printf stdout-line && printf '\\nstderr-line\\n' >&2 && mkdir -p build && printf ok > build/out.txt",
                ],
                Some("build/out.txt"),
            )],
        };
        let progress_root = prodash::tree::Root::new();
        let mut progress = progress_root.add_child("execute plan");

        let report = execute_plan_with_progress(
            &plan,
            root.path(),
            ExecutionMode::Local,
            Some(&mut progress),
        )
        .unwrap();

        assert_eq!(report.tasks[0].status, TaskExecutionStatus::Ran);
        assert_eq!(
            std::fs::read_to_string(root.path().join("build/out.txt")).unwrap(),
            "ok"
        );
    }

    #[test]
    fn unchanged_second_execution_uses_task_cache_hit() {
        let root = tempfile::tempdir().unwrap();
        let task_id = unique_task_id("cache-hit");
        let marker = root.path().join("runs.txt");
        let command = format!(
            "printf ran >> {} && mkdir -p build && printf ok > build/out.txt",
            marker.display()
        );
        let plan = Plan {
            goal: "build".to_owned(),
            roots: vec![task_id.clone()],
            named_caches: Vec::new(),
            tasks: vec![executable_task(
                &task_id,
                &[],
                &["sh", "-c", &command],
                Some("build/out.txt"),
            )],
        };

        let first = execute_plan(&plan, root.path(), ExecutionMode::Local).unwrap();
        assert_eq!(first.tasks[0].status, TaskExecutionStatus::Ran);
        std::fs::remove_file(root.path().join("build/out.txt")).unwrap();

        let second = execute_plan(&plan, root.path(), ExecutionMode::Local).unwrap();
        assert_eq!(second.tasks[0].status, TaskExecutionStatus::CacheHit);
        assert_eq!(
            std::fs::read_to_string(root.path().join("build/out.txt")).unwrap(),
            "ok"
        );
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "ran");

        let explanation = explain_task_cache(&plan, root.path(), &task_id).unwrap();
        assert!(explanation.hit);
    }

    #[test]
    fn editing_declared_input_invalidates_downstream_tasks() {
        let root = tempfile::tempdir().unwrap();
        write_file(&root.path().join("inputs/message.txt"), "one");
        let producer_id = unique_task_id("input-producer");
        let consumer_id = unique_task_id("input-consumer");
        let producer_marker = root.path().join("producer-runs.txt");
        let consumer_marker = root.path().join("consumer-runs.txt");
        let producer_cmd = format!(
            "printf p >> {} && mkdir -p build && cp inputs/message.txt build/producer.txt",
            producer_marker.display()
        );
        let consumer_cmd = format!(
            "printf c >> {} && mkdir -p build && cp build/producer.txt build/consumer.txt",
            consumer_marker.display()
        );
        let mut producer = executable_task(
            &producer_id,
            &[],
            &["sh", "-c", &producer_cmd],
            Some("build/producer.txt"),
        );
        producer.inputs = vec![Artifact {
            id: format!("{producer_id}:in"),
            kind: "file".to_owned(),
            path: Some("inputs/message.txt".to_owned()),
            value: None,
            producer: None,
        }];
        producer.action.inputs = producer
            .inputs
            .iter()
            .map(|artifact| artifact.id.clone())
            .collect();
        let mut consumer = executable_task(
            &consumer_id,
            &[&producer_id],
            &["sh", "-c", &consumer_cmd],
            Some("build/consumer.txt"),
        );
        consumer.inputs = vec![Artifact {
            id: format!("{consumer_id}:in"),
            kind: "file".to_owned(),
            path: Some("build/producer.txt".to_owned()),
            value: None,
            producer: Some(producer_id.clone()),
        }];
        consumer.action.inputs = consumer
            .inputs
            .iter()
            .map(|artifact| artifact.id.clone())
            .collect();
        let plan = Plan {
            goal: "build".to_owned(),
            roots: vec![consumer_id.clone()],
            named_caches: Vec::new(),
            tasks: vec![producer, consumer],
        };

        let first = execute_plan(&plan, root.path(), ExecutionMode::Local).unwrap();
        assert_eq!(first.tasks[0].status, TaskExecutionStatus::Ran);
        assert_eq!(first.tasks[1].status, TaskExecutionStatus::Ran);
        let second = execute_plan(&plan, root.path(), ExecutionMode::Local).unwrap();
        assert_eq!(second.tasks[0].status, TaskExecutionStatus::CacheHit);
        assert_eq!(second.tasks[1].status, TaskExecutionStatus::CacheHit);

        write_file(&root.path().join("inputs/message.txt"), "two");
        let third = execute_plan(&plan, root.path(), ExecutionMode::Local).unwrap();
        assert_eq!(third.tasks[0].status, TaskExecutionStatus::Ran);
        assert_eq!(third.tasks[1].status, TaskExecutionStatus::Ran);
        assert_eq!(
            std::fs::read_to_string(root.path().join("build/consumer.txt")).unwrap(),
            "two"
        );
        assert_eq!(std::fs::read_to_string(producer_marker).unwrap(), "pp");
        assert_eq!(std::fs::read_to_string(consumer_marker).unwrap(), "cc");
    }

    #[test]
    fn local_executor_exposes_named_cache_environment_paths() {
        let root = tempfile::tempdir().unwrap();
        let task_id = unique_task_id("named-cache");
        let named_caches = vec![NamedCache {
            name: "tool-cache".to_owned(),
            env_var: "IMP_NAMED_CACHE_TOOL_CACHE".to_owned(),
        }];
        let plan = Plan {
            goal: "build".to_owned(),
            roots: vec![task_id.clone()],
            named_caches: named_caches.clone(),
            tasks: vec![executable_task(
                &task_id,
                &[],
                &[
                    "sh",
                    "-c",
                    "test -d \"$IMP_NAMED_CACHE_TOOL_CACHE\" && printf cache > \"$IMP_NAMED_CACHE_TOOL_CACHE/value.txt\" && mkdir -p build && printf ok > build/out.txt",
                ],
                Some("build/out.txt"),
            )],
        };

        let report = execute_plan(&plan, root.path(), ExecutionMode::Local).unwrap();
        assert_eq!(report.tasks[0].status, TaskExecutionStatus::Ran);
        let binding = named_cache_bindings(root.path(), &named_caches)
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(binding.path.join("value.txt")).unwrap(),
            "cache"
        );
    }

    #[test]
    fn exec_ctx_output_flows_to_downstream_dep_outputs() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(
            &p.join(WORKSPACE_FILE),
            r#"import "//rules/producer";
import "//rules/consumer";"#,
        );
        write_file(
            &p.join("rules/producer.js"),
            r#"
import { target, rule } from "imp:core";
rule({
    kind: "producer",
    product: "value",
    action: "produce",
    exec: (target, ctx) => { ctx.output("hello-from-producer"); },
    requiresOwnSources: false,
    dependencyProduct: null,
});
export function producer() { return target({ kind: "producer" }); }
"#,
        );
        write_file(
            &p.join("rules/consumer.js"),
            r#"
import { target, rule } from "imp:core";
rule({
    kind: "consumer",
    product: "result",
    action: "consume",
    exec: (target, ctx) => {
        if (target.depOutputs.length !== 1) throw new Error("expected 1 dep output");
        if (target.depOutputs[0] !== "hello-from-producer") throw new Error("wrong value: " + target.depOutputs[0]);
        ctx.output("hello-from-consumer");
    },
    requiresOwnSources: false,
    dependencyProduct: "value",
});
export function consumer(dep) { return target({ kind: "consumer", deps: [dep] }); }
"#,
        );
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { producer } from "//rules/producer";
import { consumer } from "//rules/consumer";
export const p = producer();
export const c = consumer(p);
"#,
        );

        let live = load_workspace(p).unwrap();
        let plan = plan(&live, "build", &["c".into()]).unwrap();
        assert_eq!(plan.roots, ["//:c#result"]);

        let ordered = ordered_tasks(&plan).unwrap();
        let mut exec_values: BTreeMap<String, String> = BTreeMap::new();
        for task in &ordered {
            if task.exec_fn.is_some() {
                let dep_values: Vec<String> = task
                    .dependencies
                    .iter()
                    .filter_map(|id| exec_values.get(id).cloned())
                    .collect();
                let (_, _, value) =
                    execute_task_with_exec(task, &live, p, &dep_values).unwrap();
                if let Some(v) = value {
                    exec_values.insert(task.id.clone(), v);
                }
            }
        }

        assert_eq!(exec_values.get("//:c#result").map(|s| s.as_str()), Some("hello-from-consumer"));
    }

    #[cfg(unix)]
    #[test]
    fn exec_context_materializes_named_cache_tools_on_path() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        let tool_dir = named_cache_key_path(p, "test-tools", "v1/linux-x86_64").unwrap();
        std::fs::create_dir_all(tool_dir.join("bin")).unwrap();
        let tool_bin = tool_dir.join("bin/hello-tool");
        std::fs::write(&tool_bin, "#!/bin/sh\nprintf from-tool > out.txt\n").unwrap();
        let mut perms = std::fs::metadata(&tool_bin).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&tool_bin, perms).unwrap();

        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import "//rules/tool";
"#,
        );
        write_file(
            &p.join("rules/tool.js"),
            r#"
import { namedCache, rule, target } from "imp:core";

namedCache({ name: "test-tools" });

async function buildExec(target, ctx) {
    const tool = await ctx.tool({
        name: "hello",
        cache: "test-tools",
        key: "v1/linux-x86_64",
        binDirs: ["bin"],
    });
    const result = await ctx.inSandbox({
        argv: ["hello-tool"],
        tools: [tool],
        outputs: [{ kind: "file", path: "out.txt" }],
        display: "hello tool",
    });
    if (result.exitCode !== 0) {
        throw new Error(result.stderr);
    }
}

rule({
    kind: "tool-user",
    product: "file",
    action: "hello tool",
    exec: buildExec,
});

export function toolUser() {
    return target({ kind: "tool-user" });
}
"#,
        );
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { toolUser } from "//rules/tool";
export const generated = toolUser();
"#,
        );

        let live = load_workspace(p).unwrap();
        let plan = plan(&live, "build", &["generated".to_owned()]).unwrap();
        let report = execute_plan_with_options(
            &plan,
            Some(&live),
            p,
            ExecutionOptions::new(ExecutionMode::Local, 1),
            None,
        )
        .unwrap();

        assert_eq!(report.tasks[0].status, TaskExecutionStatus::Ran);
        assert_eq!(
            std::fs::read_to_string(p.join("out.txt")).unwrap(),
            "from-tool"
        );
    }

    #[test]
    fn local_executor_reports_missing_declared_outputs() {
        let root = tempfile::tempdir().unwrap();
        let plan = Plan {
            goal: "build".to_owned(),
            roots: vec!["missing".to_owned()],
            named_caches: Vec::new(),
            tasks: vec![executable_task(
                "missing",
                &[],
                &["sh", "-c", "true"],
                Some("build/missing.txt"),
            )],
        };

        let error = format!(
            "{:#}",
            execute_plan(&plan, root.path(), ExecutionMode::Local).unwrap_err()
        );
        assert!(error.contains("declared file output"), "{error}");
        assert!(error.contains("build/missing.txt"), "{error}");
    }

    #[test]
    fn root_relative_imports_can_resolve_build_directory_modules() {
        let root = fixture();
        let workspace = load_workspace(root.path()).unwrap();

        let jodin = &workspace.targets["//library/jodin:jodin"];
        assert_eq!(jodin.dependencies[0].address, "//src/cpp/joltphysics:cmake");
    }

    #[test]
    fn root_relative_imports_can_resolve_index_js_modules() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import "//rules/package";
"#,
        );
        write_file(
            &p.join("rules/package/index.js"),
            r#"
export const loaded = true;
"#,
        );
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { loaded } from "//rules/package";
if (!loaded) {
    throw new Error("index.js module did not load");
}
export const done = 1;
"#,
        );

        load_workspace(p).unwrap();
    }

    #[test]
    fn rules_test_targets_discover_and_run_js_tests_by_directory() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import "//rules/imp/test";
"#,
        );
        write_file(
            &p.join("rules/imp/test/index.js"),
            include_str!("../rules/imp/test/index.js"),
        );
        write_file(
            &p.join("rules/example/alpha_test.js"),
            r#"
import { describe, expect, test } from "//rules/imp/test";

describe("alpha rule tests", () => {
test("runs a discovered test", () => {
    expect("alpha").toBe("alpha");
});
});
"#,
        );
        write_file(
            &p.join("rules/example/beta_test.js"),
            r#"
import { expect, test } from "//rules/imp/test";

test("runs a second discovered test", () => {
    expect(["beta", "gamma"]).toContain("gamma");
});
"#,
        );
        write_file(
            &p.join("rules/example/BUILD.js"),
            r#"
import { rulesTest } from "//rules/imp/test";
export const rules_test = rulesTest({ root: "//rules/example" });
"#,
        );
        write_file(
            &p.join("rules/other/example_test.js"),
            r#"
import { expect, test } from "//rules/imp/test";

test("runs another directory test", () => {
    expect({ ok: true }).toEqual({ ok: true });
});
"#,
        );
        write_file(
            &p.join("rules/other/BUILD.js"),
            r#"
import { rulesTest } from "//rules/imp/test";
export const rules_test = rulesTest({ root: "//rules/other" });
"#,
        );

        let live = load_workspace(p).unwrap();
        let plan = plan(&live, "test", &[]).unwrap();

        assert_eq!(
            plan.roots,
            [
                "//rules/example:rules_test#test".to_owned(),
                "//rules/other:rules_test#test".to_owned(),
            ]
        );

        let example = live.targets.get("//rules/example:rules_test").unwrap();
        assert_eq!(
            example.fields["tests"],
            "//rules/example/alpha_test,//rules/example/beta_test"
        );
        let other = live.targets.get("//rules/other:rules_test").unwrap();
        assert_eq!(other.fields["tests"], "//rules/other/example_test");

        let report = execute_plan_with_options(
            &plan,
            Some(&live),
            p,
            ExecutionOptions::new(ExecutionMode::Local, 1),
            None,
        )
        .unwrap();
        assert!(report
            .tasks
            .iter()
            .all(|execution| execution.status == TaskExecutionStatus::Ran));
    }

    #[test]
    fn odin_js_rule_tests_pass() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import "//rules/imp/test";
import "//rules/odin";
"#,
        );
        write_file(
            &p.join("rules/imp/test/index.js"),
            include_str!("../rules/imp/test/index.js"),
        );
        write_file(
            &p.join("rules/odin/index.js"),
            include_str!("../rules/odin/index.js"),
        );
        write_file(
            &p.join("rules/odin/toolchain.js"),
            include_str!("../rules/odin/toolchain.js"),
        );
        write_file(
            &p.join("rules/odin/index_test.js"),
            include_str!("../rules/odin/index_test.js"),
        );
        write_file(
            &p.join("rules/odin/BUILD.js"),
            r#"
import { rulesTest } from "//rules/imp/test";
export const rules_test = rulesTest({ root: "//rules/odin" });
"#,
        );

        let live = load_workspace(p).unwrap();
        let plan = plan(&live, "test", &[]).unwrap();
        let report = execute_plan_with_options(
            &plan,
            Some(&live),
            p,
            ExecutionOptions::new(ExecutionMode::Local, 1),
            None,
        )
        .unwrap();
        assert!(
            report
                .tasks
                .iter()
                .all(|execution| execution.status == TaskExecutionStatus::Ran),
            "some odin JS rule tests failed"
        );
    }

    #[test]
    fn javascript_can_declare_named_caches_during_load() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import "//rules/tool";
"#,
        );
        write_file(
            &p.join("rules/tool.js"),
            r#"
import { namedCache, rule, target } from "imp:core";

namedCache({ name: "tool-cache" });
namedCache({ name: "tool-cache" });

rule({
  kind: "tool-target",
  product: "file",
  action: {
    argv: ["sh", "-c", "mkdir -p build && printf ok > build/out.txt"],
    outputs: [{ kind: "file", path: "build/out.txt" }],
    display: "tool"
  }
});

export function tool() {
  return target({ kind: "tool-target" });
}
"#,
        );
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { tool } from "//rules/tool";
export const generated = tool();
"#,
        );

        let workspace = load_workspace(p).unwrap();
        let cache = workspace.named_caches.get("tool-cache").unwrap();
        assert_eq!(cache.env_var, "IMP_NAMED_CACHE_TOOL_CACHE");
        let plan = plan(&workspace, "build", &["generated".to_owned()]).unwrap();
        assert_eq!(plan.named_caches, vec![cache.clone()]);
    }

    #[test]
    fn invalid_named_cache_names_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import "//rules/bad";
"#,
        );
        write_file(
            &p.join("rules/bad.js"),
            r#"
import { namedCache } from "imp:core";
namedCache({ name: "Bad Cache" });
"#,
        );
        write_file(&p.join(BUILD_FILE), "export const nothing = 1;\n");

        let error = format!("{:#}", load_workspace(p).unwrap_err());
        assert!(
            error.contains("must contain only lowercase ASCII letters"),
            "{error}"
        );
    }

    #[test]
    fn relative_imports_from_build_files_are_rejected_with_context() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import "//rules/asset";
"#,
        );
        write_file(&p.join("rules/asset.js"), ASSET_RULES_JS);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { asset } from "./rules/asset";

export const ui = asset({ srcs: ["**/*.png"] });
"#,
        );

        let error = format!("{:#}", load_workspace(p).unwrap_err());
        assert!(
            error.contains("relative import './rules/asset' is prohibited in BUILD.js"),
            "{error}"
        );
        assert!(error.contains("BUILD.js"), "{error}");
        assert!(error.contains("//..."), "{error}");
    }

    #[test]
    fn unknown_builtin_modules_are_reported_distinctly() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import "imp:missing";
"#,
        );
        write_file(&p.join(BUILD_FILE), "export const ignored = 1;\n");

        let error = format!("{:#}", load_workspace(p).unwrap_err());
        assert!(
            error.contains("unknown built-in module 'imp:missing'"),
            "{error}"
        );
        assert!(error.contains(WORKSPACE_FILE), "{error}");
    }

    #[test]
    fn missing_workspace_modules_report_importer_and_candidates() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), "");
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { missing } from "//rules/missing";

export const ignored = missing;
"#,
        );

        let error = format!("{:#}", load_workspace(p).unwrap_err());
        assert!(
            error.contains("cannot resolve workspace module '//rules/missing'"),
            "{error}"
        );
        assert!(error.contains("rules/missing.js"), "{error}");
        assert!(error.contains("rules/missing/BUILD.js"), "{error}");
        assert!(error.contains(BUILD_FILE), "{error}");
    }

    #[test]
    fn test_select_targets() {
        let root = fixture();
        let workspace = load_workspace(root.path()).unwrap();

        let all = select_targets(&workspace, &[]).unwrap();
        // joltphysics, cmake, jodin, ui = 4
        assert_eq!(all.len(), 4);

        let sel = select_targets(&workspace, &["jodin".to_owned()]).unwrap();
        assert_eq!(sel.len(), 1);
        assert_eq!(sel[0].address, "//library/jodin:jodin");

        assert!(select_targets(&workspace, &["nonexistent".to_owned()]).is_err());
    }

    #[test]
    fn test_format_targets() {
        let root = fixture();
        let workspace = load_workspace(root.path()).unwrap();
        let targets = select_targets(&workspace, &["jodin".to_owned()]).unwrap();
        let mut out = String::new();
        format_targets(&targets, &mut out).unwrap();
        assert!(out.contains("//library/jodin:jodin (odin-package)"));
        assert!(out.contains("sources: *.odin"));
        assert!(out.contains("dependencies: //src/cpp/joltphysics:cmake"));
    }

    #[test]
    fn test_format_dependencies() {
        let root = fixture();
        let workspace = load_workspace(root.path()).unwrap();
        let mut out = String::new();
        format_dependencies(&workspace, &["jodin".to_owned()], &mut out).unwrap();
        let expected = "\
//library/jodin:jodin
└── //src/cpp/joltphysics:cmake
    └── //src/cpp/joltphysics:joltphysics
";
        assert_eq!(out, expected);
    }

    #[test]
    fn test_format_rules() {
        let root = fixture();
        let workspace = load_workspace(root.path()).unwrap();
        let mut out = String::new();
        format_rules(&workspace, &mut out).unwrap();
        assert!(out.contains("Target Kinds:"));
        assert!(out.contains("  - odin-package (default product: odin-package)"));
        assert!(out.contains("Rules:"));
        assert!(out.contains("  odin-package:"));
        assert!(out.contains("    - odin-package:"));
        assert!(out.contains("        action: odin build"));
        assert!(out.contains("        requires own sources: true"));
        assert!(out.contains("        dependency product: default"));
    }

    #[test]
    fn dot_edges_flow_from_prerequisites_to_consumers() {
        let root = fixture();
        let workspace = load_workspace(root.path()).unwrap();
        let plan = plan(&workspace, "build", &["jodin".into()]).unwrap();
        let dot = render_dot(&plan);

        assert!(dot.contains("rankdir=TB"));
        assert!(dot.contains("//src/cpp/joltphysics:joltphysics#sources"));
        assert!(dot.contains(" -> "));
    }

    #[test]
    fn impure_task_is_not_cacheable() {
        let root = tempfile::tempdir().unwrap();
        let task_id = unique_task_id("impure");
        let mut task = executable_task(
            &task_id,
            &[],
            &["sh", "-c", "mkdir -p build && printf ok > build/out.txt"],
            Some("build/out.txt"),
        );
        task.action.impure = true;
        let plan = Plan {
            goal: "build".to_owned(),
            roots: vec![task_id.clone()],
            named_caches: Vec::new(),
            tasks: vec![task],
        };

        let explanation = explain_task_cache(&plan, root.path(), &task_id).unwrap();
        assert!(!explanation.cacheable);
        assert!(explanation.impure);
        assert!(!explanation.force_cache);
        assert!(explanation
            .miss_reason
            .as_deref()
            .unwrap_or("")
            .contains("impure"));

        let mut output = String::new();
        format_cache_explanation(&explanation, &mut output).unwrap();
        assert!(output.contains("impure: true (caching disabled)"));
    }

    #[test]
    fn force_cache_overrides_impure_task() {
        let root = tempfile::tempdir().unwrap();
        let task_id = unique_task_id("force-cache");
        let mut task = executable_task(
            &task_id,
            &[],
            &["sh", "-c", "mkdir -p build && printf ok > build/out.txt"],
            Some("build/out.txt"),
        );
        task.action.impure = true;
        task.action.force_cache = true;
        let plan = Plan {
            goal: "build".to_owned(),
            roots: vec![task_id.clone()],
            named_caches: Vec::new(),
            tasks: vec![task],
        };

        let explanation = explain_task_cache(&plan, root.path(), &task_id).unwrap();
        assert!(explanation.cacheable);
        assert!(explanation.impure);
        assert!(explanation.force_cache);

        let mut output = String::new();
        format_cache_explanation(&explanation, &mut output).unwrap();
        assert!(output.contains("force_cache override"));
    }

    #[test]
    fn non_impure_task_uses_existing_heuristic() {
        let root = tempfile::tempdir().unwrap();
        let task_id = unique_task_id("heuristic");
        let mut task = executable_task(
            &task_id,
            &[],
            &["sh", "-c", "mkdir -p build && printf ok > build/out.txt"],
            Some("build/out.txt"),
        );
        task.action.impure = false;
        task.action.force_cache = false;
        let plan = Plan {
            goal: "build".to_owned(),
            roots: vec![task_id.clone()],
            named_caches: Vec::new(),
            tasks: vec![task],
        };

        let explanation = explain_task_cache(&plan, root.path(), &task_id).unwrap();
        assert!(explanation.cacheable);
        assert!(!explanation.impure);
    }

    // -----------------------------------------------------------------------
    // Host function integration tests
    // -----------------------------------------------------------------------

    #[test]
    fn javascript_can_use_platform_info() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), r#"import "//rules/test";"#);
        write_file(
            &p.join("rules/test.js"),
            r#"
import { platformInfo } from "imp:core";
const info = platformInfo();
if (typeof info.os !== "string" || info.os.length === 0) {
    throw new Error("platformInfo().os is missing: " + JSON.stringify(info));
}
if (typeof info.arch !== "string" || info.arch.length === 0) {
    throw new Error("platformInfo().arch is missing: " + JSON.stringify(info));
}
export const ok = 1;
"#,
        );
        write_file(&p.join(BUILD_FILE), "export const done = 1;\n");

        load_workspace(p).unwrap();
    }

    #[test]
    fn cas_tree_store_get_roundtrip() {
        let entries = vec![
            SourceFileEntry { path: "b.odin".into(), digest: "d2".into(), bytes: 20 },
            SourceFileEntry { path: "a.odin".into(), digest: "d1".into(), bytes: 10 },
        ];
        let digest = cas_tree_store(&entries).unwrap();
        let retrieved = cas_tree_get(&digest).unwrap();
        // stored sorted by path
        assert_eq!(retrieved[0].path, "a.odin");
        assert_eq!(retrieved[1].path, "b.odin");
        // same digest for same logical content regardless of input order
        let digest2 = cas_tree_store(&[entries[1].clone(), entries[0].clone()]).unwrap();
        assert_eq!(digest, digest2);
    }

    #[test]
    fn cas_tree_merge_combines_disjoint_trees() {
        let a = cas_tree_store(&[SourceFileEntry { path: "a.odin".into(), digest: "d1".into(), bytes: 10 }]).unwrap();
        let b = cas_tree_store(&[SourceFileEntry { path: "b.odin".into(), digest: "d2".into(), bytes: 20 }]).unwrap();
        let merged = cas_tree_merge(&[&a, &b]).unwrap();
        let entries = cas_tree_get(&merged).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "a.odin");
        assert_eq!(entries[1].path, "b.odin");
    }

    #[test]
    fn cas_tree_merge_deduplicates_identical_entries() {
        let a = cas_tree_store(&[SourceFileEntry { path: "a.odin".into(), digest: "d1".into(), bytes: 10 }]).unwrap();
        let merged = cas_tree_merge(&[&a, &a]).unwrap();
        assert_eq!(cas_tree_get(&merged).unwrap().len(), 1);
    }

    #[test]
    fn cas_tree_merge_errors_on_conflicting_content() {
        let a = cas_tree_store(&[SourceFileEntry { path: "a.odin".into(), digest: "d1".into(), bytes: 10 }]).unwrap();
        let b = cas_tree_store(&[SourceFileEntry { path: "a.odin".into(), digest: "d2".into(), bytes: 99 }]).unwrap();
        let err = cas_tree_merge(&[&a, &b]).unwrap_err();
        assert!(err.to_string().contains("conflicting content"), "{err}");
    }

    #[test]
    fn javascript_can_use_cas_tree_operations() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { casTreeStore, casTreeGet, casTreeMerge } from "imp:core";

const a = casTreeStore([{ path: "a.odin", digest: "d1", bytes: 10 }]);
const b = casTreeStore([{ path: "b.odin", digest: "d2", bytes: 20 }]);
const merged = casTreeMerge(a, b);
const entries = casTreeGet(merged);

export const tree_digest = { __imp: false, result: { a, b, merged, entries } };
"#,
        );
        let live = load_workspace(p).unwrap();
        // loading without error is sufficient — the BUILD.js ran the operations
        assert!(live.targets.is_empty()); // no target() calls, but no crash
    }

    #[test]
    fn javascript_can_use_sha256() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        // Write a known file and compute its sha256sum externally.
        let test_file = p.join("data.bin");
        std::fs::write(&test_file, b"hello world\n").unwrap();
        let expected = std::process::Command::new("sha256sum")
            .arg(&test_file)
            .output()
            .unwrap();
        let expected_hex = String::from_utf8_lossy(&expected.stdout)
            .split_whitespace()
            .next()
            .unwrap()
            .to_owned();

        write_file(&p.join(WORKSPACE_FILE), r#"import "//rules/test";"#);
        write_file(
            &p.join("rules/test.js"),
            &format!(
                r#"
import {{ sha256 }} from "imp:core";
const digest = sha256("{path}");
if (digest !== "{expected}") {{
    throw new Error("sha256 mismatch: got " + digest + ", expected {expected}");
}}
export const ok = 1;
"#,
                path = test_file.to_string_lossy().replace('\\', "\\\\"),
                expected = expected_hex,
            ),
        );
        write_file(&p.join(BUILD_FILE), "export const done = 1;\n");

        load_workspace(p).unwrap();
    }

    #[test]
    fn javascript_can_use_cache_operations() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        // Create a source file to cache.
        let src_dir = p.join("source");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::write(src_dir.join("tool.txt"), b"cached-content").unwrap();

        write_file(
            &p.join(WORKSPACE_FILE),
            &format!(
                r#"
import {{ namedCache, cachePut, cacheGet, cacheHas }} from "imp:core";
namedCache({{ name: "test-cache" }});

// Put content into the cache.
cachePut("test-cache", "v1/linux-x86_64", "{src}");

// Check it exists.
if (!cacheHas("test-cache", "v1/linux-x86_64")) {{
    throw new Error("cacheHas returned false after put");
}}

// Retrieve the path.
const path = cacheGet("test-cache", "v1/linux-x86_64");
if (path === null || path === undefined) {{
    throw new Error("cacheGet returned null after put");
}}

// Check a missing key.
if (cacheHas("test-cache", "missing-key")) {{
    throw new Error("cacheHas returned true for missing key");
}}

export const ok = 1;
"#,
                src = src_dir.to_string_lossy().replace('\\', "\\\\"),
            ),
        );
        write_file(&p.join(BUILD_FILE), "export const done = 1;\n");

        load_workspace(p).unwrap();
    }

    #[test]
    fn javascript_can_use_extract() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        // Create a tar.gz archive using the system tar.
        let content_dir = p.join("archive-content");
        std::fs::create_dir_all(content_dir.join("sub")).unwrap();
        std::fs::write(content_dir.join("sub/file.txt"), b"extracted").unwrap();
        let archive = p.join("test.tar.gz");

        let status = std::process::Command::new("tar")
            .args([
                "czf",
                &archive.to_string_lossy(),
                "-C",
                &content_dir.to_string_lossy(),
                "sub",
            ])
            .status()
            .unwrap();
        assert!(status.success(), "failed to create test archive");

        let extract_dir = p.join("extracted");

        write_file(
            &p.join(WORKSPACE_FILE),
            &format!(
                r#"
import {{ extract }} from "imp:core";
extract("{archive}", "{dest}", {{ format: "tar.gz", strip_components: 0 }});
export const ok = 1;
"#,
                archive = archive.to_string_lossy(),
                dest = extract_dir.to_string_lossy(),
            ),
        );
        write_file(&p.join(BUILD_FILE), "export const done = 1;\n");

        load_workspace(p).unwrap();
        // Verify the file was extracted correctly.
        let extracted_file = extract_dir.join("sub/file.txt");
        assert!(
            extracted_file.is_file(),
            "extracted file not found at {}",
            extracted_file.display()
        );
        assert_eq!(
            std::fs::read_to_string(&extracted_file).unwrap(),
            "extracted"
        );
    }

    #[test]
    fn product_registration_creates_dispatchable_product_task() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(
            &p.join(WORKSPACE_FILE),
            r#"import "imp:core";"#,
        );
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target, product } from "imp:core";

export const pkg = target({ kind: "test-pkg", fields: { name: "hello" } });

export const report = product("test-pkg", "report", async function report(handle) {
    return "ok";
});
"#,
        );

        let live = load_workspace(p).unwrap();

        // The product is listed in the workspace.
        assert!(
            live.products.contains_key(&("test-pkg".to_owned(), "report".to_owned())),
            "product should be registered in workspace"
        );

        // Planning with an explicit #product selector creates an is_product task.
        let plan = plan(&live, "build", &["//:pkg#report".to_owned()]).unwrap();
        assert_eq!(plan.tasks.len(), 1);
        let task = &plan.tasks[0];
        assert!(task.is_product, "task should be a product task");
        assert!(task.exec_fn.is_some(), "task should have an exec_fn");
        assert_eq!(task.product, "report");

        // Execution succeeds (the product function returns "ok" but no ctx.output is called).
        let report = execute_plan_with_options(
            &plan,
            Some(&live),
            p,
            ExecutionOptions::new(ExecutionMode::Local, 1),
            None,
        )
        .unwrap();
        assert!(
            report.tasks.iter().all(|e| e.status == TaskExecutionStatus::Ran),
            "product task should have run successfully"
        );
    }

    #[test]
    fn product_selector_hash_syntax_is_parsed() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(
            &p.join(WORKSPACE_FILE),
            r#"import "imp:core";"#,
        );
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target, product } from "imp:core";

export const pkg = target({ kind: "kind-a", fields: {} });

export const check = product("kind-a", "check", async function check(handle) {});
"#,
        );

        let live = load_workspace(p).unwrap();

        // //:pkg#check should select the "check" product explicitly.
        let task_plan = plan(&live, "build", &["//:pkg#check".to_owned()]).unwrap();
        assert_eq!(task_plan.tasks.len(), 1);
        assert_eq!(task_plan.tasks[0].product, "check");
        assert!(task_plan.tasks[0].is_product);

        // An unknown product in the selector should fail.
        let err = plan(&live, "build", &["//:pkg#nonexistent".to_owned()])
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("no product 'nonexistent'"),
            "expected product-not-found error, got: {err}"
        );
    }
}
