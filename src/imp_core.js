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

// Task-tree tracking. Each memo evaluation is a node with a numeric id; the
// node currently executing is _current_owner_node, captured explicitly at each
// call site and re-entered when an instrumented await (a sub-memo, run(), etc.)
// resolves — the JS analogue of tracing's per-poll span enter. See the memo
// wrapper and run() for the restore points.
let _current_owner_node = null;
let _memo_node_counter = 0;

function _emit_task(state, id, parent, label) {
    if (typeof globalThis.__host_task_event === "function") {
        globalThis.__host_task_event(state, id, parent === null ? undefined : parent, label);
    }
}

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

function _memo_eval(key_string, owner, label, thunk) {
    // Table check BEFORE stack check. Once a memo suspends at its first real
    // await, its promise is registered here while its frame is still on the
    // call stack. A concurrent branch (e.g. two roots sharing a dependency)
    // that reaches the same in-flight memo must receive that pending promise —
    // this is normal fan-out, not a cycle.
    if (_memo_table.has(key_string)) {
        _memo_trace.push({ event: "hit", key: key_string });
        return _memo_table.get(key_string);
    }
    // On the call stack but not yet registered ⇒ the thunk re-entered itself
    // synchronously, before its promise existed: a genuine cycle. (An await
    // between the calls would have registered the promise above, so only true
    // synchronous recursion reaches here.)
    if (_memo_call_stack_set.has(key_string)) {
        throw new Error(_memo_cycle_message(key_string));
    }
    _memo_trace.push({ event: "miss", key: key_string });
    // A fresh node for this evaluation, parented at the caller captured at the
    // call site. Created on miss only, so a memo appears once (concurrent
    // reusers just await it). Call thunk() synchronously so _push_call runs
    // before the first await, keeping the call stack accurate.
    const nodeId = ++_memo_node_counter;
    _emit_task("pending", nodeId, owner, label);
    const promise = thunk(nodeId);
    _memo_table.set(key_string, promise);
    promise.then(
        () => _emit_task("done", nodeId, owner, label),
        (e) => _emit_task("fail", nodeId, owner, (e && e.message) || String(e)),
    );
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
        const label = _key_display.get(key_string) || key_string;
        // Capture the caller (parent) synchronously at the call site.
        const owner = _current_owner_node;
        try {
            return await _memo_eval(key_string, owner, label, (nodeId) => (async () => {
                _emit_task("running", nodeId, owner, label);
                _push_call(key_string);
                const prevOwner = _current_owner_node;
                _current_owner_node = nodeId;
                try {
                    return await fn(...args);
                } finally {
                    _current_owner_node = prevOwner;
                    _pop_call(key_string);
                }
            })());
        } finally {
            // Re-enter the caller's owner as this memo settles, so the caller's
            // continuation resumes under the correct parent.
            _current_owner_node = owner;
        }
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
    _current_owner_node = null;
    _memo_node_counter = 0;
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
    // Instrumented await: the job nests under the owning memo (__owner), and we
    // re-enter that owner when the job settles so the caller resumes correctly.
    const owner = _current_owner_node;
    try {
        return await __host_run({
            argv: opts.argv,
            display: opts.display,
            env: opts.env,
            inputs,
            outputs,
            tools: opts.tools,
            impure: opts.impure,
            forceCache: opts.forceCache,
            sandbox: opts.sandbox,
            __owner: owner,
        });
    } finally {
        _current_owner_node = owner;
    }
}

export async function group(items) {
    if (!Array.isArray(items)) {
        throw new Error("group(items) requires an array");
    }
    _trace_effect({ event: "effect", kind: "group", count: items.length });
    const owner = _current_owner_node;
    try {
        return await Promise.all(items);
    } finally {
        _current_owner_node = owner;
    }
}

export async function workspace_mutation(opts) {
    const trace_entry = { event: "effect", kind: "workspace_mutation", display: opts.display ?? (opts.argv && opts.argv[0]) };
    _trace_effect(trace_entry);
    const owner = _current_owner_node;
    let result;
    try {
        result = await __host_workspace_mutation({ ...opts, __owner: owner });
    } finally {
        _current_owner_node = owner;
    }
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
