//! QuickJS-backed target, rule, and goal planning spike.
//!
//! `imp.workspace.js` imports plugin modules that register rules via
//! `product()` registrations. Workspace `BUILD.js` files declare and export target handles
//! via `__host_target`.  The Rust engine resolves product requests into a task
//! DAG without executing it.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};

use crate::runtime::{HostLogSink, LiveWorkspace};
use crate::toolchain;
use anyhow::{bail, Context, Result};
use regex::Regex;
use rquickjs::{
    function::Async,
    loader::{ImportAttributes, Loader, Resolver},
    promise::MaybePromise,
    Array, AsyncContext as JsContext, AsyncRuntime as Runtime, CatchResultExt, Ctx, Filter,
    Function, Module, Object, Value,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use walkdir::WalkDir;

const WORKSPACE_FILE: &str = "imp.workspace.js";
const BUILD_FILE: &str = "BUILD.js";
const TASK_CACHE_VERSION: u32 = 2;
const PROCESS_OUTPUT_VISIBLE_LINES: usize = 5;

/// The built-in `imp:core` module exposed to every plugin and BUILD file.
const CORE_JS: &str = r##"
function _serialize_attrs(value) {
    if (value === null || value === undefined || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(_serialize_attrs);
    if (value.__imp === true) return { __imp_ref: value.__id };
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = _serialize_attrs(v);
    return out;
}

function _collect_dep_handles(value, out) {
    if (value === null || value === undefined || typeof value !== "object") return;
    if (value.__imp === true) { out.push(value); return; }
    if (Array.isArray(value)) { for (const v of value) _collect_dep_handles(v, out); return; }
    for (const v of Object.values(value)) _collect_dep_handles(v, out);
}

function _normalize_source_fields(value) {
    if (value === null || value === undefined) return [];
    const values = Array.isArray(value) ? value : [value];
    return values.map(v => {
        if (!v || v.__imp_source_field !== true) {
            throw new Error("target({ sources }) expects sourcesField(...) or an array of sourcesField(...)");
        }
        return { root: v.root, include: v.include, exclude: v.exclude };
    });
}

/**
 * Declare source files owned by a target.
 *
 * @param {object} opts
 * @param {string} [opts.root="."] Root relative to the declaring BUILD package.
 * @param {string[]} opts.include Glob patterns matched relative to root.
 * @param {string[]} [opts.exclude=[]] Glob patterns excluded relative to root.
 * @returns {object} Source ownership descriptor for target({ sources }).
 */
export function sourcesField(opts) {
    if (!opts || !Array.isArray(opts.include)) {
        throw new Error("sourcesField({ root?, include, exclude? }) requires include glob patterns");
    }
    return {
        __imp_source_field: true,
        root: opts.root || ".",
        include: opts.include,
        exclude: opts.exclude || [],
    };
}

/**
 * Declare a target and return a target handle.
 *
 * @param {object} opts
 * @param {string} opts.kind Stable target kind understood by extension rules.
 * @param {object} [opts.attrs={}] Typed attributes stored on the target. May contain nested
 *   target handles; those are extracted as dep edges automatically when opts.deps is omitted.
 * @param {Array<object>} [opts.deps] Explicit dependency list as handles or { target, mode } pairs.
 *   When omitted, deps are discovered by scanning opts.attrs for target handles.
 * @returns {object} An enriched target handle: { __imp, __id, kind, attrs }.
 */
export function target(opts) {
    const depIds = [];
    const depModes = [];
    const attrs = opts.attrs !== undefined ? opts.attrs : (opts.fields !== undefined ? opts.fields : {});
    const sources = _normalize_source_fields(opts.sources);
    if (opts.deps != null) {
        for (const d of opts.deps) {
            if (d && d.__imp === true) {
                depIds.push(d.__id); depModes.push(null);
            } else if (d && d.target && d.target.__imp === true) {
                depIds.push(d.target.__id);
                depModes.push(d.mode != null ? String(d.mode) : null);
            } else {
                throw new Error('dep must be a target handle or { target, mode }, got: ' + JSON.stringify(d));
            }
        }
    } else {
        const found = [];
        _collect_dep_handles(attrs, found);
        for (const h of found) { depIds.push(h.__id); depModes.push(null); }
    }
    const id = __host_target(opts.kind, JSON.stringify(_serialize_attrs(attrs)), JSON.stringify(sources), depIds, depModes);
    const handle = { __imp: true, __id: id, kind: opts.kind, attrs };
    Object.defineProperty(handle, "label", {
        enumerable: true,
        get() {
            const address = targetAddress(handle);
            const colon = address.lastIndexOf(":");
            return {
                address,
                name: colon >= 0 ? address.slice(colon + 1) : address,
            };
        },
    });
    if (globalThis.__imp_handle_by_id) globalThis.__imp_handle_by_id.set(id, handle);
    return handle;
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
 * Merge JSON-serializable workspace configuration into a namespace.
 *
 * Configuration is evaluated before BUILD.js files when called from
 * imp.workspace.js, and can be read by rule functions via configuration().
 *
 * @param {string} namespace Stable configuration namespace, e.g. "odin".
 * @param {any} value JSON-serializable configuration value.
 * @returns {void}
 */
export function configure(namespace, value) {
    if (typeof namespace !== "string" || namespace.length === 0) {
        throw new Error("configure(namespace, value) requires a non-empty namespace");
    }
    const encoded = JSON.stringify(_serialize_attrs(value));
    if (encoded === undefined) {
        throw new Error("configure(namespace, value) requires a JSON-serializable value");
    }
    __host_configure(namespace, encoded);
}

/**
 * Read workspace configuration for a namespace.
 *
 * @param {string} namespace Stable configuration namespace, e.g. "odin".
 * @param {any} [fallback] Value returned when no namespace config exists.
 * @returns {any}
 */
export function configuration(namespace, fallback = undefined) {
    if (typeof namespace !== "string" || namespace.length === 0) {
        throw new Error("configuration(namespace) requires a non-empty namespace");
    }
    const encoded = __host_configuration(namespace);
    _trace_effect({ event: "effect", kind: "configuration", namespace, configured: encoded != null });
    return encoded == null ? fallback : JSON.parse(encoded);
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
 * List source files not owned by any loaded target.
 *
 * Returned paths are workspace-relative, using `/` separators.
 *
 * @param {object} opts
 * @param {string} [opts.root="."] Workspace-relative directory to search.
 * @param {string[]} opts.include Glob patterns matched relative to root.
 * @param {string[]} [opts.exclude=[]] Glob patterns excluded relative to root.
 * @returns {string[]} Sorted workspace-relative file paths.
 */
export function allUnowned(opts) {
    if (!opts || !Array.isArray(opts.include)) {
        throw new Error("allUnowned({ root?, include, exclude? }) requires include glob patterns");
    }
    return JSON.parse(__host_all_unowned(
        opts.root || ".",
        JSON.stringify(opts.include),
        JSON.stringify(opts.exclude || []),
    ));
}

/**
/**
 * Retrieve the kind, attrs, and dep handles for a target handle.
 *
 * @param {object} handle A target handle returned by target().
 * @returns {{ kind: string, attrs: object, deps: Array<{ handle: object, mode: string|null }> }}
 */
export function hydrateTarget(handle) {
    if (!handle || handle.__imp !== true) {
        throw new Error('hydrateTarget: expected a target handle');
    }
    const hydrated = JSON.parse(__host_hydrate_target(handle.__id));
    hydrated.deps = (hydrated.deps || []).map(dep => ({
        ...dep,
        handle: globalThis.__imp_resolve_handle(dep.handle.__id) || dep.handle,
    }));
    return hydrated;
}

/**
 * Return the workspace address for a target handle, e.g. "//:app".
 *
 * @param {object} handle A target handle returned by target().
 * @returns {string}
 */
export function targetAddress(handle) {
    if (!handle || handle.__imp !== true) {
        throw new Error('targetAddress: expected a target handle');
    }
    return __host_target_address(handle.__id);
}

/**
 * List loaded workspace targets.
 *
 * Anonymous target handles created outside BUILD exports are omitted because
 * they do not have stable workspace addresses.
 *
 * @param {string} [kind] Optional target kind filter.
 * @returns {Array<{ id: number, address: string, kind: string, attrs: object, handle: object }>}
 */
export function workspaceTargets(kind = undefined) {
    if (kind !== undefined && typeof kind !== "string") {
        throw new Error("workspaceTargets(kind?) expects kind to be a string when provided");
    }
    const targets = JSON.parse(__host_workspace_targets(kind ?? ""));
    _trace_effect({ event: "effect", kind: "workspaceTargets", target_kind: kind ?? null, count: targets.length });
    return targets.map((target) => ({
        ...target,
        handle: globalThis.__imp_resolve_handle(target.id) || {
            __imp: true,
            __id: target.id,
            kind: target.kind,
            attrs: target.attrs || {},
        },
    }));
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

export function registerBuildRule(opts) {
    if (!opts || typeof opts.rule !== "string" || typeof opts.importFrom !== "string") {
        throw new Error("registerBuildRule({ rule, importFrom, importName? }) requires rule and importFrom");
    }
    __host_register_build_rule(opts.rule, opts.importFrom, opts.importName || opts.rule);
}

export function targetRef(address) {
    if (typeof address !== "string" || !address.startsWith("//")) {
        throw new Error("targetRef(address) requires a workspace target address");
    }
    return { __imp_target_ref: true, address };
}

// ---------------------------------------------------------------------------
// memo() — memoized async build functions (Phase 1)
// ---------------------------------------------------------------------------

const _memo_fn_ids = new WeakMap();
let _memo_fn_counter = 0;
const _fn_id_names = new Map();  // fn_id → fn.name; persists across resetMemoState
const _product_fn_info = new Map();  // fn_id → product_name; persists across resetMemoState

function _stable_function_id(fn) {
    let id = _memo_fn_ids.get(fn);
    if (id === undefined) {
        id = (fn.name || "<anonymous>") + "#" + (++_memo_fn_counter);
        _memo_fn_ids.set(fn, id);
        _fn_id_names.set(id, fn.name || "<anonymous>");
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
let _key_display = new Map();  // key_string → "fnName(arg, ...)"
let _key_product_call = new Map();  // key_string → {target_id, product_name} for product calls
let _introspect_mode = false;

function _active_memo_key() {
    if (_memo_call_stack.length === 0) return null;
    return _memo_call_stack[_memo_call_stack.length - 1];
}

function _trace_effect(entry) {
    const owner = _active_memo_key();
    if (owner !== null) entry.owner = owner;
    _memo_trace.push(entry);
}

function _memo_label(key_string) {
    return _key_display.get(key_string) || key_string;
}

function _memo_cycle_message(key_string) {
    const start = _memo_call_stack.indexOf(key_string);
    const cycle = (start >= 0 ? _memo_call_stack.slice(start) : _memo_call_stack.slice())
        .concat([key_string]);
    const lines = [
        "memo cycle detected:",
        ...cycle.map((key, index) => `  ${index + 1}. ${_memo_label(key)}`),
        "",
        "repeated key:",
        `  ${key_string}`,
    ];
    return lines.join("\n");
}

function _memo_eval(key_string, thunk) {
    // Cycle check BEFORE table check: a key in the call stack means it is
    // currently being evaluated in this call chain.
    if (_memo_call_stack_set.has(key_string)) {
        throw new Error(_memo_cycle_message(key_string));
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
    _product_fn_info.set(_stable_function_id(fn), name);
    return memoized;
}

export function memo(fn) {
    const fn_id = _stable_function_id(fn);
    function display_arg(arg) {
        if (arg && arg.__imp === true) {
            try {
                return targetAddress(arg);
            } catch (_) {
                return "#" + arg.__id;
            }
        }
        return JSON.stringify(arg);
    }
    return async function memoized(...args) {
        const key_string = JSON.stringify({
            fn_id,
            args_digest: _stable_digest(args),
            config_digest: __host_configuration_digest(),
        });
        if (!_key_display.has(key_string)) {
            const label = fn.name + "(" +
                args.map(display_arg).join(", ") +
                ")";
            _key_display.set(key_string, label);
            const product_name = _product_fn_info.get(fn_id);
            if (product_name !== undefined && args.length > 0 && args[0] !== null
                    && typeof args[0] === "object" && args[0].__imp === true) {
                _key_product_call.set(key_string, { target_id: args[0].__id, product_name });
            }
        }
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
    _key_display = new Map();
    _key_product_call = new Map();
}

/**
 * Return a snapshot of the memo trace and dependency graph.
 * @returns {{ trace: Array, deps: Array, key_display: Object, key_product_calls: Object }}
 */
export function getMemoTrace() {
    return {
        trace: _memo_trace.slice(),
        deps: _memo_deps.slice(),
        key_display: Object.fromEntries(_key_display),
        key_product_calls: Object.fromEntries(_key_product_call),
    };
}

/** Enable or disable introspect mode. When enabled, run() captures intent instead of executing. */
export function setIntrospectMode(v) { _introspect_mode = v; }
export function isIntrospectMode() { return _introspect_mode; }

// ---------------------------------------------------------------------------
// Tracked runtime APIs (Phase 3)
// ---------------------------------------------------------------------------

// glob() returns a lazy FileSet descriptor — no I/O happens here.
// Call paths(fileset) to evaluate it.
export function glob(opts) {
    if (!opts || !Array.isArray(opts.include)) {
        throw new Error("glob({ root?, include, exclude? }) requires include glob patterns");
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
    _trace_effect({ event: "effect", kind: "paths", fileset_kind: fileset.kind, count: result.length });
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

export function output_path(path) {
    if (typeof path !== "string" || path.length === 0) {
        throw new Error("output_path(path) requires a non-empty string");
    }
    return path;
}

export function env(name) {
    const result = __host_env(name);
    _trace_effect({ event: "effect", kind: "env", name, result });
    return result ?? null;
}

export function which(name) {
    const result = __host_which(name);
    _trace_effect({ event: "effect", kind: "which", name, result });
    return result ?? null;
}

export function read_file(path) {
    const result = __host_read_file(path);
    _trace_effect({ event: "effect", kind: "read_file", path });
    return result;
}

/**
 * Write file content to a workspace path as a cacheable execution task.
 * Content is computed at plan-evaluation time; the write happens at execution time.
 * @param {{ path: string, content: string, inputs?: any[], display?: string }} opts
 */
export async function write_file(opts) {
    const inputs = _materialise_inputs(opts.inputs);
    const effect = {
        event: "effect",
        kind: "write_file",
        display: opts.display ?? `write ${opts.path}`,
        path: opts.path,
        content: opts.content,
        inputs,
    };
    if (_introspect_mode) {
        effect.dry_run = true;
        _trace_effect(effect);
        return { written: opts.path };
    }
    _trace_effect(effect);
    return { written: opts.path };
}

export async function run(opts) {
    const inputs = _materialise_inputs(opts.inputs);
    const outputs = opts.outputs ?? [];
    const effect = {
        event: "effect",
        kind: "run",
        display: opts.display ?? (opts.argv && opts.argv[0]),
        argv: opts.argv ?? [],
        env: opts.env ?? {},
        inputs,
        outputs,
        tools: opts.tools ?? [],
        impure: opts.impure === true,
        forceCache: opts.forceCache === true,
        sandbox: opts.sandbox !== false,
    };
    if (_introspect_mode) {
        effect.dry_run = true;
        _trace_effect(effect);
        return { exitCode: 0, stdout: "", stderr: "" };
    }
    _trace_effect(effect);
    return __host_run({
        argv: opts.argv,
        display: opts.display,
        env: opts.env,
        inputs,
        outputs,
        tools: opts.tools,
        impure: opts.impure,
        forceCache: opts.forceCache,
        sandbox: opts.sandbox,
    });
}

export async function group(items) {
    if (!Array.isArray(items)) {
        throw new Error("group(items) requires an array");
    }
    _trace_effect({ event: "effect", kind: "group", count: items.length });
    return Promise.all(items);
}

export async function workspace_mutation(opts) {
    const trace_entry = { event: "effect", kind: "workspace_mutation", display: opts.display ?? (opts.argv && opts.argv[0]) };
    _trace_effect(trace_entry);
    const result = await __host_workspace_mutation(opts);
    if (result.changed_files !== undefined) {
        trace_entry.changed_files = result.changed_files;
    }
    return result;
}

// Handle registry: maps numeric js_id → enriched handle for product function dispatch.
globalThis.__imp_handle_by_id = new Map();
globalThis.__imp_resolve_handle = function(id) { return globalThis.__imp_handle_by_id.get(id); };
// Expose introspection helpers as globals so Rust can call them without module imports.
globalThis.resetMemoState = resetMemoState;
globalThis.getMemoTrace = getMemoTrace;
globalThis.setIntrospectMode = setIntrospectMode;

function _fmt(...args) {
    return args.map(a => typeof a === "string" ? a : JSON.stringify(a, null, 2)).join(" ");
}
export function logDebug(...args)  { __host_log("debug", _fmt(...args)); }
export function logInfo(...args)   { __host_log("info", _fmt(...args)); }
export function logWarn(...args)   { __host_log("warn", _fmt(...args)); }
export function logError(...args)  { __host_log("error", _fmt(...args)); }

/** Path to the currently running imp executable. Use as the first element of
 *  an odinGen `cmd` to invoke imp subcommands as generators. */
export const imp_self = globalThis.__imp_self_bin || "imp";
"##;

// ---------------------------------------------------------------------------
// Public data types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Target {
    pub address: String,
    pub kind: String,
    pub attrs: serde_json::Value,
    pub sources: Vec<SourceField>,
    pub dependencies: Vec<Dependency>,
    /// The QuickJS numeric id of this target's handle object (`{ __imp: true, __id: N }`).
    /// Stored so product tasks can reconstruct a valid handle to pass to product functions.
    #[serde(skip)]
    pub js_id: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceField {
    #[serde(default = "default_source_root")]
    pub root: String,
    pub include: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
}

fn default_source_root() -> String {
    ".".to_owned()
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
    #[serde(default)]
    pub tools: Vec<ExecToolSpec>,
    pub display: String,
    #[serde(default)]
    pub impure: bool,
    #[serde(default)]
    pub force_cache: bool,
    #[serde(default = "default_true")]
    pub sandbox: bool,
}

fn default_true() -> bool {
    true
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
    pub dependencies: Vec<String>,
    /// JS handle id for this task's target. Used to reconstruct `{ __imp: true, __id }` for product tasks.
    #[serde(default)]
    pub js_id: u32,
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
    pub targets: BTreeMap<String, Target>,
    pub products: BTreeMap<(String, String), String>,
    pub build_rules: BTreeMap<String, BuildRuleRender>,
    #[allow(dead_code)]
    pub workspace_config: BTreeMap<String, serde_json::Value>,
    pub owned_files: BTreeSet<String>,
    pub named_caches: BTreeMap<String, NamedCache>,
    pub goals: BTreeMap<String, Goal>,
    pub platforms: BTreeMap<String, PlatformDef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildRuleRender {
    pub import_from: String,
    pub import_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildGenerateReport {
    pub changed_files: Vec<String>,
    pub checked_files: Vec<String>,
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
    /// When true, planned tasks neither read from nor write to the task cache.
    pub no_cache: bool,
    /// Name of the active platform; only tasks whose `action.platform` matches
    /// (or is `None`) are executed. Defaults to `"local"`.
    pub platform: String,
    /// Shared cancellation flag set by signal handlers or executor failures.
    pub cancellation: Arc<AtomicBool>,
}

impl ExecutionOptions {
    pub fn new(mode: ExecutionMode, jobs: usize) -> Self {
        Self {
            mode,
            jobs: jobs.max(1),
            no_cache: false,
            platform: "local".to_owned(),
            cancellation: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn with_platform(mut self, platform: impl Into<String>) -> Self {
        self.platform = platform.into();
        self
    }

    pub fn with_no_cache(mut self, no_cache: bool) -> Self {
        self.no_cache = no_cache;
        self
    }

    pub fn with_cancellation(mut self, cancellation: Arc<AtomicBool>) -> Self {
        self.cancellation = cancellation;
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
struct CachedArtifact {
    artifact_id: String,
    kind: String,
    path: Option<String>,
    value: Option<String>,
    digest: String,
    bytes: Option<u64>,
    mode: Option<u32>,
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
    cache_disabled: bool,
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
    products: BTreeMap<(String, String), String>,
    build_rules: BTreeMap<String, BuildRuleRender>,
    workspace_config: BTreeMap<String, serde_json::Value>,
    owned_files: BTreeSet<String>,
    named_caches: BTreeMap<String, NamedCache>,
    goals: BTreeMap<String, Goal>,
    platforms: BTreeMap<String, PlatformDef>,
    id_to_address: BTreeMap<u32, String>,
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
            products: BTreeMap::new(),
            build_rules: BTreeMap::new(),
            workspace_config: BTreeMap::new(),
            owned_files: BTreeSet::new(),
            named_caches: BTreeMap::new(),
            goals,
            platforms,
            id_to_address: BTreeMap::new(),
        }
    }
}

struct PendingTarget {
    kind: String,
    attrs: serde_json::Value,
    sources: Vec<SourceField>,
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
        _attributes: Option<ImportAttributes<'js>>,
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
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> rquickjs::Result<Module<'js>> {
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
#[allow(dead_code)]
pub async fn load_workspace(root: &Path) -> Result<LiveWorkspace> {
    load_workspace_with_host_log(root, HostLogSink::stderr()).await
}

pub async fn load_workspace_with_host_log(
    root: &Path,
    host_log: HostLogSink,
) -> Result<LiveWorkspace> {
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
    )
    .await;
    let ctx = JsContext::full(&rt)
        .await
        .context("create QuickJS context")?;

    // ----- Register host globals -----
    {
        let state_clone = Arc::clone(&state);
        let mounts_clone = Arc::clone(&module_mounts);
        ctx.with(|ctx| -> rquickjs::Result<()> {
            register_globals(
                ctx,
                state_clone,
                root.clone(),
                mounts_clone,
                Arc::clone(&exec_root),
                host_log.clone(),
            )
        })
        .await
        .map_err(|e| anyhow::anyhow!("register QuickJS globals: {e}"))?;
    }

    // ----- Evaluate imp.workspace.js if present -----
    let workspace_js = root.join(WORKSPACE_FILE);
    if workspace_js.is_file() {
        let source = std::fs::read_to_string(&workspace_js)
            .with_context(|| format!("read {}", workspace_js.display()))?;
        ctx.async_with(async |ctx| -> Result<()> {
            let module = Module::declare(ctx.clone(), WORKSPACE_FILE, source)
                .catch(&ctx)
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            let (_, promise) = module
                .eval()
                .catch(&ctx)
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            promise
                .into_future::<rquickjs::Value>()
                .await
                .catch(&ctx)
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            Ok(())
        })
        .await
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
            .async_with(async |ctx| -> Result<Vec<(String, u32)>> {
                // dynamic import → Promise<namespace>
                let promise = Module::import(&ctx, module_name.as_str())
                    .catch(&ctx)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
                let ns: Object = promise
                    .into_future()
                    .await
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
            .await
            .with_context(|| format!("process {}", build_file.display()))?;

        for (name, id) in exports {
            named_exports.push((format!("{scope}:{name}"), id));
        }
    }

    // ----- Resolve dep IDs to addresses -----
    let (workspace, id_to_address_final) = {
        let mut hs = state.lock().unwrap();
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

        run_workspace_analysis(&root, &mut targets, &hs.workspace_config)
            .context("run workspace analysis")?;
        sync_analyzed_dependencies_to_host(&mut hs, &targets);

        let owned_files = compute_owned_files(&root, &targets)?;
        let ws = Workspace {
            targets,
            products: hs.products.clone(),
            build_rules: hs.build_rules.clone(),
            workspace_config: hs.workspace_config.clone(),
            owned_files,
            named_caches: hs.named_caches.clone(),
            goals: hs.goals.clone(),
            platforms: hs.platforms.clone(),
        };
        (ws, id_to_address)
    };

    // Store resolved addresses in HostState so __host_target_address can read them.
    {
        let mut hs = state.lock().unwrap();
        hs.id_to_address = id_to_address_final;
        hs.owned_files = workspace.owned_files.clone();
    }

    Ok(LiveWorkspace {
        workspace,
        runtime: rt,
        ctx,
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
            attrs: pending.attrs.clone(),
            sources: pending.sources.clone(),
            dependencies: deps,
            js_id: id,
        },
    );
    Ok(address)
}

fn run_workspace_analysis(
    workspace_root: &Path,
    targets: &mut BTreeMap<String, Target>,
    workspace_config: &BTreeMap<String, serde_json::Value>,
) -> Result<()> {
    crate::odin::infer_odin_dependencies(workspace_root, targets, workspace_config)
}

fn sync_analyzed_dependencies_to_host(hs: &mut HostState, targets: &BTreeMap<String, Target>) {
    let address_to_id: BTreeMap<&str, u32> = targets
        .values()
        .map(|target| (target.address.as_str(), target.js_id))
        .collect();
    for target in targets.values() {
        let Some(pending) = hs.pending.get_mut(&target.js_id) else {
            continue;
        };
        for dep in &target.dependencies {
            let Some(dep_id) = address_to_id.get(dep.address.as_str()).copied() else {
                continue;
            };
            if pending
                .dep_ids
                .iter()
                .any(|(existing_id, _)| *existing_id == dep_id)
            {
                continue;
            }
            let mode = match &dep.mode {
                DependencyMode::Auto => None,
                DependencyMode::Named(name) => Some(name.clone()),
            };
            pending.dep_ids.push((dep_id, mode));
        }
    }
}

fn compute_owned_files(
    workspace_root: &Path,
    targets: &BTreeMap<String, Target>,
) -> Result<BTreeSet<String>> {
    let mut owned = BTreeSet::new();
    for target in targets.values() {
        for source in &target.sources {
            if source.include.is_empty() {
                continue;
            }
            let root = source_field_workspace_root(&target.address, &source.root)?;
            for file in
                workspace_glob_files(workspace_root, &root, &source.include, &source.exclude)
                    .with_context(|| format!("expand sources for {}", target.address))?
            {
                owned.insert(file);
            }
        }
    }
    Ok(owned)
}

pub(crate) fn source_field_workspace_root(address: &str, root: &str) -> Result<String> {
    let source_root = root.trim();
    if let Some(workspace_rooted) = source_root.strip_prefix("//") {
        let relative = workspace_relative_directory(workspace_rooted)?;
        return Ok(path_to_workspace_string(&relative));
    }

    let mut base = target_scope_path(address)?;
    let local = workspace_relative_directory(source_root)?;
    if !local.as_os_str().is_empty() {
        base.push(local);
    }
    Ok(path_to_workspace_string(&base))
}

pub(crate) fn target_scope_path(address: &str) -> Result<PathBuf> {
    let (scope, _) = address
        .split_once(':')
        .ok_or_else(|| anyhow::anyhow!("target address '{address}' must include ':'"))?;
    let scope = scope
        .strip_prefix("//")
        .ok_or_else(|| anyhow::anyhow!("target address '{address}' must start with //"))?;
    workspace_relative_directory(scope)
}

pub(crate) fn path_to_workspace_string(path: &Path) -> String {
    if path.as_os_str().is_empty() {
        ".".to_owned()
    } else {
        path.to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/")
    }
}

/// Register host globals on `ctx`.
fn register_globals<'js>(
    ctx: Ctx<'js>,
    state: Arc<Mutex<HostState>>,
    workspace_root: PathBuf,
    module_mounts: Arc<Mutex<Vec<ModuleMount>>>,
    exec_root: Arc<Mutex<Option<PathBuf>>>,
    host_log: HostLogSink,
) -> rquickjs::Result<()> {
    let globals = ctx.globals();

    // ------------------------------------------------------------------
    // __host_target(kind, attrsJson, sourcesJson, depIds, depModes) → u32 (handle id)
    // depIds: Array<number>, depModes: Array<string|null> (parallel arrays)
    // ------------------------------------------------------------------
    let state_t = Arc::clone(&state);
    let host_target = Function::new(
        ctx.clone(),
        move |_ctx: Ctx<'js>,
              kind: String,
              attrs_json: String,
              sources_json: String,
              dep_ids: Array<'js>,
              dep_modes: Array<'js>|
              -> rquickjs::Result<u32> {
            let mut hs = state_t.lock().unwrap();
            let id = hs.next_id;
            hs.next_id += 1;

            let attrs: serde_json::Value = serde_json::from_str(&attrs_json).map_err(|e| {
                rquickjs::Error::new_loading_message("__host_target", e.to_string())
            })?;
            let sources: Vec<SourceField> = serde_json::from_str(&sources_json).map_err(|e| {
                rquickjs::Error::new_loading_message("__host_target", e.to_string())
            })?;

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
                    attrs,
                    sources,
                    dep_ids: dep_id_list,
                },
            );
            Ok(id)
        },
    )?;
    globals.set("__host_target", host_target)?;

    // ------------------------------------------------------------------
    // __host_product(kind, name, fn)
    // ------------------------------------------------------------------
    let state_p = Arc::clone(&state);
    let host_product = Function::new(
        ctx.clone(),
        move |ctx: Ctx<'js>,
              kind: String,
              name: String,
              fn_val: Value<'js>|
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

    let state_br = Arc::clone(&state);
    let host_register_build_rule = Function::new(
        ctx.clone(),
        move |_ctx: Ctx<'js>,
              rule: String,
              import_from: String,
              import_name: String|
              -> rquickjs::Result<()> {
            if rule.is_empty() || import_from.is_empty() || import_name.is_empty() {
                return Err(rquickjs::Error::new_loading_message(
                    "__host_register_build_rule",
                    "rule, importFrom, and importName must be non-empty",
                ));
            }
            state_br.lock().unwrap().build_rules.insert(
                rule,
                BuildRuleRender {
                    import_from,
                    import_name,
                },
            );
            Ok(())
        },
    )?;
    globals.set("__host_register_build_rule", host_register_build_rule)?;

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
    // __host_configure(namespace, valueJson)
    // __host_configuration(namespace) → JSON string | null
    // __host_configuration_digest() → hex digest
    // ------------------------------------------------------------------
    let state_cfg = Arc::clone(&state);
    let host_configure = Function::new(
        ctx.clone(),
        move |namespace: String, value_json: String| -> rquickjs::Result<()> {
            validate_config_namespace(&namespace)?;
            let value: serde_json::Value = serde_json::from_str(&value_json).map_err(|e| {
                rquickjs::Error::new_loading_message("configure", format!("parse value: {e}"))
            })?;

            let mut hs = state_cfg.lock().unwrap();
            if let Some(existing) = hs.workspace_config.get_mut(&namespace) {
                merge_workspace_config(existing, value);
            } else {
                hs.workspace_config.insert(namespace, value);
            }
            Ok(())
        },
    )?;
    globals.set("__host_configure", host_configure)?;

    let state_cfg = Arc::clone(&state);
    let host_configuration = Function::new(
        ctx.clone(),
        move |namespace: String| -> rquickjs::Result<Option<String>> {
            validate_config_namespace(&namespace)?;
            let hs = state_cfg.lock().unwrap();
            hs.workspace_config
                .get(&namespace)
                .map(|value| {
                    serde_json::to_string(value).map_err(|e| {
                        rquickjs::Error::new_loading_message("configuration", e.to_string())
                    })
                })
                .transpose()
        },
    )?;
    globals.set("__host_configuration", host_configuration)?;

    let state_cfg = Arc::clone(&state);
    let host_configuration_digest =
        Function::new(ctx.clone(), move || -> rquickjs::Result<String> {
            let hs = state_cfg.lock().unwrap();
            digest_json(&hs.workspace_config).map_err(|e| {
                rquickjs::Error::new_loading_message("configurationDigest", format!("{e:#}"))
            })
        })?;
    globals.set("__host_configuration_digest", host_configuration_digest)?;

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
    // __host_all_unowned(root, includeJson, excludeJson)
    // ------------------------------------------------------------------
    let wc = workspace_root.clone();
    let state_unowned = Arc::clone(&state);
    let host_all_unowned = Function::new(
        ctx.clone(),
        move |root: String,
              include_json: String,
              exclude_json: String|
              -> rquickjs::Result<String> {
            let include: Vec<String> = serde_json::from_str(&include_json).map_err(|e| {
                rquickjs::Error::new_loading_message(
                    "allUnowned",
                    format!("parse include globs: {e}"),
                )
            })?;
            let exclude: Vec<String> = serde_json::from_str(&exclude_json).map_err(|e| {
                rquickjs::Error::new_loading_message(
                    "allUnowned",
                    format!("parse exclude globs: {e}"),
                )
            })?;
            let owned = state_unowned.lock().unwrap().owned_files.clone();
            let mut files = workspace_glob_files(&wc, &root, &include, &exclude).map_err(|e| {
                rquickjs::Error::new_loading_message("allUnowned", format!("{e:#}"))
            })?;
            files.retain(|file| !owned.contains(file));
            serde_json::to_string(&files).map_err(|e| {
                rquickjs::Error::new_loading_message("allUnowned", format!("encode files: {e}"))
            })
        },
    )?;
    globals.set("__host_all_unowned", host_all_unowned)?;

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
    let host_hydrate_target =
        Function::new(ctx.clone(), move |id: u32| -> rquickjs::Result<String> {
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
                "attrs": pending.attrs,
                "deps": deps,
            });
            serde_json::to_string(&json)
                .map_err(|e| rquickjs::Error::new_loading_message("hydrateTarget", e.to_string()))
        })?;
    globals.set("__host_hydrate_target", host_hydrate_target)?;

    // ------------------------------------------------------------------
    // __host_target_address(id) → address string
    // ------------------------------------------------------------------
    let state_addr = Arc::clone(&state);
    let host_target_address =
        Function::new(ctx.clone(), move |id: u32| -> rquickjs::Result<String> {
            let hs = state_addr.lock().unwrap();
            hs.id_to_address.get(&id).cloned().ok_or_else(|| {
                rquickjs::Error::new_loading_message(
                    "targetAddress",
                    format!("no address for target id {id}"),
                )
            })
        })?;
    globals.set("__host_target_address", host_target_address)?;

    // ------------------------------------------------------------------
    // __host_workspace_targets(kind) → JSON [{ id, address, kind, attrs }]
    // ------------------------------------------------------------------
    let state_targets = Arc::clone(&state);
    let host_workspace_targets = Function::new(
        ctx.clone(),
        move |kind: String| -> rquickjs::Result<String> {
            let hs = state_targets.lock().unwrap();
            let mut targets = Vec::new();
            for (id, address) in &hs.id_to_address {
                let Some(pending) = hs.pending.get(id) else {
                    continue;
                };
                if !kind.is_empty() && pending.kind != kind {
                    continue;
                }
                targets.push(serde_json::json!({
                    "id": id,
                    "address": address,
                    "kind": pending.kind,
                    "attrs": pending.attrs,
                }));
            }
            serde_json::to_string(&targets).map_err(|e| {
                rquickjs::Error::new_loading_message("workspaceTargets", e.to_string())
            })
        },
    )?;
    globals.set("__host_workspace_targets", host_workspace_targets)?;

    // ------------------------------------------------------------------
    // Tracked runtime APIs (Phase 3)
    // ------------------------------------------------------------------

    // __host_glob(root, includeJson, excludeJson) → JSON string[]
    let wc = workspace_root.clone();
    let host_glob = Function::new(
        ctx.clone(),
        move |root: String,
              include_json: String,
              exclude_json: String|
              -> rquickjs::Result<String> {
            let include: Vec<String> = serde_json::from_str(&include_json)
                .map_err(|e| rquickjs::Error::new_loading_message("glob", e.to_string()))?;
            let exclude: Vec<String> = serde_json::from_str(&exclude_json)
                .map_err(|e| rquickjs::Error::new_loading_message("glob", e.to_string()))?;
            workspace_glob_files(&wc, &root, &include, &exclude)
                .and_then(|f| serde_json::to_string(&f).context("encode glob results"))
                .map_err(|e| rquickjs::Error::new_loading_message("glob", format!("{e:#}")))
        },
    )?;
    globals.set("__host_glob", host_glob)?;

    // __host_env(name) → string | null
    let host_env = Function::new(
        ctx.clone(),
        move |name: String| -> rquickjs::Result<Option<String>> { Ok(std::env::var(&name).ok()) },
    )?;
    globals.set("__host_env", host_env)?;

    // __host_which(name) → string | null
    let host_which = Function::new(
        ctx.clone(),
        move |name: String| -> rquickjs::Result<Option<String>> { Ok(which_executable(&name)) },
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
                let root = exec_root_rf
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(|| wc_rf.clone());
                root.join(p)
            };
            std::fs::read_to_string(&resolved).map_err(|e| {
                rquickjs::Error::new_loading_message(
                    "read_file",
                    format!("{}: {e}", resolved.display()),
                )
            })
        },
    )?;
    globals.set("__host_read_file", host_read_file)?;

    // __host_run(opts) → { stdout, stderr, exitCode }
    // Delegates to exec_run_inner with the active exec workspace root.
    let exec_root_run = Arc::clone(&exec_root);
    let host_run = Function::new(
        ctx.clone(),
        Async(move |ctx: Ctx<'js>, opts: Object<'js>| {
            let exec_root_run = Arc::clone(&exec_root_run);
            async move {
                let root = exec_root_run.lock().unwrap().clone().ok_or_else(|| {
                    rquickjs::Error::new_loading_message(
                        "run",
                        "run() called outside of execution context",
                    )
                })?;
                let run_opts = parse_exec_run_opts(opts, &root)?;
                let result = tokio::task::spawn_blocking(move || exec_run_inner(&root, run_opts))
                    .await
                    .map_err(|e| {
                        rquickjs::Error::new_loading_message(
                            "run",
                            format!("native run task failed: {e}"),
                        )
                    })?
                    .map_err(|e| rquickjs::Error::new_loading_message("run", format!("{e:#}")))?;
                let obj = Object::new(ctx)?;
                obj.set("stdout", result.stdout)?;
                obj.set("stderr", result.stderr)?;
                obj.set("exitCode", result.exit_code)?;
                Ok::<Object<'js>, rquickjs::Error>(obj)
            }
        }),
    )?;
    globals.set("__host_run", host_run)?;

    // __host_workspace_mutation(opts) → { stdout, stderr, exitCode, changed_files? }
    // Runs a command directly in the workspace root (not a sandbox). Always impure.
    // When opts.watch is provided (array of regex strings), snaps workspace files
    // matching those patterns before and after, and returns changed_files in the result.
    let exec_root_wm = Arc::clone(&exec_root);
    let host_workspace_mutation = Function::new(
        ctx.clone(),
        Async(move |ctx: Ctx<'js>, opts: Object<'js>| {
            let exec_root_wm = Arc::clone(&exec_root_wm);
            async move {
                let root = exec_root_wm.lock().unwrap().clone().ok_or_else(|| {
                    rquickjs::Error::new_loading_message(
                        "workspace_mutation",
                        "workspace_mutation() called outside of execution context",
                    )
                })?;
                let argv: Vec<String> = opts.get("argv")?;
                let display: Option<String> = opts.get("display")?;
                let display = display.unwrap_or_else(|| argv.join(" "));
                let watch: Option<Vec<String>> = opts.get("watch")?;
                let (stdout, stderr, exit_code, changed_files) =
                    tokio::task::spawn_blocking(move || -> Result<_> {
                        let pre = watch
                            .as_deref()
                            .map(|patterns| {
                                snapshot_watched_files(&root, patterns)
                                    .with_context(|| "pre-snapshot")
                            })
                            .transpose()?;

                        let (program, args) = argv
                            .split_first()
                            .ok_or_else(|| anyhow::anyhow!("argv must not be empty"))?;
                        let output = std::process::Command::new(program)
                            .args(args)
                            .current_dir(&root)
                            .output()
                            .with_context(|| format!("spawn {display}"))?;

                        let changed_files = if let Some(pre_snap) = pre {
                            let watch = watch.as_deref().unwrap_or_default();
                            let post_snap = snapshot_watched_files(&root, watch)
                                .with_context(|| "post-snapshot")?;
                            Some(diff_snapshots(&pre_snap, &post_snap))
                        } else {
                            None
                        };

                        Ok((
                            String::from_utf8_lossy(&output.stdout).to_string(),
                            String::from_utf8_lossy(&output.stderr).to_string(),
                            output.status.code().unwrap_or(-1),
                            changed_files,
                        ))
                    })
                    .await
                    .map_err(|e| {
                        rquickjs::Error::new_loading_message(
                            "workspace_mutation",
                            format!("native mutation task failed: {e}"),
                        )
                    })?
                    .map_err(|e| {
                        rquickjs::Error::new_loading_message("workspace_mutation", format!("{e:#}"))
                    })?;

                let obj = Object::new(ctx.clone())?;
                obj.set("stdout", stdout)?;
                obj.set("stderr", stderr)?;
                obj.set("exitCode", exit_code)?;

                if let Some(changed) = changed_files {
                    let arr = rquickjs::Array::new(ctx)?;
                    for (i, entry) in changed.iter().enumerate() {
                        arr.set(i, entry.as_str())?;
                    }
                    obj.set("changed_files", arr)?;
                }

                Ok::<Object<'js>, rquickjs::Error>(obj)
            }
        }),
    )?;
    globals.set("__host_workspace_mutation", host_workspace_mutation)?;

    // ------------------------------------------------------------------
    // __host_log(level, message)
    // ------------------------------------------------------------------
    let host_log_sink = host_log.clone();
    let host_log = Function::new(
        ctx.clone(),
        move |_ctx: Ctx<'js>, level: String, message: String| -> rquickjs::Result<()> {
            let mut writer = host_log_sink.writer(level);
            writeln!(&mut writer, "{message}").map_err(|e| {
                rquickjs::Error::new_loading_message("log", format!("write log message: {e}"))
            })?;
            Ok(())
        },
    )?;
    globals.set("__host_log", host_log)?;

    // Expose the current executable path so JS rules can invoke imp as a generator.
    if let Ok(exe) = std::env::current_exe() {
        globals.set("__imp_self_bin", exe.to_string_lossy().into_owned())?;
    }

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

fn parse_exec_run_opts<'js>(
    opts: Object<'js>,
    workspace_root: &Path,
) -> rquickjs::Result<ExecRunOpts> {
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
        workspace_root,
    )?;
    let impure = opts.get::<_, Option<bool>>("impure")?.unwrap_or(false);
    let force_cache = opts.get::<_, Option<bool>>("forceCache")?.unwrap_or(false);
    let sandbox = opts.get::<_, Option<bool>>("sandbox")?.unwrap_or(true);
    Ok(ExecRunOpts {
        argv,
        display,
        env,
        inputs,
        outputs,
        tools,
        impure,
        force_cache,
        sandbox,
    })
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

pub(crate) fn workspace_glob_files(
    workspace_root: &Path,
    root: &str,
    include: &[String],
    exclude: &[String],
) -> Result<Vec<String>> {
    if include.is_empty() {
        bail!("glob include must not be empty");
    }
    let include = compile_globs("include", include)?;
    let exclude = compile_globs("exclude", exclude)?;
    let directory = workspace_root.join(workspace_relative_directory(root)?);
    if !directory.is_dir() {
        bail!("glob root '{}' is not a directory", directory.display());
    }

    let mut files = Vec::new();
    for entry in WalkDir::new(&directory)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
    {
        let workspace_relative = entry
            .path()
            .strip_prefix(workspace_root)
            .with_context(|| format!("relativize {}", entry.path().display()))?;
        let workspace_relative = workspace_relative
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        let root_relative = entry
            .path()
            .strip_prefix(&directory)
            .with_context(|| format!("relativize {}", entry.path().display()))?;
        let root_relative = root_relative
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");

        if include.iter().any(|glob| glob.is_match(&root_relative))
            && !exclude.iter().any(|glob| glob.is_match(&root_relative))
        {
            files.push(workspace_relative);
        }
    }
    files.sort();
    Ok(files)
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

/// Snapshot workspace files matching `patterns` (regex strings, rooted at workspace root).
/// Returns a map of relative path → content digest.
fn snapshot_watched_files(
    workspace_root: &Path,
    patterns: &[String],
) -> Result<std::collections::HashMap<String, String>> {
    let paths = matching_workspace_source_paths(workspace_root, ".", patterns, &[])?;
    let mut snap = std::collections::HashMap::new();
    for path in paths {
        let abs = workspace_root.join(path.replace('/', std::path::MAIN_SEPARATOR_STR));
        let (digest, _) = store_file_blob(&abs, "watch")
            .with_context(|| format!("snapshot {}", abs.display()))?;
        snap.insert(path, digest);
    }
    Ok(snap)
}

/// Diff two snapshots. Returns sorted entries prefixed with `+` (created), `-` (deleted),
/// or bare (modified).
fn diff_snapshots(
    pre: &std::collections::HashMap<String, String>,
    post: &std::collections::HashMap<String, String>,
) -> Vec<String> {
    let mut result = Vec::new();
    for (path, post_digest) in post {
        match pre.get(path) {
            None => result.push(format!("+{path}")),
            Some(pre_digest) if pre_digest != post_digest => result.push(path.clone()),
            _ => {}
        }
    }
    for path in pre.keys() {
        if !post.contains_key(path) {
            result.push(format!("-{path}"));
        }
    }
    result.sort();
    result
}

fn compile_regexes(label: &str, patterns: &[String]) -> Result<Vec<Regex>> {
    patterns
        .iter()
        .map(|pattern| {
            Regex::new(pattern).with_context(|| format!("compile {label} source regex {pattern:?}"))
        })
        .collect()
}

fn compile_globs(label: &str, patterns: &[String]) -> Result<Vec<Regex>> {
    patterns
        .iter()
        .map(|pattern| {
            let regex = glob_pattern_to_regex(pattern);
            Regex::new(&regex).with_context(|| format!("compile {label} glob {pattern:?}"))
        })
        .collect()
}

fn glob_pattern_to_regex(pattern: &str) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut regex = String::from("^");
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '*' if chars.get(i + 1) == Some(&'*') => {
                i += 2;
                if chars.get(i) == Some(&'/') {
                    i += 1;
                    regex.push_str("(?:.*/)?");
                } else {
                    regex.push_str(".*");
                }
            }
            '*' => {
                regex.push_str("[^/]*");
                i += 1;
            }
            '?' => {
                regex.push_str("[^/]");
                i += 1;
            }
            '[' => {
                if let Some((class, next)) = glob_char_class_to_regex(&chars, i) {
                    regex.push_str(&class);
                    i = next;
                } else {
                    regex.push_str(r"\[");
                    i += 1;
                }
            }
            '\\' => {
                if let Some(next) = chars.get(i + 1) {
                    regex.push_str(&regex::escape(&next.to_string()));
                    i += 2;
                } else {
                    regex.push_str(r"\\");
                    i += 1;
                }
            }
            c => {
                regex.push_str(&regex::escape(&c.to_string()));
                i += 1;
            }
        }
    }
    regex.push('$');
    regex
}

fn glob_char_class_to_regex(chars: &[char], start: usize) -> Option<(String, usize)> {
    let mut i = start + 1;
    if i >= chars.len() {
        return None;
    }

    let mut class = String::from("[");
    if chars[i] == '!' {
        class.push('^');
        i += 1;
    } else if chars[i] == '^' {
        class.push('\\');
        class.push('^');
        i += 1;
    }

    let mut has_member = false;
    while i < chars.len() {
        let c = chars[i];
        if c == ']' && has_member {
            class.push(']');
            return Some((class, i + 1));
        }
        if c == '\\' {
            class.push('\\');
            class.push('\\');
        } else {
            class.push(c);
        }
        has_member = true;
        i += 1;
    }

    None
}

pub(crate) fn workspace_relative_directory(path: &str) -> Result<PathBuf> {
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

fn action_spec_error(message: String) -> rquickjs::Error {
    rquickjs::Error::new_from_js_message("value", "imp host API", message)
}

fn validate_config_namespace(namespace: &str) -> rquickjs::Result<()> {
    if namespace.is_empty()
        || !namespace
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(action_spec_error(format!(
            "configuration namespace '{namespace}' must use ASCII letters, digits, '.', '-', or '_'"
        )));
    }
    Ok(())
}

fn merge_workspace_config(existing: &mut serde_json::Value, patch: serde_json::Value) {
    match (existing, patch) {
        (serde_json::Value::Object(existing), serde_json::Value::Object(patch)) => {
            for (key, value) in patch {
                if let Some(existing_value) = existing.get_mut(&key) {
                    merge_workspace_config(existing_value, value);
                } else {
                    existing.insert(key, value);
                }
            }
        }
        (existing, patch) => {
            *existing = patch;
        }
    }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

#[cfg(test)]
pub async fn plan(workspace: &Workspace, goal: &str, selectors: &[String]) -> Result<Plan> {
    plan_inner(workspace, None, None, goal, selectors).await
}

pub async fn plan_live(
    live: &LiveWorkspace,
    workspace_root: &Path,
    goal: &str,
    selectors: &[String],
) -> Result<Plan> {
    plan_inner(
        &live.workspace,
        Some(live),
        Some(workspace_root),
        goal,
        selectors,
    )
    .await
}

async fn plan_inner(
    workspace: &Workspace,
    live: Option<&LiveWorkspace>,
    workspace_root: Option<&Path>,
    goal: &str,
    selectors: &[String],
) -> Result<Plan> {
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
        live,
        workspace_root,
        tasks: BTreeMap::new(),
    };
    let mut root_tasks = Vec::new();
    for (target, product) in &roots {
        root_tasks.push(planner.request(&target.address, product).await?);
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
            let product =
                goal_product_for_kind(workspace, goal, &default_target.kind).ok_or_else(|| {
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
                    if !workspace.products.contains_key(&key) {
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
            if workspace.products.contains_key(&key) {
                Some(p.clone())
            } else {
                None
            }
        }
    }
}

/// Infer the default product for a target kind from target attrs or registered products.
fn default_product_for_kind<'a>(workspace: &'a Workspace, kind: &str) -> Option<&'a str> {
    for ((k, p), _) in &workspace.products {
        if k == kind && !matches!(p.as_str(), "sources" | "collection" | "test") {
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
    live: Option<&'a LiveWorkspace>,
    workspace_root: Option<&'a Path>,
    tasks: BTreeMap<String, Task>,
}

impl Planner<'_> {
    async fn request(&mut self, target_address: &str, product: &str) -> Result<String> {
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

        if self
            .workspace
            .products
            .get(&(kind, product.to_owned()))
            .is_some()
        {
            let target = self.workspace.targets.get(target_address).unwrap();
            if let (Some(live), Some(workspace_root)) = (self.live, self.workspace_root) {
                let root_id = add_product_discovered_tasks(
                    live,
                    workspace_root,
                    target,
                    product,
                    &mut self.tasks,
                )
                .await?;
                return Ok(root_id);
            }

            // Static compatibility path for callers that only have a serialized Workspace.
            self.tasks.insert(
                id.clone(),
                Task {
                    id: id.clone(),
                    target: target.address.clone(),
                    product: product.to_owned(),
                    fields: BTreeMap::new(),
                    inputs: Vec::new(),
                    outputs: Vec::new(),
                    action: Action {
                        argv: Vec::new(),
                        cwd: None,
                        env: BTreeMap::new(),
                        platform: None,
                        inputs: Vec::new(),
                        outputs: Vec::new(),
                        tools: Vec::new(),
                        display: format!("product {product}"),
                        impure: false,
                        force_cache: false,
                        sandbox: true,
                    },
                    dependencies: Vec::new(),
                    js_id,
                },
            );
        } else {
            bail!("{} cannot produce {product}", target_address);
        }

        Ok(id)
    }
}

async fn add_product_discovered_tasks(
    live: &LiveWorkspace,
    workspace_root: &Path,
    target: &Target,
    product: &str,
    tasks: &mut BTreeMap<String, Task>,
) -> Result<String> {
    let result = introspect_product(live, &target.address, product).await?;
    let prefix = format!("{}#{}", target.address, product);
    let id_to_address: std::collections::HashMap<u32, &str> = live
        .workspace
        .targets
        .values()
        .map(|t| (t.js_id, t.address.as_str()))
        .collect();
    let mut key_order = Vec::new();
    let mut seen_keys = BTreeSet::new();

    for entry in &result.trace {
        if entry["event"] == "miss" {
            if let Some(key) = entry["key"].as_str() {
                if seen_keys.insert(key.to_owned()) {
                    key_order.push(key.to_owned());
                }
            }
        }
    }
    for dep in &result.deps {
        for field in ["caller", "callee"] {
            if let Some(key) = dep[field].as_str() {
                if seen_keys.insert(key.to_owned()) {
                    key_order.push(key.to_owned());
                }
            }
        }
    }

    let mut key_to_task = BTreeMap::new();
    for (index, key) in key_order.iter().enumerate() {
        let task_id = format!("{prefix}:memo{index}");
        key_to_task.insert(key.clone(), task_id.clone());
        let display = result
            .key_display
            .get(key)
            .cloned()
            .unwrap_or_else(|| key.clone());
        tasks.entry(task_id.clone()).or_insert_with(|| Task {
            id: task_id,
            target: target.address.clone(),
            product: product.to_owned(),
            fields: BTreeMap::new(),
            inputs: Vec::new(),
            outputs: Vec::new(),
            action: Action {
                argv: Vec::new(),
                cwd: None,
                env: BTreeMap::new(),
                platform: None,
                inputs: Vec::new(),
                outputs: Vec::new(),
                tools: Vec::new(),
                display,
                impure: false,
                force_cache: false,
                sandbox: true,
            },
            dependencies: Vec::new(),
            js_id: target.js_id,
        });
    }

    let mut memo_children: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut has_parent = BTreeSet::new();
    for dep in &result.deps {
        let Some(caller_key) = dep["caller"].as_str() else {
            continue;
        };
        let Some(callee_key) = dep["callee"].as_str() else {
            continue;
        };
        let Some(caller_task) = key_to_task.get(caller_key).cloned() else {
            continue;
        };
        let Some(callee_task) = key_to_task.get(callee_key).cloned() else {
            continue;
        };
        has_parent.insert(callee_key.to_owned());
        memo_children
            .entry(caller_key.to_owned())
            .or_default()
            .push(callee_task.clone());
        if let Some(task) = tasks.get_mut(&caller_task) {
            push_unique(&mut task.dependencies, callee_task);
        }
    }

    let mut run_index_by_prefix: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for entry in &result.trace {
        let kind = entry["kind"].as_str().unwrap_or("");
        if entry["event"] != "effect" || !matches!(kind, "run" | "write_file") {
            continue;
        }
        let owner_key = entry["owner"].as_str();
        // Determine the prefix for this run effect. If the owner memo is a product
        // call on a different (foreign) target, use that target's address and product
        // name so the task ID reflects where the action actually belongs.
        let (effective_prefix, effective_target, effective_product) = owner_key
            .and_then(|ok| result.key_product_calls.get(ok))
            .and_then(|(foreign_js_id, foreign_product_name)| {
                let foreign_addr = id_to_address.get(foreign_js_id)?;
                if *foreign_addr == target.address.as_str() {
                    return None;
                }
                Some((
                    format!("{}#{}", foreign_addr, foreign_product_name),
                    foreign_addr.to_string(),
                    foreign_product_name.clone(),
                ))
            })
            .unwrap_or_else(|| (prefix.clone(), target.address.clone(), product.to_owned()));
        let run_counter = run_index_by_prefix
            .entry(effective_prefix.clone())
            .or_insert(0);
        let task_id = format!("{}:run{}", effective_prefix, run_counter);
        *run_counter += 1;
        let mut dependencies = Vec::new();
        if let Some(owner_key) = owner_key {
            if let Some(children) = memo_children.get(owner_key) {
                for child in children {
                    push_unique(&mut dependencies, child.clone());
                }
            }
        }
        let (inputs, outputs, action) = if kind == "write_file" {
            let path = entry["path"].as_str().unwrap_or("").to_owned();
            let content = entry["content"].as_str().unwrap_or("").to_owned();
            let inputs = artifacts_from_json(&entry["inputs"], &task_id, "input", None);
            let out_artifact = Artifact {
                id: format!("{task_id}:output0"),
                kind: "file".to_owned(),
                path: Some(path.clone()),
                value: Some(content),
                producer: Some(task_id.clone()),
            };
            let action = Action {
                argv: Vec::new(),
                cwd: None,
                env: BTreeMap::new(),
                platform: None,
                inputs: inputs.iter().map(|a| a.id.clone()).collect(),
                outputs: vec![out_artifact.id.clone()],
                tools: Vec::new(),
                display: entry["display"]
                    .as_str()
                    .unwrap_or_else(|| &path)
                    .to_owned(),
                impure: false,
                force_cache: false,
                sandbox: true,
            };
            (inputs, vec![out_artifact], action)
        } else {
            let inputs = artifacts_from_json(&entry["inputs"], &task_id, "input", None);
            let outputs =
                artifacts_from_json(&entry["outputs"], &task_id, "output", Some(&task_id));
            let action = Action {
                argv: strings_from_json_array(&entry["argv"]),
                cwd: None,
                env: env_from_json_object(&entry["env"]),
                platform: None,
                inputs: inputs.iter().map(|artifact| artifact.id.clone()).collect(),
                outputs: outputs.iter().map(|artifact| artifact.id.clone()).collect(),
                tools: tools_from_json_array(&entry["tools"], workspace_root)?,
                display: entry["display"]
                    .as_str()
                    .unwrap_or("<unnamed run>")
                    .to_owned(),
                impure: entry["impure"].as_bool().unwrap_or(false),
                force_cache: entry["forceCache"].as_bool().unwrap_or(false),
                sandbox: entry["sandbox"].as_bool().unwrap_or(true),
            };
            (inputs, outputs, action)
        };
        let effective_js_id = live
            .workspace
            .targets
            .get(&effective_target)
            .map(|t| t.js_id)
            .unwrap_or(target.js_id);
        tasks.insert(
            task_id.clone(),
            Task {
                id: task_id.clone(),
                target: effective_target,
                product: effective_product,
                fields: BTreeMap::new(),
                inputs,
                outputs,
                action,
                dependencies,
                js_id: effective_js_id,
            },
        );
        if let Some(owner_key) = owner_key {
            if let Some(owner_task_id) = key_to_task.get(owner_key) {
                if let Some(owner_task) = tasks.get_mut(owner_task_id) {
                    push_unique(&mut owner_task.dependencies, task_id);
                }
            }
        }
    }

    let roots: Vec<String> = key_order
        .iter()
        .filter(|key| !has_parent.contains(*key))
        .filter_map(|key| key_to_task.get(key).cloned())
        .collect();
    if let Some(root) = roots.first() {
        return Ok(root.clone());
    }

    let task_id = format!("{prefix}:memo0");
    tasks.entry(task_id.clone()).or_insert_with(|| Task {
        id: task_id.clone(),
        target: target.address.clone(),
        product: product.to_owned(),
        fields: BTreeMap::new(),
        inputs: Vec::new(),
        outputs: Vec::new(),
        action: Action {
            argv: Vec::new(),
            cwd: None,
            env: BTreeMap::new(),
            platform: None,
            inputs: Vec::new(),
            outputs: Vec::new(),
            tools: Vec::new(),
            display: format!("{}({})", product, target.address),
            impure: false,
            force_cache: false,
            sandbox: true,
        },
        dependencies: Vec::new(),
        js_id: target.js_id,
    });
    Ok(task_id)
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.iter().any(|existing| existing == &value) {
        values.push(value);
    }
}

fn strings_from_json_array(value: &serde_json::Value) -> Vec<String> {
    value
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn env_from_json_object(value: &serde_json::Value) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    if let Some(obj) = value.as_object() {
        for (key, value) in obj {
            if let Some(value) = value.as_str() {
                env.insert(key.clone(), value.to_owned());
            }
        }
    }
    env
}

fn artifacts_from_json(
    value: &serde_json::Value,
    task_id: &str,
    role: &str,
    producer: Option<&str>,
) -> Vec<Artifact> {
    let mut artifacts = Vec::new();
    let Some(array) = value.as_array() else {
        return artifacts;
    };
    for (index, item) in array.iter().enumerate() {
        let kind = item["kind"].as_str().unwrap_or("file").to_owned();
        let path = item["path"].as_str().map(str::to_owned);
        let value = item["value"].as_str().map(str::to_owned);
        let id = item["id"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{task_id}:{role}{index}"));
        artifacts.push(Artifact {
            id,
            kind,
            path,
            value,
            producer: producer.map(str::to_owned),
        });
    }
    artifacts
}

fn tools_from_json_array(
    value: &serde_json::Value,
    workspace_root: &Path,
) -> Result<Vec<ExecToolSpec>> {
    let mut tools = Vec::new();
    let Some(array) = value.as_array() else {
        return Ok(tools);
    };
    for item in array {
        let Some(name) = item["name"].as_str() else {
            continue;
        };
        let cache = item["cache"].as_str().unwrap_or_default().to_owned();
        let key = item["key"].as_str().unwrap_or_default().to_owned();
        let path = if let Some(path) = item["path"].as_str() {
            PathBuf::from(path)
        } else {
            named_cache_key_path(workspace_root, &cache, &key)?
        };
        let bin_dirs = item["binDirs"]
            .as_array()
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str().map(str::to_owned))
                    .collect::<Vec<_>>()
            })
            .filter(|values| !values.is_empty())
            .unwrap_or_else(|| vec!["bin".to_owned()]);
        tools.push(ExecToolSpec {
            name: name.to_owned(),
            cache,
            key,
            path,
            bin_dirs,
        });
    }
    Ok(tools)
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
    _live: Option<&LiveWorkspace>,
    workspace_root: &Path,
    options: ExecutionOptions,
    progress: Option<&mut prodash::tree::Item>,
) -> Result<ExecutionReport> {
    let ordered = ordered_tasks(plan)?;
    if let Some(progress) = progress.as_deref() {
        progress.set(0);
        progress.set_max(Some(ordered.len()));
    }

    let executions = if options.jobs <= 1 {
        execute_ordered_tasks_sequentially(
            &ordered,
            workspace_root,
            options.mode,
            &options.platform,
            options.no_cache,
            &plan.named_caches,
            &options.cancellation,
            progress,
        )?
    } else {
        execute_ordered_tasks_parallel(
            &ordered,
            workspace_root,
            options,
            &plan.named_caches,
            progress,
        )?
    };
    Ok(ExecutionReport { tasks: executions })
}

fn execute_ordered_tasks_sequentially(
    ordered: &[&Task],
    workspace_root: &Path,
    mode: ExecutionMode,
    active_platform: &str,
    no_cache: bool,
    named_caches: &[NamedCache],
    cancellation: &AtomicBool,
    mut progress: Option<&mut prodash::tree::Item>,
) -> Result<Vec<TaskExecution>> {
    let mut executions = Vec::with_capacity(ordered.len());
    let mut summaries = BTreeMap::new();
    for task in ordered {
        let mut task_progress = progress.as_deref_mut().map(|progress| {
            let item = progress.add_child(task_progress_label(task));
            crate::ui::init_task(&item);
            item
        });

        let result = execute_one_task(
            task,
            workspace_root,
            mode,
            active_platform,
            no_cache,
            named_caches,
            &summaries,
            task_progress.as_mut(),
            cancellation,
        );

        let (execution, summary) = match result {
            Ok(result) => result,
            Err(error) => {
                if let Some(task_progress) = task_progress.as_mut() {
                    task_progress.fail("failed");
                }
                return Err(error);
            }
        };

        if let Some(task_progress) = task_progress.as_ref() {
            task_progress.set(1);
        }
        if let Some(progress) = progress.as_deref() {
            progress.inc();
        }
        summaries.insert(task.id.clone(), summary);
        executions.push(execution);
    }

    Ok(executions)
}

fn task_progress_label(task: &Task) -> String {
    if task.action.display.is_empty() {
        format!("execute {}", task.id)
    } else {
        task.action.display.clone()
    }
}

fn execute_ordered_tasks_parallel(
    ordered: &[&Task],
    workspace_root: &Path,
    options: ExecutionOptions,
    named_caches: &[NamedCache],
    mut progress: Option<&mut prodash::tree::Item>,
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
    let cancellation = options.cancellation;
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
                let mut task_progress = progress.as_deref_mut().map(|progress| {
                    let item = progress.add_child(task_progress_label(task));
                    crate::ui::init_task(&item);
                    item
                });
                let sender = sender.clone();
                let workspace_root = workspace_root.to_owned();
                let mode = options.mode;
                let active_platform = options.platform.clone();
                let no_cache = options.no_cache;
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
                        no_cache,
                        &named_caches,
                        &dependency_summaries,
                        task_progress.as_mut(),
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
                if let Some(progress) = progress.as_deref() {
                    progress.inc();
                }
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
    no_cache: bool,
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

    let status =
        match mode {
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
            ExecutionMode::Local if !task.action.sandbox => {
                if !task.action.impure {
                    bail!("{} uses sandbox: false and must set impure: true", task.id);
                }
                run_unsandboxed_task(task, workspace_root, cancellation, progress.as_deref_mut())?;
                if let Some(progress) = progress.as_mut() {
                    progress.done("done");
                }
                TaskExecutionStatus::Ran
            }
            ExecutionMode::Local if command.is_empty() => {
                let mut evaluation = evaluate_task_cache_with_lookup(
                    task,
                    workspace_root,
                    named_caches,
                    completed_dependencies,
                    !no_cache,
                )?;
                if no_cache {
                    disable_task_cache(&mut evaluation);
                }
                if evaluation.hit {
                    let record = evaluation.record.as_ref().ok_or_else(|| {
                        anyhow::anyhow!("cache hit for {} had no record", task.id)
                    })?;
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
                let mut evaluation = evaluate_task_cache_with_lookup(
                    task,
                    workspace_root,
                    named_caches,
                    completed_dependencies,
                    !no_cache,
                )?;
                if no_cache {
                    disable_task_cache(&mut evaluation);
                }
                if evaluation.hit {
                    let record = evaluation.record.as_ref().ok_or_else(|| {
                        anyhow::anyhow!("cache hit for {} had no record", task.id)
                    })?;
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
                    progress.as_deref_mut(),
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
            evaluate_task_cache_with_lookup(
                task,
                workspace_root,
                named_caches,
                completed_dependencies,
                !no_cache,
            )?
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

fn run_unsandboxed_task(
    task: &Task,
    workspace_root: &Path,
    cancellation: &AtomicBool,
    progress: Option<&mut prodash::tree::Item>,
) -> Result<()> {
    let opts = ExecRunOpts {
        argv: task.action.argv.clone(),
        display: task.action.display.clone(),
        env: task.action.env.clone(),
        inputs: task
            .inputs
            .iter()
            .filter_map(|artifact| {
                artifact.path.as_ref().map(|path| ExecIoSpec {
                    path: path.clone(),
                    kind: artifact.kind.clone(),
                })
            })
            .collect(),
        outputs: task
            .outputs
            .iter()
            .filter_map(|artifact| {
                artifact.path.as_ref().map(|path| ExecIoSpec {
                    path: path.clone(),
                    kind: artifact.kind.clone(),
                })
            })
            .collect(),
        tools: task.action.tools.clone(),
        impure: true,
        force_cache: false,
        sandbox: false,
    };
    exec_run_unsandboxed(workspace_root, opts, Some(cancellation), progress).map(|_| ())
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
    mut progress: Option<&mut prodash::tree::Item>,
    cancellation: &AtomicBool,
    cache: &TaskCacheEvaluation,
) -> Result<()> {
    if cancellation.load(Ordering::SeqCst) {
        bail!("{} canceled before execution", task.id);
    }

    let sandbox = prepare_sandbox(task, workspace_root)?;
    let tool_path_entries =
        materialize_tools_into_sandbox(&task.action.tools, &sandbox.sandbox_root)?;
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
    let cmd_display = if task.action.display.is_empty() {
        task.action.argv.join(" ")
    } else {
        task.action.display.clone()
    };
    let command_line = format_argv(&task.action.argv);

    let (program, args) = task
        .action
        .argv
        .split_first()
        .ok_or_else(|| anyhow::anyhow!("{} has no argv", task.id))?;

    let mut task_env = BTreeMap::new();
    for binding in &cache.named_caches {
        std::fs::create_dir_all(&binding.path)
            .with_context(|| format!("create named cache {}", binding.path.display()))?;
        task_env.insert(
            binding.env_var.clone(),
            binding.path.to_string_lossy().into_owned(),
        );
    }
    let command_env = sandbox_command_env(&task.action.env, &tool_path_entries)?;
    task_env.extend(command_env.clone());
    task_env.insert(
        "IMP_SANDBOX_ROOT".to_owned(),
        sandbox.sandbox_root.to_string_lossy().into_owned(),
    );
    task_env.insert(
        "IMP_CACHE_ROOT".to_owned(),
        sandbox.cache_root.to_string_lossy().into_owned(),
    );
    task_env.insert(
        "IMP_SANDBOX_MANIFEST".to_owned(),
        manifest_path.to_string_lossy().into_owned(),
    );

    let script_path = sandbox.sandbox_root.join("imp-run.sh");
    write_sandbox_run_script(&script_path, &cwd, &task_env, &task.action.argv)?;

    if let Some(progress) = progress.as_mut() {
        progress.set_name(format!("execute {cmd_display}"));
        progress.info(format!("sandbox: {}", sandbox.sandbox_root.display()));
        progress.info(format!("script: {}", script_path.display()));
    }

    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(&cwd)
        .envs(&task_env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .with_context(|| format!("execute {} in {}", task.id, cwd.display()))?;

    let (status, stdout, stderr) = wait_for_child_output(
        &mut child,
        &task.id,
        Some(cancellation),
        progress.as_deref_mut(),
    )?;

    if !status.success() {
        report_process_failure(progress.as_deref(), &stdout, &stderr);
        bail!(
            "{} failed with status {}\ncommand: {}\ncwd: {}\nstdout:\n{}\nstderr:\n{}",
            task.id,
            status,
            command_line,
            cwd.display(),
            stdout.trim_end(),
            stderr.trim_end()
        );
    }

    let outputs = ingest_task_outputs(task, &sandbox)?;
    if cache.cacheable {
        let record = TaskCacheRecord {
            version: TASK_CACHE_VERSION,
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
    } else if cache.cache_disabled {
        materialize_task_outputs_without_record(task, cache, outputs, workspace_root)?;
    }
    Ok(())
}

fn format_argv(argv: &[String]) -> String {
    if argv.is_empty() {
        return "<no argv>".to_owned();
    }
    argv.iter()
        .map(|arg| shell_quote(arg))
        .collect::<Vec<_>>()
        .join(" ")
}

fn shell_quote(value: &str) -> String {
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '/' | ':' | '='))
    {
        value.to_owned()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn write_sandbox_run_script(
    script_path: &Path,
    cwd: &Path,
    env: &BTreeMap<String, String>,
    argv: &[String],
) -> Result<()> {
    let mut script = String::new();
    script.push_str("#!/usr/bin/env sh\n");
    script.push_str("set -eu\n");
    script.push_str(&format!("cd {}\n", shell_quote(&cwd.to_string_lossy())));
    for (key, value) in env {
        if is_shell_identifier(key) {
            script.push_str(&format!("export {key}={}\n", shell_quote(value)));
        } else {
            script.push_str(&format!(
                "# skipped non-shell env key {}={}\n",
                shell_quote(key),
                shell_quote(value)
            ));
        }
    }
    script.push_str(&format!("exec {}\n", format_argv(argv)));
    std::fs::write(script_path, script)
        .with_context(|| format!("write sandbox run script {}", script_path.display()))?;
    #[cfg(unix)]
    {
        let mut permissions = std::fs::metadata(script_path)
            .with_context(|| format!("stat sandbox run script {}", script_path.display()))?
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(script_path, permissions)
            .with_context(|| format!("chmod sandbox run script {}", script_path.display()))?;
    }
    Ok(())
}

fn is_shell_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(ch) if ch == '_' || ch.is_ascii_alphabetic())
        && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
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
            mode: None,
            files: Vec::new(),
        });
    }

    if cache.cacheable {
        let record = TaskCacheRecord {
            version: TASK_CACHE_VERSION,
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
    } else if cache.cache_disabled {
        materialize_task_outputs_without_record(task, cache, outputs, workspace_root)?;
    }
    Ok(())
}

fn materialize_task_outputs_without_record(
    task: &Task,
    cache: &TaskCacheEvaluation,
    outputs: Vec<CachedArtifact>,
    workspace_root: &Path,
) -> Result<()> {
    let record = TaskCacheRecord {
        version: TASK_CACHE_VERSION,
        task_id: task.id.clone(),
        task_key: cache.task_key.clone(),
        action_digest: cache.action_digest.clone(),
        input_digests: cache.input_digests.clone(),
        dependency_keys: cache.dependency_keys.clone(),
        named_caches: cache.named_caches.clone(),
        outputs,
    };
    materialize_cached_outputs(&record, workspace_root)
}

fn wait_for_child_output(
    child: &mut Child,
    display: &str,
    cancellation: Option<&AtomicBool>,
    mut progress: Option<&mut prodash::tree::Item>,
) -> Result<(ExitStatus, String, String)> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("{display} stdout was not piped"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow::anyhow!("{display} stderr was not piped"))?;
    let (sender, receiver) = mpsc::channel();
    let stdout_thread = spawn_output_reader(stdout, ProcessStream::Stdout, sender.clone());
    let stderr_thread = spawn_output_reader(stderr, ProcessStream::Stderr, sender);

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut recent_output = VecDeque::new();
    let status = loop {
        if cancellation
            .map(|cancellation| cancellation.load(Ordering::SeqCst))
            .unwrap_or(false)
        {
            terminate_child_and_wait(child);
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            drain_process_lines(
                &receiver,
                &mut stdout,
                &mut stderr,
                progress.as_deref_mut(),
                &mut recent_output,
            );
            bail!("{display} canceled");
        }
        drain_process_lines(
            &receiver,
            &mut stdout,
            &mut stderr,
            progress.as_deref_mut(),
            &mut recent_output,
        );
        if let Some(status) = child
            .try_wait()
            .with_context(|| format!("wait for {display}"))?
        {
            break status;
        }
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(line) => record_process_line(
                line,
                &mut stdout,
                &mut stderr,
                progress.as_deref_mut(),
                &mut recent_output,
            ),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {}
        }
    };

    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    drain_process_lines(
        &receiver,
        &mut stdout,
        &mut stderr,
        progress.as_deref_mut(),
        &mut recent_output,
    );
    Ok((status, stdout, stderr))
}

fn terminate_child_and_wait(child: &mut Child) {
    terminate_child(child);
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() >= deadline => break,
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(_) => return,
        }
    }
    kill_child(child);
    let _ = child.wait();
}

fn terminate_child(child: &mut Child) {
    #[cfg(unix)]
    {
        if signal_child_process_group(child, "TERM") {
            return;
        }
    }
    let _ = child.kill();
}

fn kill_child(child: &mut Child) {
    #[cfg(unix)]
    {
        if signal_child_process_group(child, "KILL") {
            return;
        }
    }
    let _ = child.kill();
}

#[cfg(unix)]
fn signal_child_process_group(child: &Child, signal: &str) -> bool {
    let group = format!("-{}", child.id());
    let signal = format!("-{signal}");
    Command::new("kill")
        .args([signal.as_str(), "--", group.as_str()])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
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
    static SANDBOX_COUNTER: AtomicU64 = AtomicU64::new(0);

    let base = PathBuf::from("/tmp/imp");
    std::fs::create_dir_all(&base).with_context(|| format!("create {}", base.display()))?;
    for _ in 0..100 {
        let unique = format!(
            "sandbox-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            SANDBOX_COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let root = base.join(unique);
        match std::fs::create_dir(&root) {
            Ok(()) => return Ok(root),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error).with_context(|| format!("create sandbox {}", root.display()));
            }
        }
    }
    bail!("failed to create unique sandbox under {}", base.display())
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
    format!("{:x}", Sha256::digest(bytes))
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
    evaluate_task_cache_with_lookup(
        task,
        workspace_root,
        named_caches,
        completed_dependencies,
        true,
    )
}

fn evaluate_task_cache_with_lookup(
    task: &Task,
    workspace_root: &Path,
    named_caches: &[NamedCache],
    completed_dependencies: &BTreeMap<String, TaskCacheSummary>,
    lookup_cache: bool,
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
        "version": TASK_CACHE_VERSION,
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
            cache_disabled: false,
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

    let record = if lookup_cache {
        let record_path = task_record_path(&task_key)?;
        match std::fs::read_to_string(&record_path) {
            Ok(encoded) => {
                let record: TaskCacheRecord =
                    serde_json::from_str(&encoded).with_context(|| {
                        format!("parse task cache record {}", record_path.display())
                    })?;
                Some(record)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("read task cache record {}", record_path.display()));
            }
        }
    } else {
        None
    };

    let (hit, miss_reason) = if !lookup_cache {
        (false, Some("cache disabled".to_owned()))
    } else {
        match &record {
            None => (false, Some("no task cache record".to_owned())),
            Some(record) if record.task_key != task_key => {
                (false, Some("task cache record key mismatch".to_owned()))
            }
            Some(record) => match cached_outputs_present(record) {
                Ok(()) => (true, None),
                Err(error) => (false, Some(format!("{error:#}"))),
            },
        }
    };

    Ok(TaskCacheEvaluation {
        cacheable,
        cache_disabled: false,
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

fn disable_task_cache(evaluation: &mut TaskCacheEvaluation) {
    evaluation.cacheable = false;
    evaluation.cache_disabled = true;
    evaluation.hit = false;
    evaluation.miss_reason = Some("cache disabled".to_owned());
    evaluation.record = None;
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
                    mode: file_mode(&output.sandbox_path)?,
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
                    mode: None,
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
                    mode: None,
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
                restore_file_mode(&destination, output.mode)?;
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

#[cfg(unix)]
fn file_mode(path: &Path) -> Result<Option<u32>> {
    Ok(Some(std::fs::metadata(path)?.permissions().mode() & 0o7777))
}

#[cfg(not(unix))]
fn file_mode(_path: &Path) -> Result<Option<u32>> {
    Ok(None)
}

#[cfg(unix)]
fn restore_file_mode(path: &Path, mode: Option<u32>) -> Result<()> {
    let Some(mode) = mode else {
        return Ok(());
    };
    let mut permissions = std::fs::metadata(path)?.permissions();
    permissions.set_mode(mode);
    std::fs::set_permissions(path, permissions)
        .with_context(|| format!("set permissions {:o} on {}", mode, path.display()))
}

#[cfg(not(unix))]
fn restore_file_mode(_path: &Path, _mode: Option<u32>) -> Result<()> {
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

fn attr_str<'a>(attrs: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    attrs.get(key).and_then(|v| v.as_str())
}

pub fn format_targets(targets: &[&Target], w: &mut String) -> std::fmt::Result {
    use std::fmt::Write;
    for target in targets {
        writeln!(w, "{} ({})", target.address, target.kind)?;
        if let Some(sources) = attr_str(&target.attrs, "sources") {
            if !sources.is_empty() {
                writeln!(w, "  sources: {sources}")?;
            }
        } else if let Some(sources) = target
            .attrs
            .get("sources")
            .and_then(|value| value.as_array())
        {
            let sources = sources
                .iter()
                .filter_map(|value| value.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            if !sources.is_empty() {
                writeln!(w, "  sources: {sources}")?;
            }
        }
        if let Some(ep) = attr_str(&target.attrs, "entrypoint") {
            writeln!(w, "  entrypoint: {ep}")?;
        }
        if let Some(version) = attr_str(&target.attrs, "version") {
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

pub fn format_products(workspace: &Workspace, w: &mut String) -> std::fmt::Result {
    use std::fmt::Write;

    let kinds: BTreeSet<&str> = workspace.products.keys().map(|(k, _)| k.as_str()).collect();

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
    writeln!(w, "Products:")?;
    if workspace.products.is_empty() {
        writeln!(w, "  (none)")?;
    } else {
        let mut current_kind: Option<&str> = Option::None;
        for ((kind, product), _) in &workspace.products {
            if current_kind != Some(kind.as_str()) {
                current_kind = Some(kind.as_str());
                writeln!(w, "  {kind}:")?;
            }
            writeln!(w, "    - {product}")?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Graph introspection (Phase 10)
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct IntrospectResult {
    pub trace: Vec<serde_json::Value>,
    pub deps: Vec<serde_json::Value>,
    pub key_display: std::collections::HashMap<String, String>,
    /// Maps memo key → (target js_id, product_name) for product function calls.
    /// Used to attribute run effects to the correct target when a product from one
    /// target's dep is called during another target's product introspection.
    pub key_product_calls: std::collections::HashMap<String, (u32, String)>,
}

/// Dry-run a product function and capture its memo call graph and effects.
///
/// Calls `setIntrospectMode(true)` so `run()` records intent without executing.
pub async fn introspect_product(
    live: &LiveWorkspace,
    target_addr: &str,
    product_name: &str,
) -> Result<IntrospectResult> {
    let target = live
        .workspace
        .targets
        .get(target_addr)
        .ok_or_else(|| anyhow::anyhow!("no target '{target_addr}' in workspace"))?;

    let product_fn_name = live
        .workspace
        .products
        .get(&(target.kind.clone(), product_name.to_owned()))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "no product '{product_name}' for kind '{}' (target '{target_addr}')",
                target.kind
            )
        })?
        .clone();

    let js_id = target.js_id;

    let result = live
        .ctx
        .async_with(
            async |ctx| -> rquickjs::Result<(
                Vec<serde_json::Value>,
                Vec<serde_json::Value>,
                std::collections::HashMap<String, String>,
                std::collections::HashMap<String, (u32, String)>,
            )> {
                // Enable introspect mode and reset trace state.
                let set_introspect: Function = ctx.globals().get("setIntrospectMode")?;
                set_introspect.call::<_, ()>((true,))?;
                let reset: Function = ctx.globals().get("resetMemoState")?;
                reset.call::<_, ()>(())?;

                // Call the product function with the enriched target handle.
                let resolve_fn: Function = ctx.globals().get("__imp_resolve_handle")?;
                let handle: Object = resolve_fn.call((js_id,))?;

                let product_fn: Function = ctx.globals().get(product_fn_name.as_str())?;
                let result: MaybePromise = product_fn.call((handle,)).catch(&ctx).map_err(|e| {
                    rquickjs::Error::new_loading_message("introspect", format!("{e}"))
                })?;
                result.into_future::<()>().await.catch(&ctx).map_err(|e| {
                    rquickjs::Error::new_loading_message("introspect", format!("{e}"))
                })?;

                // Restore normal mode.
                set_introspect.call::<_, ()>((false,))?;

                // Read the trace.
                let get_trace: Function = ctx.globals().get("getMemoTrace")?;
                let trace_obj: Object = get_trace.call(())?;

                let trace_json: String = ctx
                    .json_stringify(trace_obj)?
                    .ok_or_else(|| {
                        rquickjs::Error::new_loading_message("introspect", "trace was null")
                    })?
                    .to_string()?;

                let parsed: serde_json::Value = serde_json::from_str(&trace_json).map_err(|e| {
                    rquickjs::Error::new_loading_message("introspect", e.to_string())
                })?;

                let trace = parsed["trace"].as_array().cloned().unwrap_or_default();
                let deps = parsed["deps"].as_array().cloned().unwrap_or_default();
                let key_display: std::collections::HashMap<String, String> = parsed["key_display"]
                    .as_object()
                    .map(|m| {
                        m.iter()
                            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_owned())))
                            .collect()
                    })
                    .unwrap_or_default();
                let key_product_calls: std::collections::HashMap<String, (u32, String)> = parsed
                    ["key_product_calls"]
                    .as_object()
                    .map(|m| {
                        m.iter()
                            .filter_map(|(k, v)| {
                                let target_id = v["target_id"].as_u64()? as u32;
                                let product_name = v["product_name"].as_str()?.to_owned();
                                Some((k.clone(), (target_id, product_name)))
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                Ok((trace, deps, key_display, key_product_calls))
            },
        )
        .await
        .map_err(|e| anyhow::anyhow!("introspect_product failed: {e}"))?;

    // Replace "#N" handle tokens in display labels with workspace addresses.
    let id_to_address: std::collections::HashMap<u32, &str> = live
        .workspace
        .targets
        .values()
        .map(|t| (t.js_id, t.address.as_str()))
        .collect();

    let key_display = result
        .2
        .into_iter()
        .map(|(k, mut label)| {
            for (id, addr) in &id_to_address {
                label = label.replace(&format!("#{id}"), addr);
            }
            (k, label)
        })
        .collect();

    Ok(IntrospectResult {
        trace: result.0,
        deps: result.1,
        key_display,
        key_product_calls: result.3,
    })
}

/// Render the memo call tree for an introspect result.
pub fn format_inspect_explain(result: &IntrospectResult, w: &mut String) -> std::fmt::Result {
    use std::collections::{HashMap, HashSet};
    use std::fmt::Write;

    // Build adjacency list from deps: caller → [callees].
    let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut has_parent: HashSet<&str> = HashSet::new();
    for dep in &result.deps {
        if let (Some(caller), Some(callee)) = (dep["caller"].as_str(), dep["callee"].as_str()) {
            children.entry(caller).or_default().push(callee);
            has_parent.insert(callee);
        }
    }

    // Root nodes: appear in deps but never as a callee.
    let all_callers: Vec<&str> = result
        .deps
        .iter()
        .filter_map(|d| d["caller"].as_str())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();

    let roots: Vec<&str> = all_callers
        .iter()
        .copied()
        .filter(|k| !has_parent.contains(k))
        .collect();

    // Fall back to miss events if no deps recorded.
    let miss_roots: Vec<&str>;
    let effective_roots: &[&str] = if roots.is_empty() {
        miss_roots = result
            .trace
            .iter()
            .filter(|e| e["event"] == "miss")
            .filter_map(|e| e["key"].as_str())
            .collect();
        &miss_roots
    } else {
        &roots
    };

    fn render_node(
        key: &str,
        depth: usize,
        children: &HashMap<&str, Vec<&str>>,
        key_display: &std::collections::HashMap<String, String>,
        visited: &mut HashSet<String>,
        w: &mut String,
    ) -> std::fmt::Result {
        let indent = "  ".repeat(depth);
        let label = key_display.get(key).map(|s| s.as_str()).unwrap_or(key);
        writeln!(w, "{indent}{label}")?;
        if visited.insert(key.to_owned()) {
            if let Some(kids) = children.get(key) {
                for &kid in kids {
                    render_node(kid, depth + 1, children, key_display, visited, w)?;
                }
            }
        }
        Ok(())
    }

    let mut visited = HashSet::new();
    for root in effective_roots {
        render_node(root, 0, &children, &result.key_display, &mut visited, w)?;
    }

    Ok(())
}

/// List the actions (run() calls) captured in an introspect result.
pub fn format_inspect_actions(result: &IntrospectResult, w: &mut String) -> std::fmt::Result {
    use std::fmt::Write;

    let actions: Vec<_> = result
        .trace
        .iter()
        .filter(|e| {
            e["event"] == "effect" && matches!(e["kind"].as_str(), Some("run") | Some("write_file"))
        })
        .collect();

    if actions.is_empty() {
        writeln!(w, "  (no actions)")?;
        return Ok(());
    }

    for action in actions {
        let display = action["display"].as_str().unwrap_or("<unnamed>");
        writeln!(w, "  {display}  (dry-run)")?;
    }

    Ok(())
}

type BuildFileEdit = Vec<GeneratedBuildTarget>;

#[derive(Debug, Clone, Deserialize)]
struct GeneratedBuildTarget {
    name: String,
    rule: String,
    #[serde(default)]
    props: serde_json::Value,
}

/// Evaluate a product and return its JSON-serializable value.
pub async fn evaluate_product_json(
    live: &LiveWorkspace,
    target_addr: &str,
    product_name: &str,
) -> Result<serde_json::Value> {
    let target = live
        .workspace
        .targets
        .get(target_addr)
        .ok_or_else(|| anyhow::anyhow!("no target '{target_addr}' in workspace"))?;

    let product_fn_name = live
        .workspace
        .products
        .get(&(target.kind.clone(), product_name.to_owned()))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "no product '{product_name}' for kind '{}' (target '{target_addr}')",
                target.kind
            )
        })?
        .clone();

    live.ctx
        .async_with(async |ctx| -> rquickjs::Result<serde_json::Value> {
            let reset: Function = ctx.globals().get("resetMemoState")?;
            reset.call::<_, ()>(())?;

            let resolve_fn: Function = ctx.globals().get("__imp_resolve_handle")?;
            let handle: Object = resolve_fn.call((target.js_id,))?;

            let product_fn: Function = ctx.globals().get(product_fn_name.as_str())?;
            let result: MaybePromise = product_fn
                .call((handle,))
                .catch(&ctx)
                .map_err(|e| rquickjs::Error::new_loading_message("product", format!("{e}")))?;
            let value: Value = result
                .into_future()
                .await
                .catch(&ctx)
                .map_err(|e| rquickjs::Error::new_loading_message("product", format!("{e}")))?;

            let json: String = ctx
                .json_stringify(value)?
                .ok_or_else(|| {
                    rquickjs::Error::new_loading_message(
                        "product",
                        "product returned a non-JSON value",
                    )
                })?
                .to_string()?;
            serde_json::from_str(&json)
                .map_err(|e| rquickjs::Error::new_loading_message("product", e.to_string()))
        })
        .await
        .map_err(|e| anyhow::anyhow!("evaluate_product_json failed: {e}"))
}

async fn evaluate_product_function_json(
    live: &LiveWorkspace,
    product_fn_name: &str,
    label: &str,
) -> Result<serde_json::Value> {
    live.ctx
        .async_with(async |ctx| -> rquickjs::Result<serde_json::Value> {
            let reset: Function = ctx.globals().get("resetMemoState")?;
            reset.call::<_, ()>(())?;

            let handle = Object::new(ctx.clone())?;
            let attrs = Object::new(ctx.clone())?;
            handle.set("attrs", attrs)?;

            let product_fn: Function = ctx.globals().get(product_fn_name)?;
            let result: MaybePromise = product_fn
                .call((handle,))
                .catch(&ctx)
                .map_err(|e| rquickjs::Error::new_loading_message("product", format!("{e}")))?;
            let value: Value = result
                .into_future()
                .await
                .catch(&ctx)
                .map_err(|e| rquickjs::Error::new_loading_message("product", format!("{e}")))?;

            let json: String = ctx
                .json_stringify(value)?
                .ok_or_else(|| {
                    rquickjs::Error::new_loading_message(
                        "product",
                        "product returned a non-JSON value",
                    )
                })?
                .to_string()?;
            serde_json::from_str(&json)
                .map_err(|e| rquickjs::Error::new_loading_message("product", e.to_string()))
        })
        .await
        .map_err(|e| anyhow::anyhow!("evaluate {label} failed: {e}"))
}

pub async fn generate_build_files(
    live: &LiveWorkspace,
    workspace_root: &Path,
    selectors: &[String],
    check: bool,
) -> Result<BuildGenerateReport> {
    let mut edits = BTreeMap::new();
    if selectors.is_empty() {
        let generators: Vec<_> = live
            .workspace
            .products
            .iter()
            .filter_map(|((kind, name), product_fn)| {
                (name == "generate-build").then_some((kind.clone(), product_fn.clone()))
            })
            .collect();
        if generators.is_empty() {
            bail!(
                "no registered products can produce generate-build\nImport one or more rule modules that export a generate-build product, such as `await import(\"//rules/odin\");`"
            );
        }
        for (kind, product_fn) in generators {
            let label = format!("{kind}#generate-build");
            let value = evaluate_product_function_json(live, &product_fn, &label).await?;
            let product_edits: BTreeMap<String, BuildFileEdit> = serde_json::from_value(value)
                .with_context(|| format!("parse generate-build product result for {label}"))?;
            merge_build_edits(&mut edits, product_edits)?;
        }
    } else {
        for target in select_targets(&live.workspace, selectors)? {
            let value = evaluate_product_json(live, &target.address, "generate-build").await?;
            let product_edits: BTreeMap<String, BuildFileEdit> = serde_json::from_value(value)
                .with_context(|| {
                    format!("parse generate-build product result for {}", target.address)
                })?;
            merge_build_edits(&mut edits, product_edits)?;
        }
    }
    apply_build_edits(workspace_root, &live.workspace.build_rules, edits, check)
}

fn merge_build_edits(
    merged: &mut BTreeMap<String, BuildFileEdit>,
    incoming: BTreeMap<String, BuildFileEdit>,
) -> Result<()> {
    for (file, targets) in incoming {
        merged.entry(file).or_default().extend(targets);
    }
    Ok(())
}

fn apply_build_edits(
    workspace_root: &Path,
    build_rules: &BTreeMap<String, BuildRuleRender>,
    edits: BTreeMap<String, BuildFileEdit>,
    check: bool,
) -> Result<BuildGenerateReport> {
    let mut changed_files = Vec::new();
    let mut checked_files = Vec::new();

    for (file, edit) in edits {
        let relative = artifact_relative_path(&file)?;
        let destination = workspace_root.join(relative);
        let existing = match std::fs::read_to_string(&destination) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(error) => {
                return Err(error).with_context(|| format!("read {}", destination.display()));
            }
        };

        let rendered = render_raw_build_file(&file, &existing, build_rules, &edit)?;

        checked_files.push(file.clone());
        if existing != rendered {
            changed_files.push(file.clone());
            if !check {
                if let Some(parent) = destination.parent() {
                    std::fs::create_dir_all(parent)
                        .with_context(|| format!("create {}", parent.display()))?;
                }
                std::fs::write(&destination, rendered)
                    .with_context(|| format!("write {}", destination.display()))?;
            }
        }
    }

    if check && !changed_files.is_empty() {
        bail!(
            "generated BUILD files are out of date: {}",
            changed_files.join(", ")
        );
    }

    Ok(BuildGenerateReport {
        changed_files,
        checked_files,
    })
}

fn render_raw_build_file(
    file: &str,
    existing: &str,
    build_rules: &BTreeMap<String, BuildRuleRender>,
    targets: &[GeneratedBuildTarget],
) -> Result<String> {
    let existing_exports = manual_export_names(existing)?;
    let targets = targets
        .iter()
        .filter(|target| !existing_exports.contains(&target.name))
        .collect::<Vec<_>>();
    if targets.is_empty() {
        return Ok(existing.to_owned());
    }
    let current_module = build_file_module(file)?;
    let imports = render_missing_imports(file, &current_module, existing, build_rules, &targets)?;
    let target_block = render_generated_targets(build_rules, &targets, &current_module)?;

    let mut rendered = String::new();
    if !imports.is_empty() {
        rendered.push_str(&imports);
        if !existing.trim().is_empty() {
            rendered.push('\n');
        }
    }
    let existing = existing.trim_end();
    if !existing.is_empty() {
        rendered.push_str(existing);
        rendered.push_str("\n\n");
    }
    rendered.push_str(&target_block);
    if !rendered.ends_with('\n') {
        rendered.push('\n');
    }
    Ok(rendered)
}

fn manual_export_names(content: &str) -> Result<BTreeSet<String>> {
    let re = Regex::new(r"(?m)^\s*export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\b")
        .context("compile export regex")?;
    Ok(re
        .captures_iter(content)
        .filter_map(|capture| capture.get(1).map(|m| m.as_str().to_owned()))
        .collect())
}

fn render_missing_imports(
    file: &str,
    current_module: &str,
    existing: &str,
    build_rules: &BTreeMap<String, BuildRuleRender>,
    targets: &[&GeneratedBuildTarget],
) -> Result<String> {
    let mut imports = required_imports(file, current_module, build_rules, targets)?;
    let existing_imports = existing_imports(existing)?;
    for (module, symbols) in existing_imports {
        if let Some(required) = imports.get_mut(&module) {
            for symbol in symbols {
                required.remove(&symbol);
            }
        }
    }
    imports.retain(|_, symbols| !symbols.is_empty());

    let mut rendered = String::new();
    for (from, symbols) in imports {
        let names = symbols.into_iter().collect::<Vec<_>>().join(", ");
        rendered.push_str(&format!("import {{ {names} }} from \"{from}\";\n"));
    }
    Ok(rendered)
}

fn required_imports(
    file: &str,
    current_module: &str,
    build_rules: &BTreeMap<String, BuildRuleRender>,
    targets: &[&GeneratedBuildTarget],
) -> Result<BTreeMap<String, BTreeSet<String>>> {
    let mut imports: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for target in targets {
        let rule = build_rules.get(&target.rule).ok_or_else(|| {
            anyhow::anyhow!(
                "{file}: no render metadata registered for rule '{}'",
                target.rule
            )
        })?;
        imports
            .entry(rule.import_from.clone())
            .or_default()
            .insert(rule.import_name.clone());

        let mut refs = BTreeSet::new();
        collect_target_refs(&target.props, &mut refs)?;
        for address in refs {
            let (module, symbol) = target_ref_parts(&address)?;
            if module != current_module {
                imports.entry(module).or_default().insert(symbol);
            }
        }
    }
    Ok(imports)
}

fn existing_imports(content: &str) -> Result<BTreeMap<String, BTreeSet<String>>> {
    let re = Regex::new(r#"(?m)^\s*import\s+\{\s*([^}]+?)\s*\}\s+from\s+"([^"]+)";"#)
        .context("compile import regex")?;
    let mut imports: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for capture in re.captures_iter(content) {
        let names = capture.get(1).map(|m| m.as_str()).unwrap_or("");
        let module = capture.get(2).map(|m| m.as_str()).unwrap_or("");
        for name in names.split(',') {
            let name = name.trim();
            if !name.is_empty() {
                imports
                    .entry(module.to_owned())
                    .or_default()
                    .insert(name.to_owned());
            }
        }
    }
    Ok(imports)
}

fn render_generated_targets(
    build_rules: &BTreeMap<String, BuildRuleRender>,
    targets: &[&GeneratedBuildTarget],
    current_module: &str,
) -> Result<String> {
    let mut rendered = String::new();
    for target in targets {
        if !is_js_identifier(&target.name) {
            bail!(
                "generated target name '{}' is not a valid JavaScript identifier",
                target.name
            );
        }
        let rule = build_rules.get(&target.rule).ok_or_else(|| {
            anyhow::anyhow!("no render metadata registered for rule '{}'", target.rule)
        })?;
        if !is_js_identifier(&rule.import_name) {
            bail!(
                "generated rule import '{}' is not a valid JavaScript identifier",
                rule.import_name
            );
        }
        let props = render_js_value(&target.props, 0, current_module)?;
        rendered.push_str(&format!(
            "export const {} = {}({});\n",
            target.name, rule.import_name, props
        ));
    }
    Ok(rendered)
}

fn collect_target_refs(value: &serde_json::Value, refs: &mut BTreeSet<String>) -> Result<()> {
    match value {
        serde_json::Value::Array(values) => {
            for value in values {
                collect_target_refs(value, refs)?;
            }
        }
        serde_json::Value::Object(object) if is_target_ref(value) => {
            let address = object
                .get("address")
                .and_then(|value| value.as_str())
                .ok_or_else(|| anyhow::anyhow!("targetRef value is missing address"))?;
            refs.insert(address.to_owned());
        }
        serde_json::Value::Object(object) => {
            for value in object.values() {
                collect_target_refs(value, refs)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn render_js_value(
    value: &serde_json::Value,
    indent: usize,
    current_module: &str,
) -> Result<String> {
    match value {
        serde_json::Value::Null => Ok("null".to_owned()),
        serde_json::Value::Bool(value) => Ok(value.to_string()),
        serde_json::Value::Number(value) => Ok(value.to_string()),
        serde_json::Value::String(value) => Ok(serde_json::to_string(value)?),
        serde_json::Value::Array(values) => {
            if values.is_empty() {
                return Ok("[]".to_owned());
            }
            if values.iter().all(is_simple_js_value) {
                let items = values
                    .iter()
                    .map(|value| render_js_value(value, indent, current_module))
                    .collect::<Result<Vec<_>>>()?;
                return Ok(format!("[{}]", items.join(", ")));
            }
            let child_indent = " ".repeat(indent + 4);
            let mut rendered = String::from("[\n");
            for value in values {
                rendered.push_str(&child_indent);
                rendered.push_str(&render_js_value(value, indent + 4, current_module)?);
                rendered.push_str(",\n");
            }
            rendered.push_str(&" ".repeat(indent));
            rendered.push(']');
            Ok(rendered)
        }
        serde_json::Value::Object(object) if is_target_ref(value) => {
            let address = object
                .get("address")
                .and_then(|value| value.as_str())
                .ok_or_else(|| anyhow::anyhow!("targetRef value is missing address"))?;
            let (module, symbol) = target_ref_parts(address)?;
            if module == current_module || is_js_identifier(&symbol) {
                Ok(symbol)
            } else {
                bail!("targetRef symbol '{symbol}' is not a valid JavaScript identifier")
            }
        }
        serde_json::Value::Object(object) => {
            if object.is_empty() {
                return Ok("{}".to_owned());
            }
            let child_indent = " ".repeat(indent + 4);
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort();
            let mut rendered = String::from("{\n");
            for key in keys {
                let value = object.get(key).unwrap();
                rendered.push_str(&child_indent);
                rendered.push_str(&render_js_key(key));
                rendered.push_str(": ");
                rendered.push_str(&render_js_value(value, indent + 4, current_module)?);
                rendered.push_str(",\n");
            }
            rendered.push_str(&" ".repeat(indent));
            rendered.push('}');
            Ok(rendered)
        }
    }
}

fn is_simple_js_value(value: &serde_json::Value) -> bool {
    matches!(
        value,
        serde_json::Value::Null
            | serde_json::Value::Bool(_)
            | serde_json::Value::Number(_)
            | serde_json::Value::String(_)
    ) || is_target_ref(value)
}

fn is_target_ref(value: &serde_json::Value) -> bool {
    value
        .as_object()
        .and_then(|object| object.get("__imp_target_ref"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn render_js_key(key: &str) -> String {
    if is_js_identifier(key) {
        key.to_owned()
    } else {
        serde_json::to_string(key).expect("serialize object key")
    }
}

fn is_js_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first == '_' || first == '$' || first.is_ascii_alphabetic()) {
        return false;
    }
    chars.all(|ch| ch == '_' || ch == '$' || ch.is_ascii_alphanumeric())
}

fn target_ref_parts(address: &str) -> Result<(String, String)> {
    let (module, name) = address
        .split_once(':')
        .ok_or_else(|| anyhow::anyhow!("targetRef address '{address}' must include ':'"))?;
    if !module.starts_with("//") || name.is_empty() {
        bail!("targetRef address '{address}' must be a workspace target address");
    }
    if !is_js_identifier(name) {
        bail!("targetRef target name '{name}' is not a valid JavaScript identifier");
    }
    Ok((module.to_owned(), name.to_owned()))
}

fn build_file_module(file: &str) -> Result<String> {
    let relative = artifact_relative_path(file)?;
    if relative.file_name().and_then(|name| name.to_str()) != Some(BUILD_FILE) {
        bail!("generated BUILD edit path must end in {BUILD_FILE}: {file}");
    }
    let parent = relative.parent().unwrap_or_else(|| Path::new(""));
    if parent.as_os_str().is_empty() {
        return Ok("//".to_owned());
    }
    Ok(format!(
        "//{}",
        parent
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/")
    ))
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
    mut reader: R,
    stream: ProcessStream,
    sender: mpsc::Sender<ProcessLine>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut pending = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    send_process_output_line(stream, &mut pending, &sender);
                    break;
                }
                Ok(n) => {
                    for byte in &buf[..n] {
                        match *byte {
                            b'\n' | b'\r' => {
                                send_process_output_line(stream, &mut pending, &sender);
                            }
                            byte => pending.push(byte),
                        }
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

fn send_process_output_line(
    stream: ProcessStream,
    pending: &mut Vec<u8>,
    sender: &mpsc::Sender<ProcessLine>,
) {
    if pending.is_empty() {
        return;
    }
    let line = String::from_utf8_lossy(pending).into_owned();
    pending.clear();
    sender
        .send(ProcessLine { stream, line })
        .expect("failed sending process line");
}

fn drain_process_lines(
    receiver: &mpsc::Receiver<ProcessLine>,
    stdout: &mut String,
    stderr: &mut String,
    mut progress: Option<&mut prodash::tree::Item>,
    recent_output: &mut VecDeque<prodash::tree::Item>,
) {
    while let Ok(line) = receiver.try_recv() {
        record_process_line(line, stdout, stderr, progress.as_deref_mut(), recent_output);
    }
}

fn record_process_line(
    line: ProcessLine,
    stdout: &mut String,
    stderr: &mut String,
    progress: Option<&mut prodash::tree::Item>,
    recent_output: &mut VecDeque<prodash::tree::Item>,
) {
    if let Some(progress) = progress {
        report_process_line(progress, recent_output, &line);
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

fn report_process_line(
    progress: &mut prodash::tree::Item,
    recent_output: &mut VecDeque<prodash::tree::Item>,
    line: &ProcessLine,
) {
    if line.line.trim().is_empty() {
        return;
    }
    let stream = match line.stream {
        ProcessStream::Stdout => "out",
        ProcessStream::Stderr => "err",
    };
    recent_output.push_back(progress.add_child(format!("{stream}: {}", line.line)));
    while recent_output.len() > PROCESS_OUTPUT_VISIBLE_LINES {
        recent_output.pop_front();
    }
}

fn report_process_failure(progress: Option<&prodash::tree::Item>, stdout: &str, stderr: &str) {
    let Some(progress) = progress else {
        return;
    };
    for line in stderr
        .lines()
        .chain(stdout.lines())
        .filter(|line| !line.trim().is_empty())
        .rev()
        .take(20)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        progress.message(prodash::messages::MessageLevel::Failure, line.to_owned());
    }
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
    sandbox: bool,
}

struct ExecIoSpec {
    path: String,
    kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecToolSpec {
    pub name: String,
    pub cache: String,
    pub key: String,
    pub path: PathBuf,
    pub bin_dirs: Vec<String>,
}

/// Build a JS `ctx` object for `exec(target, ctx)` functions.
///
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

fn parse_tool_specs<'js>(
    vals: Vec<Object<'js>>,
    workspace_root: &Path,
) -> rquickjs::Result<Vec<ExecToolSpec>> {
    let mut specs = Vec::new();
    for val in vals {
        let name: Option<String> = val.get("name")?;
        let Some(name) = name else {
            continue;
        };
        let cache: String = val.get("cache")?;
        let key: String = val.get("key")?;
        let path: Option<String> = val.get("path")?;
        let path = match path {
            Some(p) => PathBuf::from(p),
            None => named_cache_key_path(workspace_root, &cache, &key)
                .map_err(|e| rquickjs::Error::new_loading_message("tool", format!("{e:#}")))?,
        };
        let bin_dirs: Option<Vec<String>> = val.get("binDirs")?;
        specs.push(ExecToolSpec {
            name,
            cache,
            key,
            path,
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
    if !opts.sandbox {
        if !opts.impure {
            bail!("run({{ sandbox: false }}) requires impure: true");
        }
        return exec_run_unsandboxed(workspace_root, opts, None, None);
    }

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
        "version": TASK_CACHE_VERSION,
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
            version: TASK_CACHE_VERSION,
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
    let cmd_display = if opts.display.is_empty() {
        opts.argv.join(" ")
    } else {
        opts.display.clone()
    };
    //    eprintln!("[sandbox: {}] {}", sandbox_root.display(), cmd_display);

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

    let (status, stdout, stderr) = wait_for_child_output(&mut child, &opts.display, None, None)?;

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
                    mode: file_mode(&sandbox_path)?,
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
                    mode: None,
                    files,
                });
            }
            other => bail!("run() output {} has unsupported kind {other}", output.path),
        }
    }

    // Cache record and materialize.
    if cacheable {
        let record = TaskCacheRecord {
            version: TASK_CACHE_VERSION,
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

fn exec_run_unsandboxed(
    workspace_root: &Path,
    opts: ExecRunOpts,
    cancellation: Option<&AtomicBool>,
    mut progress: Option<&mut prodash::tree::Item>,
) -> Result<ExecRunResult> {
    let cmd_display = if opts.display.is_empty() {
        opts.argv.join(" ")
    } else {
        opts.display.clone()
    };
    //    eprintln!("[unsandboxed] {}", cmd_display);

    let (program, args) = opts
        .argv
        .split_first()
        .ok_or_else(|| anyhow::anyhow!("run() argv must not be empty"))?;
    let tool_path_entries = direct_tool_path_entries(&opts.tools)?;
    let command_env = sandbox_command_env(&opts.env, &tool_path_entries)?;
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(workspace_root)
        .envs(&command_env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);

    let mut child = command
        .spawn()
        .with_context(|| format!("run() command in {}", workspace_root.display()))?;
    let (status, stdout, stderr) = wait_for_child_output(
        &mut child,
        &opts.display,
        cancellation,
        progress.as_deref_mut(),
    )?;
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
    Ok(ExecRunResult {
        stdout,
        stderr,
        exit_code,
    })
}

fn direct_tool_path_entries(tools: &[ExecToolSpec]) -> Result<Vec<PathBuf>> {
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
        for bin_dir in &tool.bin_dirs {
            path_entries.push(resolve_tool_bin_dir(&tool.path, bin_dir)?);
        }
    }
    Ok(path_entries)
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
import { target, glob, memo, product, run } from "imp:core";

export const sources = memo(async function sources(handle) {
    return glob({ root: ".", include: handle.attrs.sources || [] });
});

export const native_link_library = product("cmake-lib", "native-link-library", async function native_link_library(handle) {
    const inputs = [];
    for (const dep of handle.attrs.deps || []) {
        if (dep.kind === "cpp-sources") inputs.push(await sources(dep));
    }
    return run({ argv: ["sh", "-c", "true"], inputs, display: `cmake --build ${handle.attrs.entrypoint}`, impure: true });
});

export function cppSources({ srcs }) {
    return target({ kind: "cpp-sources", attrs: { sources: srcs } });
}
export function cmakeLib({ entrypoint, deps = [] }) {
    return target({ kind: "cmake-lib", attrs: { entrypoint, deps } });
}
"#;

    const ODIN_RULES_JS: &str = r#"
import { target, glob, memo, product, run } from "imp:core";

export const sources = memo(async function sources(handle) {
    return glob({ root: ".", include: handle.attrs.sources || [] });
});

export const odin_package = product("odin-package", "odin-package", async function odin_package(handle) {
    const srcs = await sources(handle);
    return run({ argv: ["sh", "-c", "true"], inputs: [srcs], display: "odin build", impure: true });
});

export function odinPackage({ srcs, deps = [] }) {
    return target({ kind: "odin-package", attrs: { sources: srcs, deps } });
}
"#;

    const ASSET_RULES_JS: &str = r#"
import { target, glob, memo, product, run } from "imp:core";

export const sources = memo(async function sources(handle) {
    return glob({ root: ".", include: handle.attrs.sources || [] });
});

export const bundle = product("asset", "bundle", async function bundle(handle) {
    const srcs = await sources(handle);
    return run({ argv: ["sh", "-c", "true"], inputs: [srcs], display: `bundle ${handle.attrs.sources.join(",")}`, impure: true });
});

export function asset({ srcs }) {
    return target({ kind: "asset", attrs: { sources: srcs } });
}
"#;

    const GENERATE_BUILD_RULES_JS: &str = r#"
import { allUnowned, target, product, registerBuildRule, sourcesField } from "imp:core";

registerBuildRule({ rule: "odinPackage", importFrom: "//rules/odin" });

const DEFAULT_EXCLUDES = ["**/vendor/**"];

function dirname(path) {
    const index = path.lastIndexOf("/");
    return index < 0 ? "." : path.slice(0, index);
}

function basename(path) {
    if (path === ".") return "root";
    const index = path.lastIndexOf("/");
    return index < 0 ? path : path.slice(index + 1);
}

export const generateBuild = product("odin-build-generator", "generate-build", async function generateBuild(handle) {
    const files = allUnowned({
        root: handle.attrs.root || ".",
        include: ["**/*.odin"],
        exclude: handle.attrs.exclude || DEFAULT_EXCLUDES,
    });
    const dirs = Array.from(new Set(files.map(dirname))).sort();
    const result = {};
    for (const dir of dirs) {
        result[dir === "." ? "BUILD.js" : `${dir}/BUILD.js`] = [{
                name: basename(dir).replace(/[^A-Za-z0-9_$]/g, "_") || "root",
                rule: "odinPackage",
                props: { srcs: ["*.odin"] },
            }];
    }
    return result;
});

export function odinGenerateBuild({ root = ".", exclude = DEFAULT_EXCLUDES } = {}) {
    return target({ kind: "odin-build-generator", attrs: { root, exclude } });
}

export function odinPackage(opts) {
    const attrs = opts || {};
    return target({
        kind: "odin-package",
        attrs,
        sources: sourcesField({
            root: attrs.path || ".",
            include: attrs.srcs || [],
            exclude: attrs.exclude || [],
        }),
    });
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

export const jodin = odinPackage({ srcs: ["**/*.odin"], deps: [cmake] });
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

    #[tokio::test]
    async fn host_js_logs_are_written_to_prodash_messages() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(p.join(WORKSPACE_FILE).as_path(), "");
        write_file(
            p.join(BUILD_FILE).as_path(),
            r#"
import { target, logDebug, logInfo, logWarn, logError } from "imp:core";

logDebug("debug message");
logInfo("info message");
logWarn("warn message");
logError("error message");

export const app = target({ kind: "sample" });
"#,
        );

        let progress_root = prodash::tree::Root::new();
        let log_item = progress_root.add_child("workspace logs");
        let _workspace = load_workspace_with_host_log(p, HostLogSink::prodash(log_item))
            .await
            .unwrap();

        let mut messages = Vec::new();
        progress_root.copy_messages(&mut messages);
        let rendered = messages
            .iter()
            .map(|message| {
                format!(
                    "{}::{:?}::{}",
                    message.origin, message.level, message.message
                )
            })
            .collect::<Vec<_>>()
            .join("\n");

        assert!(rendered.contains("workspace logs::Info::[debug] debug message"));
        assert!(rendered.contains("workspace logs::Info::[info] info message"));
        assert!(rendered.contains("workspace logs::Info::[warn] warn message"));
        assert!(rendered.contains("workspace logs::Failure::[error] error message"));
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
                tools: Vec::new(),
                display: argv.join(" "),
                impure: false,
                force_cache: false,
                sandbox: true,
            },
            outputs,
            dependencies: deps.iter().map(|dep| (*dep).to_owned()).collect(),
            js_id: 0,
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

    #[tokio::test]
    async fn workspace_loads_config_before_build_files() {
        let root = fixture();
        let workspace = load_workspace(root.path()).await.unwrap();

        // Products registered by workspace.js imports.
        assert!(workspace
            .products
            .contains_key(&("odin-package".into(), "odin-package".into())));
        assert!(workspace
            .products
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

    #[tokio::test]
    async fn workspace_can_mount_external_rule_packages() {
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
import { target, product, run } from "imp:core";
import { actionName } from "//rules/external/helper";

export const external_product = product("external", "external-product", async function external_product(handle) {
    return run({ argv: ["sh", "-c", "true"], display: actionName.replace("{address}", handle.label.address), impure: true });
});

export function externalThing(name) {
    return target({ kind: "external", attrs: { name } });
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

        let workspace = load_workspace(p).await.unwrap();
        assert!(workspace
            .products
            .contains_key(&("external".into(), "external-product".into())));
        assert_eq!(
            workspace.targets["//:app"].attrs["name"].as_str().unwrap(),
            "app"
        );

        let plan = plan_live(&workspace, p, "build", &["app".into()])
            .await
            .unwrap();
        assert!(plan.roots[0].starts_with("//:app#external-product:memo"));
        assert!(plan
            .tasks
            .iter()
            .any(|task| task.action.display == "external build //:app"));
    }

    #[tokio::test]
    async fn workspace_root_is_discovered_from_a_nested_directory() {
        let root = fixture();
        let nested = root.path().join("library/jodin");
        assert_eq!(find_workspace_root(&nested).unwrap(), root.path());
    }

    #[tokio::test]
    async fn build_goal_plans_transitive_products() {
        let root = fixture();
        let workspace = load_workspace(root.path()).await.unwrap();
        let plan = plan_live(
            &workspace,
            root.path(),
            "build",
            &["//library/jodin:jodin".into()],
        )
        .await
        .unwrap();

        assert!(plan.roots[0].starts_with("//library/jodin:jodin#odin-package:memo"));
        assert!(plan
            .tasks
            .iter()
            .any(|task| task.action.display == "odin build"));
        assert!(plan
            .tasks
            .iter()
            .any(|task| task.action.display.contains("sources(")));
    }

    #[tokio::test]
    async fn workspace_config_is_available_to_product_functions() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import { configure } from "imp:core";
import "//rules/configured";

configure("example", { flags: { mode: "debug" } });
"#,
        );
        write_file(
            &p.join("rules/configured.js"),
            r#"
import { target, glob, memo, product, run, configuration } from "imp:core";

export const sources = memo(async function sources(handle) {
    return glob({ root: ".", include: handle.attrs.sources || [] });
});

export const configured_flags = memo(async function configured_flags(handle) {
    const config = configuration("example", {}) || {};
    return Object.entries(config.flags || {}).map(([name, value]) => `--${name}=${value}`);
});

export const configured_product = product("configured", "configured-product", async function configured_product(handle) {
    const srcs = await sources(handle);
    const flags = await configured_flags(handle);
    return run({ argv: ["sh", "-c", "true"], inputs: [srcs], display: `configured ${flags.join(" ")}`, impure: true });
});

export function configured({ srcs }) {
    return target({ kind: "configured", attrs: { sources: srcs } });
}
"#,
        );
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { configured } from "//rules/configured";

export const pkg = configured({ srcs: ["**/*.txt"] });
"#,
        );

        let workspace = load_workspace(p).await.unwrap();
        assert_eq!(
            workspace.workspace_config["example"]["flags"]["mode"]
                .as_str()
                .unwrap(),
            "debug"
        );
        let pkg_plan = plan_live(&workspace, p, "build", &["pkg".into()])
            .await
            .unwrap();
        assert!(pkg_plan
            .tasks
            .iter()
            .any(|task| task.action.display.contains("--mode=debug")));

        let all = plan_live(&workspace, p, "build", &[]).await.unwrap();
        assert!(all
            .roots
            .iter()
            .any(|root| root.starts_with("//:pkg#configured-product:memo")));
    }

    #[tokio::test]
    async fn new_target_kinds_and_products_need_no_rust_changes() {
        let root = fixture();
        let workspace = load_workspace(root.path()).await.unwrap();
        let plan = plan_live(&workspace, root.path(), "build", &["//assets:ui".into()])
            .await
            .unwrap();

        assert!(plan.roots[0].starts_with("//assets:ui#bundle:memo"));
        assert!(plan
            .tasks
            .iter()
            .any(|t| t.action.display.contains("**/*.png")));
    }

    #[tokio::test]
    async fn product_plans_round_trip_through_json() {
        let root = fixture();
        let workspace = load_workspace(root.path()).await.unwrap();
        let plan = plan_live(&workspace, root.path(), "build", &["jodin".into()])
            .await
            .unwrap();

        let encoded = serde_json::to_string_pretty(&plan).unwrap();
        assert!(encoded.contains("\"goal\": \"build\""));
        assert!(encoded.contains("\"display\": \"odin build\""));

        let decoded: Plan = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, plan);
        assert_eq!(render_dot(&decoded), render_dot(&plan));
    }

    #[tokio::test]
    async fn structured_rule_actions_lower_to_serializable_tasks() {
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
import { target, output, product, run } from "imp:core";

export const generated = product("generator", "generated", async function generated(handle) {
  return run({
    argv: ["gen-tool", handle.attrs.sources],
    env: { TARGET: handle.label.address },
    inputs: [{ kind: "file", path: handle.attrs.sources }],
    outputs: [output(`build/${handle.attrs.entrypoint}.out`)],
    display: `generate ${handle.attrs.sources}`,
  });
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

        let workspace = load_workspace(p).await.unwrap();
        let plan = plan_live(&workspace, p, "build", &["schema".into()])
            .await
            .unwrap();
        let task = plan
            .tasks
            .iter()
            .find(|task| task.action.display == "generate schema.idl")
            .unwrap();

        assert_eq!(task.action.argv, ["gen-tool", "schema.idl"]);
        assert_eq!(task.action.env["TARGET"], "//:schema");
        assert_eq!(task.action.display, "generate schema.idl");
        assert_eq!(task.inputs[0].kind, "file");
        assert_eq!(task.inputs[0].path.as_deref(), Some("schema.idl"));
        assert_eq!(task.inputs[0].producer, None);
        assert_eq!(task.outputs[0].path.as_deref(), Some("build/schemas.out"));
        assert_eq!(task.outputs[0].producer.as_deref(), Some(task.id.as_str()));
        assert_eq!(task.action.inputs, [task.inputs[0].id.clone()]);
        assert_eq!(task.action.outputs, [task.outputs[0].id.clone()]);
    }

    #[tokio::test]
    async fn dry_run_executor_uses_dependency_order_without_running_commands() {
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

    #[tokio::test]
    async fn local_executor_materializes_embedded_manifest_outputs() {
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

    #[tokio::test]
    async fn parallel_executor_runs_independent_ready_tasks() {
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

    #[tokio::test]
    async fn parallel_executor_waits_for_dependencies() {
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

    #[tokio::test]
    async fn parallel_executor_failure_prevents_downstream_execution() {
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

    #[tokio::test]
    async fn parallel_executor_cancels_running_siblings_after_failure() {
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

    #[tokio::test]
    async fn executor_cancels_running_task_from_external_flag() {
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("external-cancel.marker");
        let task_id = unique_task_id("external-cancel");
        let slow_cmd = format!("sleep 5 && printf slow > {}", marker.display());
        let plan = Plan {
            goal: "build".to_owned(),
            roots: vec![task_id.clone()],
            named_caches: Vec::new(),
            tasks: vec![executable_task(
                &task_id,
                &[],
                &["sh", "-c", &slow_cmd],
                None,
            )],
        };

        let cancellation = Arc::new(AtomicBool::new(false));
        let cancellation_thread = Arc::clone(&cancellation);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            cancellation_thread.store(true, Ordering::SeqCst);
        });

        let started = std::time::Instant::now();
        let error = format!(
            "{:#}",
            execute_plan_with_options(
                &plan,
                None,
                root.path(),
                ExecutionOptions::new(ExecutionMode::Local, 1).with_cancellation(cancellation),
                None,
            )
            .unwrap_err()
        );

        assert!(
            started.elapsed() < Duration::from_secs(2),
            "external cancellation waited for task to finish"
        );
        assert!(error.contains("canceled"), "{error}");
        std::thread::sleep(Duration::from_millis(200));
        assert!(!marker.exists());
    }

    #[tokio::test]
    async fn jobs_one_preserves_sequential_execution_order() {
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

    #[tokio::test]
    async fn local_executor_runs_commands_and_checks_declared_outputs() {
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

    #[tokio::test]
    async fn local_executor_gathers_declared_file_inputs_into_sandbox() {
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

    #[tokio::test]
    async fn local_executor_publishes_directory_outputs_atomically() {
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

    #[tokio::test]
    async fn progress_executor_streams_process_output_path() {
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
    fn process_output_is_reported_as_recent_prodash_child_rows() {
        let progress_root = prodash::tree::Root::new();
        let mut progress = progress_root.add_child("execute task");
        let mut recent_output = VecDeque::new();

        report_process_line(
            &mut progress,
            &mut recent_output,
            &ProcessLine {
                stream: ProcessStream::Stdout,
                line: "stdout-line".to_owned(),
            },
        );
        report_process_line(
            &mut progress,
            &mut recent_output,
            &ProcessLine {
                stream: ProcessStream::Stderr,
                line: "stderr-line".to_owned(),
            },
        );

        let mut snapshot = Vec::new();
        progress_root.sorted_snapshot(&mut snapshot);

        assert!(snapshot
            .iter()
            .any(|(_, task)| task.name == "out: stdout-line" && task.progress.is_none()));
        assert!(snapshot
            .iter()
            .any(|(_, task)| task.name == "err: stderr-line" && task.progress.is_none()));
    }

    #[test]
    fn process_output_reader_splits_carriage_return_progress() {
        let (sender, receiver) = mpsc::channel();
        let reader = std::io::Cursor::new(b"configure\rbuild\ninstall\r\n");
        let thread = spawn_output_reader(reader, ProcessStream::Stdout, sender);
        thread.join().unwrap();

        let lines = receiver
            .try_iter()
            .map(|line| line.line)
            .collect::<Vec<_>>();

        assert_eq!(lines, ["configure", "build", "install"]);
    }

    #[test]
    fn sandbox_run_script_records_cwd_env_and_command() {
        let root = tempfile::tempdir().unwrap();
        let script_path = root.path().join("imp-run.sh");
        let cwd = root.path().join("work dir");
        std::fs::create_dir_all(&cwd).unwrap();
        let env = BTreeMap::from([("NAME".to_owned(), "value with spaces".to_owned())]);
        let argv = vec![
            "sh".to_owned(),
            "-c".to_owned(),
            "printf 'hello world'".to_owned(),
        ];

        write_sandbox_run_script(&script_path, &cwd, &env, &argv).unwrap();
        let script = std::fs::read_to_string(script_path).unwrap();

        assert!(script.contains("cd "));
        assert!(script.contains("export NAME='value with spaces'"));
        assert!(script.contains("exec sh -c 'printf '\\''hello world'\\'''"));
    }

    #[tokio::test]
    async fn unchanged_second_execution_uses_task_cache_hit() {
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

    #[tokio::test]
    async fn no_cache_execution_bypasses_and_does_not_populate_task_cache() {
        let root = tempfile::tempdir().unwrap();
        let task_id = unique_task_id("no-cache");
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

        let no_cache_options = ExecutionOptions::new(ExecutionMode::Local, 1).with_no_cache(true);
        let first =
            execute_plan_with_options(&plan, None, root.path(), no_cache_options.clone(), None)
                .unwrap();
        assert_eq!(first.tasks[0].status, TaskExecutionStatus::Ran);
        std::fs::remove_file(root.path().join("build/out.txt")).unwrap();

        let second = execute_plan(&plan, root.path(), ExecutionMode::Local).unwrap();
        assert_eq!(second.tasks[0].status, TaskExecutionStatus::Ran);
        std::fs::remove_file(root.path().join("build/out.txt")).unwrap();

        let third = execute_plan(&plan, root.path(), ExecutionMode::Local).unwrap();
        assert_eq!(third.tasks[0].status, TaskExecutionStatus::CacheHit);
        std::fs::remove_file(root.path().join("build/out.txt")).unwrap();

        let fourth =
            execute_plan_with_options(&plan, None, root.path(), no_cache_options, None).unwrap();
        assert_eq!(fourth.tasks[0].status, TaskExecutionStatus::Ran);
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "ranranran");
    }

    #[tokio::test]
    async fn editing_declared_input_invalidates_downstream_tasks() {
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

    #[tokio::test]
    async fn local_executor_exposes_named_cache_environment_paths() {
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

    #[cfg(unix)]
    #[tokio::test]
    async fn product_run_materializes_named_cache_tools_on_path() {
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
import { namedCache, output, product, run, target } from "imp:core";

namedCache({ name: "test-tools" });

export const file = product("tool-user", "file", async function file(handle) {
    return run({
        argv: ["hello-tool"],
        tools: [{
            name: "hello",
            cache: "test-tools",
            key: "v1/linux-x86_64",
            binDirs: ["bin"],
        }],
        outputs: [output("out.txt")],
        display: "hello tool",
    });
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

        let live = load_workspace(p).await.unwrap();
        let plan = plan_live(&live, p, "build", &["generated".to_owned()])
            .await
            .unwrap();
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
            .any(|task| task.status == TaskExecutionStatus::Ran));
        assert_eq!(
            std::fs::read_to_string(p.join("out.txt")).unwrap(),
            "from-tool"
        );
    }

    #[tokio::test]
    async fn local_executor_reports_missing_declared_outputs() {
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

    #[tokio::test]
    async fn root_relative_imports_can_resolve_build_directory_modules() {
        let root = fixture();
        let workspace = load_workspace(root.path()).await.unwrap();
        assert!(workspace.targets.contains_key("//library/jodin:jodin"));
    }

    #[tokio::test]
    async fn root_relative_imports_can_resolve_index_js_modules() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import "//rules/pkg";
"#,
        );
        write_file(
            &p.join("rules/pkg/index.js"),
            r#"
import { target } from "imp:core";
export function pkg() { return target({ kind: "pkg", attrs: {} }); }
"#,
        );
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { pkg } from "//rules/pkg";
export const app = pkg();
"#,
        );

        let workspace = load_workspace(p).await.unwrap();
        assert!(workspace.targets.contains_key("//:app"));
    }

    #[tokio::test]
    async fn relative_imports_from_build_files_are_rejected_with_context() {
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

        let error = format!("{:#}", load_workspace(p).await.unwrap_err());
        assert!(
            error.contains("relative import './rules/asset' is prohibited in BUILD.js"),
            "{error}"
        );
        assert!(error.contains("BUILD.js"), "{error}");
        assert!(error.contains("//..."), "{error}");
    }

    #[tokio::test]
    async fn unknown_builtin_modules_are_reported_distinctly() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import "imp:missing";
"#,
        );
        write_file(&p.join(BUILD_FILE), "export const ignored = 1;\n");

        let error = format!("{:#}", load_workspace(p).await.unwrap_err());
        assert!(
            error.contains("unknown built-in module 'imp:missing'"),
            "{error}"
        );
        assert!(error.contains(WORKSPACE_FILE), "{error}");
    }

    #[tokio::test]
    async fn missing_workspace_modules_report_importer_and_candidates() {
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

        let error = format!("{:#}", load_workspace(p).await.unwrap_err());
        assert!(
            error.contains("cannot resolve workspace module '//rules/missing'"),
            "{error}"
        );
        assert!(error.contains("rules/missing.js"), "{error}");
        assert!(error.contains("rules/missing/BUILD.js"), "{error}");
        assert!(error.contains(BUILD_FILE), "{error}");
    }

    #[tokio::test]
    async fn test_select_targets() {
        let root = fixture();
        let workspace = load_workspace(root.path()).await.unwrap();

        let all = select_targets(&workspace, &[]).unwrap();
        // joltphysics, cmake, jodin, ui = 4
        assert_eq!(all.len(), 4);

        let sel = select_targets(&workspace, &["jodin".to_owned()]).unwrap();
        assert_eq!(sel.len(), 1);
        assert_eq!(sel[0].address, "//library/jodin:jodin");

        assert!(select_targets(&workspace, &["nonexistent".to_owned()]).is_err());
    }

    #[tokio::test]
    async fn test_format_targets() {
        let root = fixture();
        let workspace = load_workspace(root.path()).await.unwrap();
        let targets = select_targets(&workspace, &["jodin".to_owned()]).unwrap();
        let mut out = String::new();
        format_targets(&targets, &mut out).unwrap();
        assert!(out.contains("//library/jodin:jodin (odin-package)"));
        assert!(out.contains("sources: **/*.odin"));
        assert!(out.contains("dependencies: //src/cpp/joltphysics:cmake"));
    }

    #[tokio::test]
    async fn test_format_dependencies() {
        let root = fixture();
        let workspace = load_workspace(root.path()).await.unwrap();
        let mut out = String::new();
        format_dependencies(&workspace, &["jodin".to_owned()], &mut out).unwrap();
        let expected = "\
//library/jodin:jodin
└── //src/cpp/joltphysics:cmake
    └── //src/cpp/joltphysics:joltphysics
";
        assert_eq!(out, expected);
    }

    #[tokio::test]
    async fn test_format_products() {
        let root = fixture();
        let workspace = load_workspace(root.path()).await.unwrap();
        let mut out = String::new();
        format_products(&workspace, &mut out).unwrap();
        assert!(out.contains("Target Kinds:"));
        assert!(out.contains("  - odin-package (default product: odin-package)"));
        assert!(out.contains("Products:"));
        assert!(out.contains("  odin-package:"));
        assert!(out.contains("    - odin-package"));
    }

    #[tokio::test]
    async fn dot_edges_flow_from_prerequisites_to_consumers() {
        let root = fixture();
        let workspace = load_workspace(root.path()).await.unwrap();
        let plan = plan_live(&workspace, root.path(), "build", &["jodin".into()])
            .await
            .unwrap();
        let dot = render_dot(&plan);

        assert!(dot.contains("rankdir=TB"));
        assert!(dot.contains("//library/jodin:jodin#odin-package"));
        assert!(dot.contains(" -> "));
    }

    #[tokio::test]
    async fn impure_task_is_not_cacheable() {
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

    #[tokio::test]
    async fn force_cache_overrides_impure_task() {
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

    #[tokio::test]
    async fn non_impure_task_uses_existing_heuristic() {
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

    #[tokio::test]
    async fn javascript_can_use_platform_info() {
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

        load_workspace(p).await.unwrap();
    }

    #[tokio::test]
    async fn javascript_can_use_sha256() {
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

        write_file(
            &p.join(WORKSPACE_FILE),
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

        load_workspace(p).await.unwrap();
    }

    #[tokio::test]
    async fn javascript_can_use_cache_operations() {
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

        load_workspace(p).await.unwrap();
    }

    #[tokio::test]
    async fn javascript_can_use_extract() {
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

        load_workspace(p).await.unwrap();
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

    #[tokio::test]
    async fn quickjs_host_run_promises_can_resolve_with_promise_all() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(&p.join(BUILD_FILE), r#"export const done = true;"#);

        let live = load_workspace(p).await.unwrap();
        *live.exec_root.lock().unwrap() = Some(p.to_owned());

        live.ctx
            .async_with(async |ctx| -> rquickjs::Result<()> {
                let promise = Module::evaluate(
                    ctx.clone(),
                    "host-run-promise-all",
                    r#"
import { run } from "imp:core";

const results = await Promise.all([
    run({ argv: ["sh", "-c", "printf a"], impure: true }),
    run({ argv: ["sh", "-c", "printf b"], impure: true }),
]);

if (!results[0].stdout.endsWith("a\n") || !results[1].stdout.endsWith("b\n")) {
    throw new Error(`unexpected stdout: ${results[0].stdout}/${results[1].stdout}`);
}
"#,
                )?;
                promise.into_future::<()>().await.catch(&ctx).map_err(|e| {
                    rquickjs::Error::new_loading_message("host-run-promise-all", format!("{e}"))
                })?;
                Ok(())
            })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn product_registration_creates_dispatchable_product_task() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
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

        let live = load_workspace(p).await.unwrap();

        // The product is listed in the workspace.
        assert!(
            live.products
                .contains_key(&("test-pkg".to_owned(), "report".to_owned())),
            "product should be registered in workspace"
        );

        // Static planning with an explicit #product selector creates a product placeholder task.
        let plan = plan(&live, "build", &["//:pkg#report".to_owned()])
            .await
            .unwrap();
        assert_eq!(plan.tasks.len(), 1);
        let task = &plan.tasks[0];
        assert_eq!(task.product, "report");

        // Live planning discovers the product memo call.
        let live_plan = plan_live(&live, p, "build", &["//:pkg#report".to_owned()])
            .await
            .unwrap();
        assert!(live_plan.tasks[0].id.starts_with("//:pkg#report:memo"));
    }

    #[tokio::test]
    async fn product_selector_hash_syntax_is_parsed() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target, product } from "imp:core";

export const pkg = target({ kind: "kind-a", fields: {} });

export const check = product("kind-a", "check", async function check(handle) {});
"#,
        );

        let live = load_workspace(p).await.unwrap();

        // //:pkg#check should select the "check" product explicitly.
        let task_plan = plan(&live, "build", &["//:pkg#check".to_owned()])
            .await
            .unwrap();
        assert_eq!(task_plan.tasks.len(), 1);
        assert_eq!(task_plan.tasks[0].product, "check");

        // An unknown product in the selector should fail.
        let err = plan(&live, "build", &["//:pkg#nonexistent".to_owned()])
            .await
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("no product 'nonexistent'"),
            "expected product-not-found error, got: {err}"
        );
    }

    #[tokio::test]
    async fn source_fields_mark_owned_files_relative_to_declaring_package() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join("library/pkg/BUILD.js"),
            r#"
import { sourcesField, target } from "imp:core";

export const pkg = target({
    kind: "owned-source-test",
    attrs: {},
    sources: sourcesField({
        root: "src",
        include: ["*.odin"],
        exclude: ["ignored.odin"],
    }),
});
"#,
        );
        write_file(&p.join("library/pkg/src/main.odin"), "package pkg\n");
        write_file(&p.join("library/pkg/src/ignored.odin"), "package pkg\n");
        write_file(&p.join("library/pkg/other.odin"), "package pkg\n");

        let live = load_workspace(p).await.unwrap();
        assert!(live
            .workspace
            .owned_files
            .contains("library/pkg/src/main.odin"));
        assert!(!live
            .workspace
            .owned_files
            .contains("library/pkg/src/ignored.odin"));
        assert!(!live
            .workspace
            .owned_files
            .contains("library/pkg/other.odin"));
    }

    #[tokio::test]
    async fn generate_build_product_creates_raw_build_files() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), r#"import "//rules/odin";"#);
        write_file(&p.join("rules/odin.js"), GENERATE_BUILD_RULES_JS);
        write_file(
            &p.join(BUILD_FILE),
            r#"
export const done = true;
"#,
        );
        write_file(&p.join("app/main.odin"), "package app\n");
        write_file(&p.join("library/spall/spall.odin"), "package spall\n");
        write_file(&p.join("vendor/ignored/main.odin"), "package ignored\n");

        let live = load_workspace(p).await.unwrap();
        let report = generate_build_files(&live, p, &[], false).await.unwrap();
        assert_eq!(
            report.changed_files,
            vec![
                "app/BUILD.js".to_owned(),
                "library/spall/BUILD.js".to_owned()
            ]
        );

        let app_build = std::fs::read_to_string(p.join("app/BUILD.js")).unwrap();
        assert!(app_build.contains(r#"import { odinPackage } from "//rules/odin";"#));
        assert!(app_build.contains("export const app = odinPackage({"));
        assert!(app_build.contains(r#"srcs: ["*.odin"]"#));
        assert!(!app_build.contains("imp generated"));
        assert!(!p.join("vendor/ignored/BUILD.js").exists());

        let live = load_workspace(p).await.unwrap();
        let check_report = generate_build_files(&live, p, &[], true).await.unwrap();
        assert!(check_report.changed_files.is_empty());
    }

    #[tokio::test]
    async fn generate_build_runs_all_registered_generate_build_products_by_default() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import "//rules/odin";
import "//rules/custom";
"#,
        );
        write_file(&p.join("rules/odin.js"), GENERATE_BUILD_RULES_JS);
        write_file(
            &p.join("rules/custom.js"),
            r#"
import { product } from "imp:core";

export const generateBuild = product("custom-generator", "generate-build", async function generateBuild() {
    return {
        "custom/BUILD.js": [{
                name: "custom",
                rule: "odinPackage",
                props: { srcs: ["*.odin"] },
            }],
    };
});
"#,
        );
        write_file(
            &p.join(BUILD_FILE),
            r#"
export const done = true;
"#,
        );
        write_file(&p.join("app/main.odin"), "package app\n");

        let live = load_workspace(p).await.unwrap();
        let report = generate_build_files(&live, p, &[], false).await.unwrap();
        assert_eq!(
            report.changed_files,
            vec!["app/BUILD.js".to_owned(), "custom/BUILD.js".to_owned()]
        );
        assert!(p.join("app/BUILD.js").exists());
        assert!(p.join("custom/BUILD.js").exists());
    }

    #[tokio::test]
    async fn generate_build_check_fails_when_files_are_stale() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), r#"import "//rules/odin";"#);
        write_file(&p.join("rules/odin.js"), GENERATE_BUILD_RULES_JS);
        write_file(
            &p.join(BUILD_FILE),
            r#"
export const done = true;
"#,
        );
        write_file(&p.join("app/main.odin"), "package app\n");

        let live = load_workspace(p).await.unwrap();
        let error = generate_build_files(&live, p, &[], true)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("generated BUILD files are out of date"));
        assert!(error.contains("app/BUILD.js"));
    }

    #[tokio::test]
    async fn generate_build_skips_files_owned_by_existing_targets() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), r#"import "//rules/odin";"#);
        write_file(&p.join("rules/odin.js"), GENERATE_BUILD_RULES_JS);
        write_file(
            &p.join(BUILD_FILE),
            r#"
export const done = true;
"#,
        );
        write_file(&p.join("app/main.odin"), "package app\n");
        write_file(&p.join("library/spall/spall.odin"), "package spall\n");
        write_file(
            &p.join("library/spall/BUILD.js"),
            r#"
import { odinPackage } from "//rules/odin";

export const spall = odinPackage({ srcs: ["*.odin"] });
"#,
        );

        let live = load_workspace(p).await.unwrap();
        assert!(live
            .workspace
            .owned_files
            .contains("library/spall/spall.odin"));
        let report = generate_build_files(&live, p, &[], false).await.unwrap();
        assert_eq!(report.changed_files, vec!["app/BUILD.js".to_owned()]);
        let spall_build = std::fs::read_to_string(p.join("library/spall/BUILD.js")).unwrap();
        assert_eq!(spall_build.matches("export const spall").count(), 1);
    }

    #[tokio::test]
    async fn raw_build_renderer_renders_target_refs_as_imports() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let mut build_rules = BTreeMap::new();
        build_rules.insert(
            "odinPackage".to_owned(),
            BuildRuleRender {
                import_from: "//rules/odin".to_owned(),
                import_name: "odinPackage".to_owned(),
            },
        );
        let mut edits = BTreeMap::new();
        edits.insert(
            "app/BUILD.js".to_owned(),
            vec![GeneratedBuildTarget {
                name: "app".to_owned(),
                rule: "odinPackage".to_owned(),
                props: serde_json::json!({
                    "srcs": ["*.odin"],
                    "deps": [{ "__imp_target_ref": true, "address": "//library/spall:spall" }]
                }),
            }],
        );

        apply_build_edits(p, &build_rules, edits, false).unwrap();
        let content = std::fs::read_to_string(p.join("app/BUILD.js")).unwrap();
        assert!(content.contains(r#"import { spall } from "//library/spall";"#));
        assert!(content.contains("deps: [spall]"));
        assert!(!content.contains("imp generated"));
    }
}
