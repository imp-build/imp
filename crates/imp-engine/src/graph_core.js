
// ---------------------------------------------------------------------------
// Exported handle graphs. This file is concatenated onto imp_core.js by the
// native loader, so it deliberately shares that module's private helpers.
// ---------------------------------------------------------------------------

let _graphNextHandle = 1;
let _graphNextTask = 1;
let _graphNextExpansion = 1;
const _graphHandles = new Map();
const _graphTasks = new Map();
const _graphTasksByKey = new Map();
const _graphExpansions = new Map();
let _graphTaskMemo = new Map();
let _graphExpansionMemo = new Map();
// Mode-axis namespace, mirrored from MODE_AXIS_NAMESPACE in spike.rs. A
// semantic.config() read of this namespace returns the whole axis bundle,
// so such a node depends on every axis rather than a named one.
const _GRAPH_MODE_NAMESPACE = "imp.mode";

// Marks a node that reads the whole mode bundle instead of named axes.
const _GRAPH_AXES_ALL = Symbol("graph-axes-all");

// Which mode axes the inputs of each node can reach, for the length of one
// goal run. A node has to be built one time for each configuration only if
// the axes it reads differ between those configurations; a node that reads
// no axis stays shared. This map is what keeps configuration-blind work
// from being done two times.
let _graphAxes = new Map();

// The axes the inputs of each expansion can reach. Kept apart from
// `_graphAxes` because the two answer different questions: the axes of an
// `expansion.get()` node include what `create()` discovered below it, but
// `create()` itself sees only the inputs of the expansion. A node forks per
// configuration on the first; the expansion body forks on the second.
let _graphExpansionAxes = new Map();

// The configuration a node resolves under.
//
// `overlay` holds the mode axes an edge changed for its subtree; `key` is
// the canonical form of that overlay. The scope is a parameter, not an
// ambient global: resolution is concurrent, thus a global held across an
// await is readable by unrelated interleaved work. For the phase marker
// that mistake gives a wrong error message; for a configuration overlay it
// gives a wrong build.
const _GRAPH_ROOT_SCOPE = Object.freeze({ overlay: Object.freeze({}), key: "" });

// Canonical text for an overlay. Sorted, thus two edges that set the same
// axes in a different order give one key and share one node.
function _graphScopeKey(overlay) {
	const names = Object.keys(overlay).sort();
	if (names.length === 0) return "";
	return JSON.stringify(names.map((name) => [name, overlay[name]]));
}

// The value of one axis under a scope: what the edge set, or else what the
// invocation resolved.
function _graphEffectiveAxis(axis, cfg) {
	if (Object.hasOwn(cfg.overlay, axis)) return cfg.overlay[axis];
	return _graphInvocation?.mode?.[axis] ?? null;
}

// The part of a scope one node can observe.
//
// Keying a memo by the whole scope is correct but forks the whole graph:
// every glob and every toolchain install would be done one time for each
// configuration. Keying by the axes the node actually reads forks only what
// can differ. A node that reads no axis gets an empty key and stays shared.
//
// The key holds the *values* the node reads, not the overlay that set them.
// An overlay is a diff, and two different diffs can name the same
// configuration: with `--axis opt=release`, the plain edge and an edge
// through `configured(x, {opt:"release"})` reach the same build. Keying by
// the overlay makes those two nodes; keying by the value makes them one.
//
// Must stay synchronous. The memo tables are filled before the first await
// to make single-flight structural (see `_graphExecuteTask`); a key that
// could await would let two scopes with one key both pass the lookup and
// run the node two times.
function _graphNarrowKey(axes, cfg) {
	// No closure recorded (a node made after the planning pass) reads as
	// "can read anything", which forks. Conservative, never wrong.
	if (axes === undefined || axes === _GRAPH_AXES_ALL) return cfg.key;
	if (axes.size === 0) return "";
	return JSON.stringify(
		[...axes].sort().map((axis) => [axis, _graphEffectiveAxis(axis, cfg)]),
	);
}

// Persistent graph actions cannot use the ambient memo context for their
// configuration salt: graph tasks execute concurrently, and the context may
// belong to an unrelated memo or task by the time an action reaches run().
// Build the salt from the same axis closure that keys the graph node instead.
// A missing closure is the conservative case used for handles resolved
// outside the normal graph planning pass.
function _graphActionConfigDigest(record, cfg) {
	const handleId = record.publicHandle?.__graph_id;
	const axes = handleId === undefined ? undefined : _graphAxes.get(handleId);
	if (axes === undefined || axes === _GRAPH_AXES_ALL) {
		const mode = { ...(_graphInvocation?.mode || {}) };
		for (const name of Object.keys(cfg.overlay).sort()) mode[name] = cfg.overlay[name];
		return __host_graph_configuration_digest(
			JSON.stringify({ scope: "all", mode }),
		);
	}
	const selected = {};
	for (const name of [...axes].sort()) selected[name] = _graphEffectiveAxis(name, cfg);
	return __host_graph_configuration_digest(
		JSON.stringify({ scope: "axes", values: selected }),
	);
}

function _graphMemoKey(id, narrow) {
	return narrow === "" ? id : `${id}|${narrow}`;
}

function _graphHandleMemoKey(id, cfg) {
	return _graphMemoKey(id, _graphNarrowKey(_graphAxes.get(id), cfg));
}

// A task and its public handle read the same axes, thus the handle carries
// the closure for both.
function _graphTaskMemoKey(taskId, cfg) {
	const record = _graphTasks.get(taskId);
	const handleId = record?.publicHandle?.__graph_id;
	return _graphMemoKey(
		taskId,
		_graphNarrowKey(handleId === undefined ? undefined : _graphAxes.get(handleId), cfg),
	);
}

function _graphExpansionMemoKey(expansionId, cfg) {
	return _graphMemoKey(
		expansionId,
		_graphNarrowKey(_graphExpansionAxes.get(expansionId), cfg),
	);
}

// Resolved value for each handle, for the length of one goal run. Without
// it, a files() node shared by N tasks globs the file system N times,
// because resolution rebuilds the value at each use. A handle stands for
// one value by its own definition — that is what its fingerprint means —
// thus one resolution per run is enough.
let _graphValueMemo = new Map();
let _graphInvocation = null;
let _graphPhase = "construction";
// True while one goal run owns the memo tables. See
// `__imp_graph_begin_run`.
let _graphRunActive = false;
// packagePath() normally derives its answer from the live JS call stack,
// which only means anything during synchronous BUILD.js evaluation. Any
// framework that registers a callback for later invocation — task()/
// expand()'s run()/create(), or a test runner's deferred test bodies (see
// rules/imp/test) — breaks that: by execution time the declaring module's
// frame is gone from the stack entirely, not just distant on it. The fix
// is the same shape everywhere: capture packagePath() once, synchronously,
// at registration time (still inside the declaring module's real
// evaluation), and deliver it through this one ambient slot instead,
// scoped for the callback's duration via withCapturedPackagePath(). Safe
// even under this engine's real concurrent root resolution (see
// __imp_execute_graph_handles's Promise.all) because JS is single-threaded
// — nothing can run between "we set this" and the callback's own
// synchronous prologue reading it. It only covers that synchronous
// prologue, though: a packagePath() call made after the callback itself
// awaits something is calling it out of contract, same as it always has
// been for anything but synchronous declare-time code.
let _graphAmbientPackagePath = null;

function _graphCapturePackagePath() {
	try {
		return packagePath();
	} catch (_) {
		return null;
	}
}

/**
 * Run `fn` with packagePath() resolving to `capturedPath` — captured
 * earlier, synchronously, via packagePath() itself at the point `fn` was
 * registered — for `fn`'s own synchronous prologue. Restores the previous
 * ambient value afterward. For frameworks that defer invoking a callback
 * past the point where normal stack-based packagePath() resolution would
 * still find the right module (see this file's own task()/expand() use,
 * and rules/imp/test's test runner).
 * @category graph
 */
export async function withCapturedPackagePath(capturedPath, fn) {
	const previous = _graphAmbientPackagePath;
	_graphAmbientPackagePath = capturedPath;
	try {
		return await fn();
	} finally {
		_graphAmbientPackagePath = previous;
	}
}

function _graphError(message) {
	return new Error(`graph: ${message}`);
}

// Mark whatever the host rejects an action with as a user-facing failure. The
// host builds that message from the program's own exit code and output, so the
// user needs the message and nothing else.
async function _graphMarkActionFailure(promise) {
	try {
		return await promise;
	} catch (error) {
		if (error instanceof Error) error.impGoalError = true;
		throw error;
	}
}

// Wrap a failure that came out of a task's run() body. `cause` decides how the
// host shows it. A failed action, or a rule that raised goalError() to report
// what a compiler, formatter, or test said, is a failure the user caused: it
// keeps the mark, and the host prints the report alone. Anything else is a
// fault in the rule itself, which keeps the "graph:" prefix and its full
// diagnostic, stack included.
function _graphTaskFailure(message, cause) {
	if (cause && cause.impGoalError === true) {
		const error = new Error(message);
		error.impGoalError = true;
		return error;
	}
	return _graphError(message);
}

function _graphHandle(kind, data, fingerprint, publicFields = {}) {
	const id = _graphNextHandle++;
	const handle = Object.freeze({
		__imp_graph_handle: true,
		__graph_id: id,
		...publicFields,
	});
	_graphHandles.set(id, { id, kind, data, fingerprint });
	return handle;
}

function _graphRecord(value, api) {
	if (!value || value.__imp_graph_handle !== true) {
		throw _graphError(`${api} expects a graph handle`);
	}
	const record = _graphHandles.get(value.__graph_id);
	if (record === undefined) {
		throw _graphError(`${api} received a foreign or expired graph handle`);
	}
	return record;
}

function _graphJson(value, path = "value", seen = new Set()) {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw _graphError(`${path} contains a non-finite number`);
		return value;
	}
	if (typeof value !== "object") {
		throw _graphError(`${path} must be JSON data or a graph handle, got ${typeof value}`);
	}
	if (seen.has(value)) throw _graphError(`${path} contains a cycle`);
	seen.add(value);
	let result;
	if (Array.isArray(value)) {
		result = value.map((entry, index) => _graphJson(entry, `${path}[${index}]`, seen));
	} else {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw _graphError(`${path} must be a plain JSON object`);
		}
		result = {};
		for (const key of Object.keys(value).sort()) {
			result[key] = _graphJson(value[key], `${path}.${key}`, seen);
		}
	}
	seen.delete(value);
	return Object.freeze(result);
}

function _graphCanonical(value) {
	if (value && value.__imp_graph_binding === true) {
		return JSON.stringify({ binding: value.fingerprint });
	}
	return JSON.stringify(value);
}

function _graphInput(value, path) {
	if (value && value.__imp_graph_handle === true) {
		const record = _graphRecord(value, path);
		return Object.freeze({ kind: "handle", handle: value, fingerprint: record.fingerprint });
	}
	const literal = _graphJson(value, path);
	return Object.freeze({ kind: "literal", value: literal, fingerprint: _graphCanonical(literal) });
}

function _graphInputs(values, api) {
	if (values === undefined) return Object.freeze({});
	if (values === null || typeof values !== "object" || Array.isArray(values)) {
		throw _graphError(`${api}.inputs must be an object`);
	}
	const result = {};
	for (const name of Object.keys(values).sort()) {
		result[name] = _graphInput(values[name], `${api}.inputs.${name}`);
	}
	return Object.freeze(result);
}

function _graphOutputSlots(outputs, api) {
	if (outputs === undefined) return Object.freeze({});
	if (outputs === null || typeof outputs !== "object" || Array.isArray(outputs)) {
		throw _graphError(`${api}.outputs must be an object`);
	}
	const result = {};
	for (const name of Object.keys(outputs).sort()) {
		if (!/^[A-Za-z0-9_.-]+$/.test(name))
			throw _graphError(`${api}.outputs has invalid slot name '${name}'`);
		const descriptor = outputs[name];
		if (!descriptor || descriptor.__imp_graph_output_slot !== true) {
			throw _graphError(`${api}.outputs.${name} must be output.artifact() or output.value()`);
		}
		result[name] = descriptor.kind;
	}
	return Object.freeze(result);
}

const _graphMemoByFingerprint = new Map();

// Return the existing handle for `fingerprint` if one was already built,
// otherwise build and remember one via `create()`. `task()` has always done
// this itself (`_graphTasksByKey`, below) so that two calls describing the
// same work share one cached execution; this generalizes the same
// fingerprint-keyed caching to every other constructor that describes an
// immutable, side-effect-free value — file()/files()/tool()/the native-tool
// constructors/semantic.*() — so e.g. `nativeTool("sh")` called from a dozen
// different toolchain helpers collapses into one shared node instead of a
// dozen look-alike ones. Safe by construction: these constructors never do
// anything but describe data, and task *caching* already keys off a handle's
// fingerprint rather than its id (see `_graphInput`), so merging identically-
// fingerprinted handles here changes no execution or invalidation behavior —
// only how many redundant nodes the graph carries.
function _graphMemoizedHandle(fingerprint, create) {
	const cached = _graphMemoByFingerprint.get(fingerprint);
	if (cached !== undefined) return cached;
	const handle = create();
	_graphMemoByFingerprint.set(fingerprint, handle);
	return handle;
}

output.artifact = () => Object.freeze({ __imp_graph_output_slot: true, kind: "artifact" });
output.value = () => Object.freeze({ __imp_graph_output_slot: true, kind: "value" });
output.file = (path, opts) => {
	if (typeof path !== "string" || path.length === 0)
		throw _graphError("output.file(path) requires a non-empty path");
	return Object.freeze({
		__imp_graph_action_output: true,
		kind: "file",
		path,
		...(opts && opts.namedCache ? { namedCache: opts.namedCache } : {}),
	});
};
output.directory = (path, opts) => {
	if (typeof path !== "string" || path.length === 0)
		throw _graphError("output.directory(path) requires a non-empty path");
	return Object.freeze({
		__imp_graph_action_output: true,
		kind: "directory",
		path,
		...(opts && opts.namedCache ? { namedCache: opts.namedCache } : {}),
	});
};

/**
 * Declare one workspace-relative source file as a graph input.
 * @category graph
 * @param {string} path
 * @returns {object} A semantic source handle.
 */
export function file(path) {
	if (typeof path !== "string" || path.length === 0)
		throw _graphError("file(path) requires a non-empty path");
	const fingerprint = `file:${path}`;
	return _graphMemoizedHandle(fingerprint, () => {
		// Capture the file into CAS now, at graph-construction time, so the
		// graph that reaches the scheduler is static: the digest is computed
		// once here, not re-derived by a lazy handle resolution (or a path
		// read back inside the sandbox preamble) on every execution. A file()
		// is only ever a workspace file that exists before the build; anything
		// an action produces must flow through output() and the action's own
		// outputs, never file(). The evaluated fileset carries its memoized
		// digest, so _materialise_inputs re-uses it instead of capturing again.
		const fileset = file_set.literal([path]);
		_eval_fileset(fileset);
		return _graphHandle("file", { path, fileset }, fingerprint);
	});
}

/**
 * Declare a source set using the same root/include/exclude shape as glob().
 * @category graph
 * @param {object} [opts]
 * @returns {object} A semantic source-set handle.
 */
export function files(opts = {}) {
	// Checked here rather than left to glob(): a handle is built now and
	// resolved much later, so an options object glob() would reject produces a
	// handle that throws only if something ever resolves it. A handle nothing
	// reaches — an unused declaration, or a dep of a shape a rule ignores —
	// then stays broken and silent. The positional form `files(["*.odin"])` is
	// the common way in: the array carries no `include`, so it builds a source
	// set that matches nothing.
	if (!opts || typeof opts !== "object" || !Array.isArray(opts.include)) {
		throw _graphError(
			"files({ root?, include, exclude? }) requires include glob patterns" +
				(Array.isArray(opts)
					? " — files() takes an options object, not a list of patterns"
					: ""),
		);
	}
	const spec = _graphJson(opts, "files(options)");
	const fingerprint = `files:${_graphCanonical(spec)}`;
	return _graphMemoizedHandle(fingerprint, () => _graphHandle("files", spec, fingerprint));
}

/**
 * Declare source files from the installed rules bundle.
 *
 * Unlike files(), builtinFiles() is rooted at the rules directory selected by
 * the host and is intended for builtin rule packages that need to provide
 * source inputs to graph actions.
 */
export function builtinFiles(opts = {}) {
	if (!opts || typeof opts !== "object" || !Array.isArray(opts.include)) {
		throw _graphError("builtinFiles({ root?, include, exclude? }) requires include patterns");
	}
	const spec = _graphJson(opts, "builtinFiles(options)");
	const fingerprint = `builtin-files:${_graphCanonical(spec)}`;
	return _graphMemoizedHandle(fingerprint, () =>
		_graphHandle("builtin-files", spec, fingerprint),
	);
}

// Merge an overlay into a scope. The new values win, and the axes the outer
// scope set and this overlay does not touch stay in force — that is what
// makes the configuration flow along the edge instead of being replaced at
// it.
function _graphScopeWith(cfg, overrides) {
	const overlay = Object.freeze({ ...cfg.overlay, ...overrides });
	return Object.freeze({ overlay, key: _graphScopeKey(overlay) });
}

/**
 * Build a handle under a changed configuration.
 *
 * The returned handle stands for the same work as `handle`, done with the
 * named mode axes set to the given values. The change applies to the whole
 * subtree below the handle, and only to it: the same handle used without
 * `configured()` elsewhere in the graph keeps the configuration of the
 * invocation.
 *
 *     task({ inputs: {
 *         debug: hello[BUILD],
 *         release: configured(hello[BUILD], { opt: "release" }),
 *     }, ... })
 *
 * Nested calls collapse into one node at construction, with the outer values
 * winning, thus the order the wrappers are applied in cannot matter. Only a
 * node whose inputs actually read one of the named axes is built a second
 * time; everything else below the handle stays shared with the rest of the
 * graph.
 *
 * @category graph
 * @param {object} handle A graph handle.
 * @param {Record<string, string>} overrides Declared `axis: value` pairs.
 * @returns {object} A handle for the same work under that configuration.
 */
export function configured(handle, overrides) {
	const record = _graphRecord(handle, "configured(handle, overrides)");
	if (
		overrides === null ||
		typeof overrides !== "object" ||
		Array.isArray(overrides)
	)
		throw _graphError("configured(handle, overrides) requires an overrides object");
	const requested = {};
	for (const name of Object.keys(overrides).sort()) {
		const value = overrides[name];
		if (typeof value !== "string" || value.length === 0)
			throw _graphError(`configured() override '${name}' must be a non-empty string`);
		requested[name] = value;
	}
	if (Object.keys(requested).length === 0)
		throw _graphError("configured(handle, overrides) requires at least one axis");
	const classified = JSON.parse(__host_validate_mode_overrides(JSON.stringify(requested)));
	const selected = Object.keys(classified.outputSelect || {});
	if (selected.length > 0) {
		throw _graphError(
			`configured() cannot set output-select axes (${selected.sort().join(", ")}); ` +
				"only rebuild axes make a differently configured node",
		);
	}

	// Collapse a wrapper around a wrapper into one node. Two nodes would
	// resolve to the same value, and one node keeps `configured()` order-
	// independent the same way profile()'s own reduce does.
	const inner = record.kind === "configured" ? record.data.handle : handle;
	const innerRecord = record.kind === "configured" ? _graphHandles.get(inner.__graph_id) : record;
	const merged = {};
	for (const name of Object.keys({
		...(record.kind === "configured" ? record.data.overrides : {}),
		...classified.rebuild,
	}).sort()) {
		merged[name] =
			classified.rebuild[name] ??
			(record.kind === "configured" ? record.data.overrides[name] : undefined);
	}
	const frozen = Object.freeze(merged);
	const fingerprint = `configured:${innerRecord.fingerprint}:${_graphCanonical(frozen)}`;
	return _graphMemoizedHandle(fingerprint, () => {
		const wrapper = _graphHandle(
			"configured",
			{ handle: inner, overrides: frozen },
			fingerprint,
		);
		// Forward the named outputs of a task handle, each wrapped with the
		// same overrides. Without this an author has to wrap every slot by
		// hand, and two hand-wrapped slots of one task would not obviously
		// be the same task.
		const innerOutputs = inner.outputs;
		if (innerOutputs === undefined) return wrapper;
		const outputs = {};
		for (const name of Object.keys(innerOutputs).sort()) {
			outputs[name] = configured(innerOutputs[name], frozen);
		}
		return Object.freeze({ ...wrapper, outputs: Object.freeze(outputs) });
	});
}

/**
 * Interpret an artifact handle as an executable tool.
 *
 * `mount: { name, cache, key }` makes a named-cache-backed directory artifact
 * available as one atomic sandbox tool mount. `exec.tool()` mounts it for
 * the action automatically; it can also be listed in `exec.action({ tools })`.
 * tools without it retain the historical artifact-input behavior.
 * @category graph
 * @param {object} artifactHandle
 * @param {object} [opts]
 * @returns {object} A tool handle accepted by exec.tool().
 */
export function tool(artifactHandle, opts = {}) {
	const artifactRecord = _graphRecord(artifactHandle, "tool(artifact, options)");
	const options = _graphJson(opts, "tool(options)");
	const fingerprint = `tool:${artifactRecord.fingerprint}:${_graphCanonical(options)}`;
	return _graphMemoizedHandle(fingerprint, () =>
		_graphHandle("tool", { artifact: artifactHandle, options }, fingerprint),
	);
}

function _nativeGraphTool(name, self = false) {
	if (!self && (typeof name !== "string" || name.length === 0))
		throw _graphError("native tool name must be a non-empty string");
	const fingerprint = `native-tool:${self ? "self" : name}`;
	return _graphMemoizedHandle(fingerprint, () =>
		_graphHandle(
			"native-tool",
			Object.freeze({ name: self ? "imp" : name, self }),
			fingerprint,
			self ? {} : { __imp_native_tool: "native-tool", name },
		),
	);
}

// rules/imp owns the public policy API. These private constructors let that
// module create native graph handles without exposing a second public core API.
globalThis.__imp_graph_native_tool = (name) => _nativeGraphTool(name, false);
globalThis.__imp_graph_self_tool = () => _nativeGraphTool("imp", true);

function _semanticHandle(kind, name = null, path = null) {
	const fingerprint = `semantic:${kind}:${name ?? ""}:${path ?? ""}`;
	return _graphMemoizedHandle(fingerprint, () =>
		_graphHandle("semantic", Object.freeze({ kind, name, path }), fingerprint),
	);
}

/** Invocation-scoped graph inputs. Only tasks that name one of these handles
 * vary with that part of the CLI or workspace configuration.
 * @category graph
 */
export const semantic = Object.freeze({
	args: () => _semanticHandle("args"),
	flag(name) {
		if (typeof name !== "string" || name.length === 0)
			throw _graphError("semantic.flag(name) requires a name");
		return _semanticHandle("flag", name);
	},
	mode(name) {
		if (typeof name !== "string" || name.length === 0)
			throw _graphError("semantic.mode(name) requires a name");
		return _semanticHandle("mode", name);
	},
	config(namespace, path = null) {
		if (typeof namespace !== "string" || namespace.length === 0)
			throw _graphError("semantic.config(namespace, path?) requires a namespace");
		if (path !== null && typeof path !== "string")
			throw _graphError("semantic.config(..., path) expects a string path");
		return _semanticHandle("config", namespace, path);
	},
});

// Declared-name identity, same "name@module" shape memo()/product()/expand()
// use (fixes the same comment/line-churn fragility), but deliberately NOT
// routed through imp_core.js's collision-checking registry: task()'s own key
// (_graphTaskKey, below) already folds in inputs/outputs/display/cache, and
// its doc comment spells out the intended pattern — one shared helper calling
// task() repeatedly with a fresh, identically-named `run` per instance (e.g.
// method-shorthand `async run(exec, input) {...}`), told apart by `display`,
// not by function identity. Policing name collisions here the way memo()
// does would make that documented, tested pattern a hard error. `id` stays
// available as an explicit opt-in for callers who want one, e.g. to force
// two structurally-identical closures to intentionally share a node.
function _graphFunctionIdentity(fn, label, id) {
	const stack = new Error(`${label} registration`).stack || "";
	const site = __host_call_site_identity(stack);
	const name = id || fn.name || "<anonymous>";
	const module = site ? site.replace(/:\d+:\d+$/, "") : `${label}:${name}`;
	return `${name}@${module}`;
}

function _graphTaskKey(fn, inputs, outputs, cache, display, id) {
	const fnId = _graphFunctionIdentity(fn, "task", id);
	let moduleDigest = null;
	const at = fnId.indexOf("@");
	if (at >= 0) {
		try {
			moduleDigest = __host_module_digest(fnId.slice(at + 1));
		} catch (_) {}
	}
	return JSON.stringify({
		fnId,
		moduleDigest,
		display,
		inputs: Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.fingerprint])),
		outputs,
		cache,
	});
}

/**
 * Add an immutable task node to the graph and return its completion handle.
 * Named output handles are available under the returned handle's `outputs`.
 *
 * `display` is part of the node's identity, not only its label. A shared
 * helper that builds several different actions from one `task()` call site —
 * telling them apart with a closure-captured flag — has the same `run`
 * identity and frequently the same inputs for every variant, so `display` is
 * the only thing left that can separate them. Two tasks that do different
 * work must therefore have different displays, and a display must be
 * deterministic across runs: a display that varies run to run splits one node
 * into many. This costs nothing on disk — the persistent task cache keys off
 * the action and its inputs (see `task_key` in imp-execution's exec.rs), not
 * off this key, which governs in-process graph dedup only.
 *
 * @category graph
 * @param {object} opts
 * @param {Record<string, *>} [opts.inputs]
 * @param {Record<string, *>} [opts.outputs]
 * @param {function(object, object): Promise<object>} opts.run
 * @param {string} [opts.display]
 * @param {boolean} [opts.cache]
 * @param {string} [opts.id] Overrides the default name-derived identity for
 *   `opts.run`; required when `opts.run` is anonymous, or when a shared
 *   helper calls `task()` with a fresh closure per instance and each
 *   instance needs its own stable identity.
 * @returns {object} A task handle with named output handles.
 */
export function task(opts) {
	if (!opts || typeof opts !== "object" || typeof opts.run !== "function") {
		throw _graphError("task(options) requires a run(exec, inputs) callback");
	}
	if (_graphPhase === "execution")
		throw _graphError("task() cannot add graph nodes during task execution");
	const inputs = _graphInputs(opts.inputs, "task");
	const outputs = _graphOutputSlots(opts.outputs, "task");
	const cache = opts.cache !== false;
	// Only an authored display goes in the key. The `task ${id}` fallback below
	// is unique per node, so keying on it would give every unnamed task a
	// distinct key and defeat dedup entirely.
	const authoredDisplay = opts.display || opts.run.name || null;
	let key = _graphTaskKey(opts.run, inputs, outputs, cache, authoredDisplay, opts.id);
	if (!cache) key += `:instance:${_graphNextTask}`;
	if (cache && _graphTasksByKey.has(key)) return _graphTasksByKey.get(key).publicHandle;

	const id = _graphNextTask++;
	const completion = _graphHandle("task", { taskId: id }, `task:${key}`);
	const outputHandles = {};
	for (const [name, kind] of Object.entries(outputs)) {
		outputHandles[name] = _graphHandle(
			"task-output",
			{ taskId: id, name, outputKind: kind },
			`task-output:${key}:${name}:${kind}`,
		);
	}
	const publicHandle = Object.freeze({ ...completion, outputs: Object.freeze(outputHandles) });
	const record = {
		id,
		key,
		display: authoredDisplay || `task ${id}`,
		inputs,
		outputs,
		cache,
		run: opts.run,
		publicHandle,
		packagePath: _graphCapturePackagePath(),
	};
	_graphTasks.set(id, record);
	if (cache) _graphTasksByKey.set(key, record);
	return publicHandle;
}

function _graphBinding(type, fields) {
	return Object.freeze({ __imp_graph_binding: true, type, ...fields });
}

function _graphLookup(value, path) {
	if (path === null || path === "") return value;
	let current = value;
	for (const component of path.split(".")) {
		if (current === null || typeof current !== "object" || !(component in current))
			throw _graphError(`configuration path '${path}' does not exist`);
		current = current[component];
	}
	return current;
}

async function _graphResolveHandle(id, cfg, stack = []) {
	const key = _graphHandleMemoKey(id, cfg);
	if (_graphValueMemo.has(key)) return _graphValueMemo.get(key);
	const promise = _graphResolveHandleUncached(id, cfg, stack);
	_graphValueMemo.set(key, promise);
	return promise;
}

async function _graphResolveHandleUncached(id, cfg, stack = []) {
	const record = _graphHandles.get(id);
	if (record === undefined) throw _graphError(`unknown handle id ${id}`);
	// The stack holds scoped keys, not bare ids: one handle under two
	// configurations is two nodes, and only a repeat of the same node is a
	// cycle.
	const stackKey = _graphHandleMemoKey(id, cfg);
	if (stack.includes(stackKey)) throw _graphError(`dependency cycle through handle ${id}`);
	const nextStack = [...stack, stackKey];
	switch (record.kind) {
		case "file":
			// The digest was captured at construction (see file()); resolution
			// only wraps the pre-evaluated fileset. `_eval_fileset` in
			// _materialise_inputs is then a memo hit on `fileset.__digest` — no
			// second capture, and staging never sees a raw path.
			return _graphBinding("source", {
				fingerprint: record.fingerprint,
				path: record.data.path,
				fileset: record.data.fileset,
				inputs: [record.data.fileset],
			});
		case "files": {
			const fileset = glob(record.data);
			return _graphBinding("source-set", {
				fingerprint: record.fingerprint,
				path: record.data.root || ".",
				fileset,
				inputs: [fileset],
			});
		}
		case "builtin-files": {
			const fileset = builtinGlob(record.data);
			return _graphBinding("source-set", {
				fingerprint: record.fingerprint,
				path: record.data.root || ".",
				fileset,
				inputs: [fileset],
			});
		}
		case "semantic": {
			if (_graphInvocation === null)
				throw _graphError("semantic input resolved outside a workflow invocation");
			const { kind, name, path } = record.data;
			if (kind === "args") return Object.freeze([...(_graphInvocation.args || [])]);
			if (kind === "flag") return _graphInvocation.flags?.[name] === true;
			// The scope overlay wins over the bundle of the invocation. This
			// is the one place a configuration is read, thus the one place an
			// edge that changed the configuration can be seen.
			if (kind === "mode")
				return Object.hasOwn(cfg.overlay, name)
					? cfg.overlay[name]
					: (_graphInvocation.mode?.[name] ?? null);
			if (kind === "config") {
				const value = _graphInvocation.config?.[name] ?? null;
				return _graphLookup(
					name === _GRAPH_MODE_NAMESPACE && cfg.key !== ""
						? Object.freeze({ ...(value || {}), ...cfg.overlay })
						: value,
					path,
				);
			}
			throw _graphError(`unknown semantic input kind '${kind}'`);
		}
		case "native-tool": {
			const descriptor = JSON.parse(
				__host_graph_tool_descriptor(record.data.name, record.data.self),
			);
			return _graphBinding("tool", {
				fingerprint: `native-tool:${descriptor.name}:${descriptor.key}`,
				native: true,
				name: descriptor.name,
				cache: descriptor.cache,
				key: descriptor.key,
				path: descriptor.path,
				binDirs: descriptor.binDirs,
				options: Object.freeze({ binDirs: descriptor.binDirs }),
				inputs: Object.freeze([]),
			});
		}
		case "tool": {
			const artifact = await _graphResolveHandle(record.data.artifact.__graph_id, cfg, nextStack);
			const mount = record.data.options.mount;
			if (mount !== undefined) {
				if (
					!mount ||
					typeof mount !== "object" ||
					typeof mount.name !== "string" ||
					!/^[A-Za-z0-9_.+-]+$/.test(mount.name) ||
					typeof mount.cache !== "string" ||
					mount.cache.length === 0 ||
					typeof mount.key !== "string" ||
					mount.key.length === 0
				)
					throw _graphError(
						"tool(..., { mount }) requires non-empty name, cache, and key strings",
					);
				if (artifact.kind !== "directory")
					throw _graphError(
						"tool(..., { mount }) requires a directory artifact",
					);
				if (
					artifact.namedCache &&
					(artifact.namedCache.name !== mount.cache ||
						artifact.namedCache.key !== mount.key)
				)
					throw _graphError(
						"tool(..., { mount }) does not match the artifact's named-cache binding",
					);
			}
			return _graphBinding("tool", {
				fingerprint: record.fingerprint,
				artifact,
				options: record.data.options,
				path: artifact.path,
				inputs: artifact.inputs,
				...(mount === undefined
					? {}
					: {
							mountName: mount.name,
							name: mount.name,
							cache: mount.cache,
							key: mount.key,
							binDirs: record.data.options.binDirs || ["bin"],
						}),
			});
		}
		case "task":
			await _graphExecuteTask(record.data.taskId, cfg, nextStack);
			return undefined;
		case "task-output": {
			const result = await _graphExecuteTask(record.data.taskId, cfg, nextStack);
			return result[record.data.name];
		}
		case "configured":
			// The one place the configuration changes: resolve the inner
			// handle under the merged scope. Everything below sees the new
			// values through the normal `cfg` parameter.
			return _graphResolveHandle(
				record.data.handle.__graph_id,
				_graphScopeWith(cfg, record.data.overrides),
				nextStack,
			);
		case "expansion-get":
		case "expansion-all":
			return _graphResolveExpansionProjection(record, cfg, nextStack);
		default:
			throw _graphError(`unsupported handle kind '${record.kind}'`);
	}
}

// Resolve independent graph edges together. Return results in the order the
// caller declares. The outcome wrapper observes later failures and prevents
// an unhandled rejection. The result order keeps the failure precedence of
// the old sequential loops.
async function _graphResolveOrderedConcurrent(values, resolve) {
	const pending = values.map((value) =>
		Promise.resolve()
			.then(() => resolve(value))
			.then(
				(result) => ({ ok: true, result }),
				(error) => ({ ok: false, error }),
			),
	);
	const results = [];
	for (const promise of pending) {
		const outcome = await promise;
		if (!outcome.ok) throw outcome.error;
		results.push(outcome.result);
	}
	return results;
}

function _graphCollectActionInput(value, result) {
	if (value === null || value === undefined) return;
	if (Array.isArray(value)) {
		for (const item of value) _graphCollectActionInput(item, result);
		return;
	}
	if (!value.__imp_graph_binding) return;
	for (const input of value.inputs || []) result.push(input);
}

// Cached: __host_platform_info() is a host round-trip, and this is called
// once per exec.tool() invocation.
let _graphIsWindowsCache;
function _graphIsWindows() {
	if (_graphIsWindowsCache === undefined) {
		_graphIsWindowsCache = JSON.parse(__host_platform_info()).os === "windows";
	}
	return _graphIsWindowsCache;
}

function _graphExec(record, cfg) {
	let consumed = new Set();
	const configDigest = _graphActionConfigDigest(record, cfg);
	const consume = (binding) => {
		if (!binding || binding.__imp_graph_binding !== true)
			throw _graphError("exec path/tool helpers expect a resolved task input");
		consumed.add(binding);
		return binding;
	};
	return Object.freeze({
		// Resolve a handle the task body holds but did not declare as an
		// input, under the configuration this task is running with. The free
		// `resolveGraphHandle()` cannot do that — it has no scope, thus it
		// always resolves at the configuration of the invocation.
		resolve(handle) {
			const handleRecord = _graphRecord(handle, "exec.resolve(handle)");
			return handleRecord.kind === "task"
				? _graphExecuteTask(handleRecord.data.taskId, cfg, [])
				: _graphResolveHandle(handle.__graph_id, cfg);
		},
		path(binding) {
			return consume(binding).path;
		},
		paths(binding) {
			consume(binding);
			return binding.fileset ? paths(binding.fileset) : [binding.path];
		},
		tool(binding, executable) {
			consume(binding);
			if (binding.type !== "tool") throw _graphError("exec.tool() expects a tool input");
			if (binding.native) return executable;
			const binDirs = binding.options.binDirs || ["bin"];
			if (binding.mountName !== undefined) {
				const exe = _graphIsWindows() ? `${executable}.exe` : executable;
				const prefix = binDirs.length === 0
					? `.imp/tools/${binding.mountName}`
					: `.imp/tools/${binding.mountName}/${binDirs[0]}`;
				return `${prefix}/${exe}`;
			}
			const prefix = binDirs.length === 0 ? binding.path : `${binding.path}/${binDirs[0]}`;
			// Produced/toolchain binaries are referenced by bare name (e.g.
			// "cargo"); native tools (the `binding.native` branch above) don't
			// need this, since their path was already resolved off the host PATH
			// by nativeToolArtifact(), which finds the real, extensioned file.
			// This one builds the path from scratch by string concatenation, so
			// it must add the extension itself.
			const exe = _graphIsWindows() ? `${executable}.exe` : executable;
			return `${prefix}/${exe}`;
		},
		/**
		 * Run one sandboxed command as part of this task.
		 *
		 * `cores` declares how much of the `--jobs` budget the command costs
		 * while it runs. The default, 1, suits a command that keeps one core
		 * busy. A command that parallelises itself across several cores (a
		 * compiler with its own job server) must say so, or the scheduler
		 * admits a full lane's worth of them and each one fans out to the whole
		 * machine. The count is clamped to the total budget, so an action that
		 * asks for more cores than `--jobs` runs alone instead of deadlocking.
		 *
		 * The granted count reaches the command as `IMP_CORES`, so read it back
		 * rather than repeating the literal — argv is not shell-expanded, so
		 * this needs a shell to see it:
		 * `exec.action({ argv: ["sh", "-c", 'make -j "$IMP_CORES"'], cores: 4 })`.
		 * An `env` value can use it without a shell: `$IMP_CORES` (or
		 * `${IMP_CORES}`) there is expanded by the executor, e.g.
		 * `env: ["CARGO_BUILD_JOBS=$IMP_CORES"]`. Neither `cores` nor that
		 * expansion is part of the action's cache key — the digest keeps the
		 * literal `$IMP_CORES` — so the same action stays cache-compatible
		 * across machines with different budgets.
		 *
		 * @param {object} opts
		 * @param {string[]} opts.argv
		 * @param {number} [opts.cores] Cores this command uses. Default 1.
		 */
		async action(opts) {
			if (!opts || typeof opts !== "object" || !Array.isArray(opts.argv))
				throw _graphError("exec.action({ argv, ... }) requires an argv array");
			if (opts.cores !== undefined && !(Number.isInteger(opts.cores) && opts.cores >= 1))
				throw _graphError("exec.action({ cores }) must be an integer of 1 or more");
			const actionInputs = [];
			const actionTools = [];
			const mountedTools = new Set();
			const isLegacyToolSpec = (value) =>
				value !== null &&
				typeof value === "object" &&
				value.__imp_graph_binding !== true &&
				typeof value.name === "string" &&
				Array.isArray(value.binDirs);
			const addTool = (binding) => {
				if (isLegacyToolSpec(binding)) {
					// Cross-ruleset roles still dispatched through the legacy
					// productFor() protocol (e.g. rules/rust's linker/build-cache
					// bridging) resolve to an already-resolved legacy tool-spec
					// object, not a graph binding — nothing to consume() or track
					// as a graph input, same as it is for a legacy run() caller.
					actionTools.push({
						name: binding.name,
						cache: binding.cache,
						key: binding.key,
						path: binding.path,
						binDirs: binding.binDirs,
					});
					return;
				}
				if (!binding || binding.__imp_graph_binding !== true || binding.type !== "tool")
					throw _graphError("exec.action().tools expects resolved graph tool inputs");
				if (!binding.native && binding.mountName === undefined)
					throw _graphError(
						"exec.action().tools accepts native tools or graph tools declared with tool(..., { mount })",
					);
				if (!binding.native) mountedTools.add(binding);
				else consume(binding);
				actionTools.push({
					name: binding.name,
					cache: binding.cache,
					key: binding.key,
					...(binding.native ? { path: binding.path } : {}),
					binDirs: binding.binDirs,
				});
			};
			for (const binding of opts.tools || []) addTool(binding);
			for (const binding of consumed) {
				if (binding.mountName !== undefined) {
					if (!mountedTools.has(binding)) addTool(binding);
					continue;
				}
				_graphCollectActionInput(binding, actionInputs);
			}
			for (const binding of consumed) {
				if (binding.native) addTool(binding);
			}
			consumed = new Set();
			_graphCollectActionInput(opts.inputs, actionInputs);
			const mountSources = new Map();
			for (const tool of actionTools) {
				const source = `${tool.cache}:${tool.key}`;
				const existing = mountSources.get(tool.name);
				if (existing !== undefined && existing !== source)
					throw _graphError(
						`exec.action() mounts '${tool.name}' from more than one cache entry`,
					);
				mountSources.set(tool.name, source);
			}
			const uniqueTools = Array.from(
				new Map(actionTools.map((entry) => [`${entry.name}:${entry.key}`, entry])).values(),
			);
			const outputSpecs = [];
			const outputNames = {};
			for (const name of Object.keys(opts.outputs || {}).sort()) {
				if (!/^[A-Za-z0-9_.-]+$/.test(name))
					throw _graphError(`exec.action().outputs has invalid name '${name}'`);
				const spec = opts.outputs[name];
				if (!spec || spec.__imp_graph_action_output !== true)
					throw _graphError(`exec.action().outputs.${name} must be output.file() or output.directory()`);
				if (Object.values(outputNames).includes(spec.path))
					throw _graphError(`exec.action() declares output path '${spec.path}' twice`);
				outputNames[name] = spec.path;
				outputSpecs.push({
					kind: spec.kind,
					path: spec.path,
					...(spec.namedCache ? { namedCache: spec.namedCache } : {}),
				});
			}
			// A non-zero exit is the program's own verdict on the user's code,
			// and the host already put the program's report in the message.
			// Mark it so the CLI shows that report alone, with no JS frames.
			const result = await _graphMarkActionFailure(run({
				// exec.action() is only ever reachable from inside a task's own
				// run() (the only place given an `exec`) — expand()'s create()
				// callback is never handed one (see _graphExecuteExpansion below)
				// — so this call can never actually originate from inside an
				// expansion's construction. Bypassing run()'s expansion-phase
				// guard here isn't just an optimization: leaving it in place is
				// actively wrong, since _graphPhase is one shared global and an
				// unrelated expansion running concurrently elsewhere in the graph
				// (e.g. while most of the graph is cache-hit and everything
				// resolves in a tight interleave) can transiently read back as
				// "expansion" here and fail an otherwise-legitimate task action.
				__graphTaskAction: true,
				argv: opts.argv,
				display: opts.display || record.display,
				env: opts.env,
				inputs: actionInputs,
				outputs: outputSpecs,
				tools: uniqueTools,
				cores: opts.cores,
				allowFailure: opts.allowFailure,
				impure: opts.cache === false || !record.cache,
				forceCache: opts.forceCache,
				materialize: false,
				__graphConfigDigest: configDigest,
				__graphOutputNames: outputNames,
			}));
			const normalizedOutputs = Object.fromEntries(
				Object.entries(result.graphOutputs || {}).map(([name, artifact]) => [
					name,
					Object.freeze({
						...artifact,
						inputs: Object.freeze([...(artifact.inputs || [])]),
					}),
				]),
			);
			return Object.freeze({
				stdout: result.stdout,
				stderr: result.stderr,
				exitCode: result.exitCode,
				outputs: Object.freeze(normalizedOutputs),
			});
		},
	});
}

function _graphValidateTaskResult(record, value) {
	const names = Object.keys(record.outputs);
	if (names.length === 0) {
		if (value !== undefined)
			throw _graphError(`task '${record.display}' declares no outputs and must return undefined`);
		return Object.freeze({});
	}
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw _graphError(`task '${record.display}' must return its named output object`);
	const actual = Object.keys(value).sort();
	if (JSON.stringify(actual) !== JSON.stringify(names))
		throw _graphError(`task '${record.display}' returned [${actual.join(", ")}], expected [${names.join(", ")}]`);
	const result = {};
	for (const name of names) {
		if (record.outputs[name] === "artifact") {
			if (!value[name] || value[name].__imp_graph_artifact !== true)
				throw _graphError(`task '${record.display}' output '${name}' must be an action artifact`);
			result[name] = value[name];
		} else {
			result[name] = _graphJson(value[name], `task '${record.display}' output '${name}'`);
		}
	}
	return Object.freeze(result);
}

// One node, one execution.
//
// The memo holds the identity of the task itself, not a key built from its
// resolved inputs. A handle gives one value for a run (see
// `_graphValueMemo`), thus the inputs of a task cannot differ between two
// calls inside one run, and the identity of the node says everything the
// old runtime key said.
//
// The memo is filled before the first await. A second caller therefore
// always finds the promise of the first, which makes single-flight a
// property of the graph rather than something a key has to reconstruct.
function _graphExecuteTask(taskId, cfg, stack) {
	const key = _graphTaskMemoKey(taskId, cfg);
	const existing = _graphTaskMemo.get(key);
	if (existing !== undefined) return existing;
	const promise = _graphExecuteTaskBody(taskId, cfg, stack);
	_graphTaskMemo.set(key, promise);
	return promise;
}

async function _graphExecuteTaskBody(taskId, cfg, stack) {
	const record = _graphTasks.get(taskId);
	if (record === undefined) throw _graphError(`unknown task ${taskId}`);
	const resolved = Object.fromEntries(
		await _graphResolveOrderedConcurrent(
			Object.entries(record.inputs),
			async ([name, input]) => [
				name,
				input.kind === "literal"
					? input.value
					: await _graphResolveHandle(input.handle.__graph_id, cfg, stack),
			],
		),
	);
	const previous = _graphPhase;
	const previousPackagePath = _graphAmbientPackagePath;
	_graphPhase = "execution";
	_graphAmbientPackagePath = record.packagePath;
	try {
		const value = await record.run(_graphExec(record, cfg), Object.freeze(resolved));
		return _graphValidateTaskResult(record, value);
	} catch (error) {
		throw _graphTaskFailure(
			`task '${record.display}' failed: ${error?.message || error}`,
			error,
		);
	} finally {
		_graphPhase = previous;
		_graphAmbientPackagePath = previousPackagePath;
	}
}

function _graphWorkflowName(workflow, api) {
	if (typeof workflow !== "symbol" || !_workflow_name_by_symbol.has(workflow))
		throw _graphError(`${api} expects a workflow symbol such as BUILD or TEST`);
	return _workflow_name_by_symbol.get(workflow);
}

function _graphChildHandle(value, workflow, facet, api) {
	if (value === null || typeof value !== "object")
		throw _graphError(`${api} child must contain workflow handles`);
	const workflowValue = value[workflow];
	if (workflowValue === undefined) throw _graphError(`${api} child has no requested workflow`);
	const selected = facet === null ? workflowValue : workflowValue?.[facet];
	if (selected === undefined) throw _graphError(`${api} child has no facet '${facet}'`);
	_graphRecord(selected, api);
	return selected;
}

function _graphExpand(opts) {
	if (!opts || typeof opts !== "object" || typeof opts.create !== "function")
		throw _graphError("expand({ inputs, create }) requires a create callback");
	const inputs = _graphInputs(opts.inputs, "expand");
	const id = _graphNextExpansion++;
	// `display` participates in the key for the same reason it does in task()
	// — see the note there. The `expansion ${id}` fallback stays out of it.
	const authoredDisplay = opts.display || opts.create.name || null;
	const key = JSON.stringify({
		fnId: _graphFunctionIdentity(opts.create, "expand", opts.id),
		display: authoredDisplay,
		inputs: Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.fingerprint])),
	});
	_graphExpansions.set(id, {
		id,
		key,
		display: authoredDisplay || `expansion ${id}`,
		inputs,
		create: opts.create,
		packagePath: _graphCapturePackagePath(),
	});
	return Object.freeze({
		__imp_graph_expansion: true,
		get(childKey, workflow, facet = null) {
			if (typeof childKey !== "string" || childKey.length === 0)
				throw _graphError("expansion.get(key, workflow) requires a child key");
			const workflowName = _graphWorkflowName(workflow, "expansion.get()");
			return _graphHandle(
				"expansion-get",
				{ expansionId: id, childKey, workflow, facet },
				`expansion-get:${key}:${childKey}:${workflowName}:${facet || ""}`,
			);
		},
		all(workflow, facet = null) {
			const workflowName = _graphWorkflowName(workflow, "expansion.all()");
			return _graphHandle(
				"expansion-all",
				{ expansionId: id, workflow, facet },
				`expansion-all:${key}:${workflowName}:${facet || ""}`,
			);
		},
	});
}
globalThis.__imp_graph_expand = _graphExpand;

// One expansion, one create(). Keyed by identity for the same reason
// `_graphExecuteTask` above is.
function _graphExecuteExpansion(expansionId, cfg, stack) {
	const key = _graphExpansionMemoKey(expansionId, cfg);
	const existing = _graphExpansionMemo.get(key);
	if (existing !== undefined) return existing;
	const promise = _graphExecuteExpansionBody(expansionId, cfg, stack);
	_graphExpansionMemo.set(key, promise);
	return promise;
}

async function _graphExecuteExpansionBody(expansionId, cfg, stack) {
	const record = _graphExpansions.get(expansionId);
	if (record === undefined) throw _graphError(`unknown expansion ${expansionId}`);
	const resolved = {};
	for (const [name, input] of Object.entries(record.inputs)) {
		resolved[name] =
			input.kind === "literal"
				? input.value
				: await _graphResolveHandle(input.handle.__graph_id, cfg, stack);
	}
	return await (async () => {
		// _graphPhase="expansion" is only held for create()'s own synchronous
		// prologue, not its whole (possibly async) lifetime — same contract
		// _graphAmbientPackagePath already documents above (only meaningful
		// until the callback's first await). Holding it across an await would
		// leave it readable by whatever unrelated task/expansion happens to
		// interleave on the microtask queue in the meantime, which is exactly
		// how this guard used to produce false positives against completely
		// unrelated concurrent task execution.
		const previous = _graphPhase;
		const previousPackagePath = _graphAmbientPackagePath;
		_graphPhase = "expansion";
		_graphAmbientPackagePath = record.packagePath;
		let pending;
		try {
			pending = record.create(Object.freeze(resolved));
		} finally {
			_graphPhase = previous;
			_graphAmbientPackagePath = previousPackagePath;
		}
		const children = await pending;
		if (children === null || typeof children !== "object" || Array.isArray(children))
			throw _graphError(`expansion '${record.display}' must return a keyed object`);
		return children;
	})();
}

async function _graphResolveExpansionProjection(record, cfg, stack) {
	const { expansionId, workflow, facet } = record.data;
	const children = await _graphExecuteExpansion(expansionId, cfg, stack);
	if (record.kind === "expansion-get") {
		const child = children[record.data.childKey];
		if (child === undefined) throw _graphError(`expansion has no child '${record.data.childKey}'`);
		const handle = _graphChildHandle(child, workflow, facet, `expansion.get('${record.data.childKey}')`);
		return _graphResolveHandle(handle.__graph_id, cfg, stack);
	}
	return Object.freeze(
		Object.fromEntries(
			await _graphResolveOrderedConcurrent(
				Object.keys(children).sort(),
				async (key) => {
					const handle = _graphChildHandle(
						children[key],
						workflow,
						facet,
						`expansion.all() child '${key}'`,
					);
					return [key, await _graphResolveHandle(handle.__graph_id, cfg, stack)];
				},
			),
		),
	);
}

// Declared, structural input edges for a handle — no execution. Used by the
// introspection walk below to show what a node depends on without running
// its (or its dependencies') task actions. Only kinds that actually wrap
// another handle contribute edges; leaf kinds (file, files, semantic,
// native-tool) have none.
function _graphDeclaredEdges(record) {
	switch (record.kind) {
		case "task": {
			const taskRecord = _graphTasks.get(record.data.taskId);
			if (taskRecord === undefined) return [];
			return Object.entries(taskRecord.inputs)
				.filter(([, input]) => input.kind === "handle")
				.map(([name, input]) => ({ name, handleId: input.handle.__graph_id }));
		}
		case "task-output": {
			const taskRecord = _graphTasks.get(record.data.taskId);
			if (taskRecord === undefined) return [];
			return [{ name: "task", handleId: taskRecord.publicHandle.__graph_id }];
		}
		case "tool":
			return [{ name: "artifact", handleId: record.data.artifact.__graph_id }];
		case "configured":
			return [{ name: "configured", handleId: record.data.handle.__graph_id }];
		case "expansion-get":
		case "expansion-all": {
			const expansionRecord = _graphExpansions.get(record.data.expansionId);
			if (expansionRecord === undefined) return [];
			return Object.entries(expansionRecord.inputs)
				.filter(([, input]) => input.kind === "handle")
				.map(([name, input]) => ({ name, handleId: input.handle.__graph_id }));
		}
		default:
			return [];
	}
}

// Put the graph that `rootHandleIds` reach into leaf-first waves.
//
// Every node in wave 0 has no dependency inside the reachable set, thus it
// can run first. Every node in wave N has all of its dependencies in waves
// 0 to N-1. This is what a scheduler needs to run the graph from the leaves
// up, instead of pulling from the roots down and letting the order fall out
// of how promises happen to resolve.
//
// The plan is only correct if the shape of the graph is final. Goal
// execution discovers `expansion.get()` children before dispatch for that
// reason (see `eager_expansion_get` in spike.rs).
//
// `scheduled` below is how many nodes reached a wave. It is less than
// `total` only if a cycle holds the rest back, which the pull-based
// executor would instead meet as a deadlock or a stack overflow.
// Collect the graph that `rootHandleIds` reach, with the dependencies of
// each node and the nodes that wait on it. Shared by the wave planner and
// the ready-queue driver so the two cannot disagree about the graph.
// A node here is a handle under a configuration, not a handle alone: the
// same handle below two `configured()` edges is two nodes, and the same
// handle that reads no axis the two edges change is one shared node. The
// scoped key from `_graphHandleMemoKey` is what decides which of the two it
// is, thus the queue and the memo tables always agree.
function _graphReachable(rootHandleIds, cfg) {
	const deps = new Map();
	const nodes = new Map();
	const queue = rootHandleIds.map((id) => ({ id, cfg }));
	while (queue.length > 0) {
		const { id, cfg: scope } = queue.shift();
		const key = _graphHandleMemoKey(id, scope);
		if (deps.has(key)) continue;
		const record = _graphHandles.get(id);
		if (record === undefined) continue;
		nodes.set(key, { handleId: id, cfg: scope });
		// The edge below a `configured` node carries the changed
		// configuration; every other edge carries the one it was reached
		// with.
		const childScope =
			record.kind === "configured" ? _graphScopeWith(scope, record.data.overrides) : scope;
		const edges = _graphDeclaredEdges(record).map((edge) => ({
			id: edge.handleId,
			cfg: childScope,
		}));
		deps.set(
			key,
			edges.map((edge) => _graphHandleMemoKey(edge.id, edge.cfg)),
		);
		for (const edge of edges) queue.push(edge);
	}

	// Count only the dependencies that are in the reachable set, and record
	// the other direction so a finished node can release what waits on it.
	const waiting = new Map();
	const dependents = new Map();
	for (const [id, edges] of deps) {
		const inside = new Set(edges.filter((edge) => deps.has(edge)));
		waiting.set(id, inside);
		for (const edge of inside) {
			if (!dependents.has(edge)) dependents.set(edge, []);
			dependents.get(edge).push(id);
		}
	}
	return { total: deps.size, waiting, dependents, nodes };
}

function _graphPlanWaves(rootHandleIds) {
	const { total, waiting, dependents } = _graphReachable(rootHandleIds, _GRAPH_ROOT_SCOPE);
	const waves = [];
	let ready = [];
	for (const [id, inside] of waiting) if (inside.size === 0) ready.push(id);
	let scheduled = 0;
	while (ready.length > 0) {
		waves.push(ready);
		scheduled += ready.length;
		const next = [];
		for (const id of ready) {
			for (const dependent of dependents.get(id) || []) {
				const inside = waiting.get(dependent);
				inside.delete(id);
				if (inside.size === 0) next.push(dependent);
			}
		}
		ready = next;
	}
	return { total, scheduled, waves };
}

// Run the reachable graph from the leaves up, with no barrier between
// levels.
//
// A node starts as soon as its own dependencies are done, not when a whole
// level is done. Waves are useful to show that the graph can be ordered,
// but running them one after another makes one slow node hold back every
// node of the next level, including the ones that do not need it. That is
// slower than the pull-based executor, which never waits for a node it does
// not need.
//
// The queue keeps the good property of the waves: every node is started
// here exactly one time, by the node that releases it, thus the graph
// itself decides the order.
async function _graphRunReadyQueue(rootHandleIds, cfg) {
	const buildStartedAt = Date.now();
	const { total, waiting, dependents, nodes } = _graphReachable(rootHandleIds, cfg);
	const buildMs = Date.now() - buildStartedAt;
	const running = [];
	const started = new Set();

	function start(id) {
		if (started.has(id)) return;
		started.add(id);
		const node = nodes.get(id);
		running.push(
			(async () => {
				await _graphResolveNode(node.handleId, node.cfg);
				for (const dependent of dependents.get(id) || []) {
					const inside = waiting.get(dependent);
					inside.delete(id);
					if (inside.size === 0) start(dependent);
				}
			})(),
		);
	}

	for (const [id, inside] of waiting) if (inside.size === 0) start(id);
	// `running` grows while this loop walks it, because a node that finishes
	// starts the nodes that waited on it. Reading by index covers what is
	// added later; the nodes themselves already run together.
	for (let i = 0; i < running.length; i++) await running[i];

	if (started.size !== total) {
		throw _graphError(
			`graph has a cycle: ${total - started.size} of ${total} nodes never became ready`,
		);
	}
	return { total, buildMs };
}

// Resolve one node of a wave. A task node is executed; anything else is
// resolved. This is the same pair of calls the root loop makes, named once
// so the wave driver and the root loop cannot drift apart.
function _graphResolveNode(handleId, cfg) {
	const record = _graphHandles.get(handleId);
	if (record === undefined) throw _graphError(`unknown handle id ${handleId}`);
	return record.kind === "task"
		? _graphExecuteTask(record.data.taskId, cfg, [])
		: _graphResolveHandle(handleId, cfg);
}

globalThis.__imp_graph_plan = function graphPlan(rootHandleIdsJson) {
	const plan = _graphPlanWaves(JSON.parse(rootHandleIdsJson));
	return JSON.stringify({
		total: plan.total,
		scheduled: plan.scheduled,
		waves: plan.waves.map((wave) => wave.length),
	});
};

// The axes a node reads by itself, before its inputs are folded in.
// `semantic.mode(name)` reads one named axis; a `semantic.config()` read of
// the mode namespace sees the whole bundle and therefore reads every axis.
// Every other kind reads none of its own.
function _graphOwnAxes(record) {
	if (record.kind !== "semantic") return null;
	const { kind, name } = record.data;
	if (kind === "mode") return new Set([name]);
	if (kind === "config" && name === _GRAPH_MODE_NAMESPACE) return _GRAPH_AXES_ALL;
	return null;
}

// The child handles an expansion projection resolves to. `_graphDeclaredEdges`
// reports only the inputs of an expansion, not what `create()` discovered, so
// the axis closure has to run the expansion to see the rest of the graph.
// This is the same memoized call dispatch makes, thus it adds no work.
async function _graphExpansionChildIds(record) {
	const { expansionId, workflow, facet } = record.data;
	const children = await _graphExecuteExpansion(expansionId, _GRAPH_ROOT_SCOPE, []);
	if (record.kind === "expansion-get") {
		const child = children[record.data.childKey];
		if (child === undefined) return [];
		return [
			_graphChildHandle(child, workflow, facet, "expansion.get()").__graph_id,
		];
	}
	return Object.keys(children)
		.sort()
		.map(
			(key) =>
				_graphChildHandle(children[key], workflow, facet, "expansion.all()")
					.__graph_id,
		);
}

// Fold the axis closure of one node: what it reads itself, plus what every
// node below it reads. `visiting` guards a declaration cycle — such a node
// contributes nothing here, and the real cycle errors still come from
// `_graphResolveHandleUncached` and `_graphRunReadyQueue`.
async function _graphNodeAxes(id, visiting) {
	const known = _graphAxes.get(id);
	if (known !== undefined) return known;
	if (visiting.has(id)) return new Set();
	visiting.add(id);
	try {
		const record = _graphHandles.get(id);
		if (record === undefined) return new Set();
		const axes = new Set();
		let all = false;
		const own = _graphOwnAxes(record);
		if (own === _GRAPH_AXES_ALL) all = true;
		else if (own !== null) for (const axis of own) axes.add(axis);

		// The declared edges of an expansion projection are the inputs of the
		// expansion, which is all `create()` can read. Fold them first and
		// record that closure by itself, because the expansion body forks on
		// its inputs while the projection node forks on what it discovered
		// below as well.
		const declared = _graphDeclaredEdges(record).map((edge) => edge.handleId);
		const isExpansion = record.kind === "expansion-get" || record.kind === "expansion-all";
		if (isExpansion) {
			const inputAxes = new Set();
			let inputAll = false;
			for (const child of declared) {
				const below = await _graphNodeAxes(child, visiting);
				if (below === _GRAPH_AXES_ALL) inputAll = true;
				else for (const axis of below) inputAxes.add(axis);
			}
			_graphExpansionAxes.set(
				record.data.expansionId,
				inputAll ? _GRAPH_AXES_ALL : inputAxes,
			);
		}

		const children = [...declared];
		if (isExpansion) {
			try {
				children.push(...(await _graphExpansionChildIds(record)));
			} catch (_) {
				// A projection that cannot be read here would fail at dispatch
				// too. Treat the node as reading every axis so the analysis
				// stays conservative instead of reporting a smaller closure.
				all = true;
			}
		}
		for (const child of children) {
			const below = await _graphNodeAxes(child, visiting);
			if (below === _GRAPH_AXES_ALL) all = true;
			else for (const axis of below) axes.add(axis);
		}

		// A `configured` node pins the axes it sets, thus the graph above it
		// no longer varies with them. This is what stops one
		// `configured(x, {opt:"release"})` edge from forking every consumer
		// of that edge as well: the release build below the edge is fixed,
		// so its consumer reads no `opt` at all.
		let result = all ? _GRAPH_AXES_ALL : axes;
		if (record.kind === "configured" && result !== _GRAPH_AXES_ALL) {
			result = new Set(
				[...result].filter((axis) => !Object.hasOwn(record.data.overrides, axis)),
			);
		}
		_graphAxes.set(id, result);
		return result;
	} finally {
		visiting.delete(id);
	}
}

// Fill `_graphAxes` for everything the roots reach, and report what it
// found. Must complete before dispatch: the memo tables are filled before
// the first await to keep single-flight structural, so the key of a node
// has to be available without awaiting.
async function _graphPlanConfigs(rootHandleIds) {
	for (const id of rootHandleIds) await _graphNodeAxes(id, new Set());
	let blind = 0;
	let reading = 0;
	let all = 0;
	const names = new Set();
	for (const axes of _graphAxes.values()) {
		if (axes === _GRAPH_AXES_ALL) all += 1;
		else if (axes.size === 0) blind += 1;
		else {
			reading += 1;
			for (const axis of axes) names.add(axis);
		}
	}
	return { total: _graphAxes.size, blind, reading, all, names: [...names].sort() };
}

// Human label for a node in the introspection walk, reusing whatever
// `display:` the declaring `task()`/`expand()` call already recorded rather
// than inventing a second labelling scheme. Returns undefined for kinds with
// no natural label of their own (file/files/tool already carry enough via
// `node.data`/their own edges).
function _graphNodeDisplay(record) {
	switch (record.kind) {
		case "task": {
			const taskRecord = _graphTasks.get(record.data.taskId);
			return taskRecord?.display;
		}
		case "task-output": {
			const taskRecord = _graphTasks.get(record.data.taskId);
			return taskRecord ? `${taskRecord.display} · ${record.data.name}` : record.data.name;
		}
		case "expansion-all":
		case "expansion-get": {
			const expansionRecord = _graphExpansions.get(record.data.expansionId);
			return expansionRecord?.display;
		}
		case "native-tool":
			return record.data.self ? "imp (self)" : `tool: ${record.data.name}`;
		case "semantic":
			return `semantic: ${record.data.kind}(${record.data.name ?? ""})`;
		case "configured":
			return `configured: ${Object.entries(record.data.overrides)
				.map(([axis, value]) => `${axis}=${value}`)
				.join(" ")}`;
		default:
			return undefined;
	}
}

/**
 * Walk the declared structure reachable from `roots` for introspection
 * (`imp targets`/`imp dependencies`), without executing any task action.
 * The one exception is expansion nodes (`expand()`'s `expansion.all()`/
 * `.get()` handles): discovering their child keys requires running the
 * expansion's own `create()` callback (and whatever upstream discovery task
 * its `inputs` need, e.g. `cargo metadata`/`cmake configure` — see
 * `_graphExecuteExpansion`, already memoized per invocation), but never the
 * children's own tasks. Returns one entry per reachable handle: its kind,
 * declared input edges, and — for expansion nodes — the discovered child
 * keys and each child's own (unexecuted) handle id, so the walk continues
 * into them structurally too.
 *
 * An expansion's own `inputs` may include `semantic.*` handles (mode/flag/
 * args/config reads), which only resolve inside a workflow invocation (see
 * `_graphResolveHandle`'s "semantic" case) — `invocationJson` supplies one
 * for the walk's duration, same shape as `__imp_execute_graph_handles`'s,
 * restoring whatever was ambient beforehand once done.
 *
 * `optsJson.discoverExpansionGet` (default false) additionally runs
 * discovery for `"expansion-get"` nodes, not just `"expansion-all"` — used
 * only by the `--changed-since` staleness walk (#7), which needs to see
 * inside single-key expansions like a Cargo crate's or Odin package's
 * `[TEST]`/`[BUILD]` root to reach their real dependency edges. Left off by
 * default so `imp targets`/`imp dependencies` keep today's cheaper, no-extra-
 * sandbox-risk behavior unchanged.
 *
 * `optsJson.discoverExpansionAll` (default true) is the inverse switch for
 * `"expansion-all"` nodes: set it false to see only what's exported without
 * ever running an expansion's `create()` (and whatever discovery task it
 * needs, e.g. `cargo metadata`/`cmake configure`) — used by `imp graph`'s
 * static-catalog view (#93), which must be able to show the graph with zero
 * tasks run. An undiscovered `"expansion-all"` node gets no `children`/
 * `expansionId`, same shape as any other leaf.
 */
async function _graphWalkForIntrospection(rootsJson, invocationJson, optsJson = "{}") {
	const roots = JSON.parse(rootsJson);
	const { discoverExpansionGet = false, discoverExpansionAll = true } = JSON.parse(optsJson);
	const visited = new Set();
	const queue = roots.map((root) => root.handleId);
	const nodes = [];
	const previousInvocation = _graphInvocation;
	_graphInvocation = Object.freeze(JSON.parse(invocationJson));
	try {
		return await _graphWalkForIntrospectionInner(
			queue,
			visited,
			nodes,
			discoverExpansionGet,
			discoverExpansionAll,
		);
	} finally {
		_graphInvocation = previousInvocation;
	}
}
async function _graphWalkForIntrospectionInner(
	queue,
	visited,
	nodes,
	discoverExpansionGet,
	discoverExpansionAll = true,
) {
	while (queue.length > 0) {
		const id = queue.shift();
		if (visited.has(id)) continue;
		visited.add(id);
		const record = _graphHandles.get(id);
		if (record === undefined) continue;
		const edges = _graphDeclaredEdges(record);
		for (const edge of edges) queue.push(edge.handleId);
		const node = { id, kind: record.kind, edges };
		if (record.kind === "file") {
			// record.data also holds the evaluated fileset (a live object with
			// memo fields); the walk only needs the path.
			node.data = { path: record.data.path };
		} else if (record.kind === "files") {
			node.data = record.data;
		}
		const display = _graphNodeDisplay(record);
		if (display !== undefined) node.display = display;
		// Only an "expansion-all" root needs its children actually
		// discovered: that's the one kind with no address of its own for any
		// individual child, which is the whole reason this walk exists. An
		// "expansion-get" root already names its one child by address (the
		// BUILD.js export itself) — running discovery for it would pay the
		// same cost (invoking `create()`, e.g. a real `cmake configure`/
		// `cargo metadata`, in a *separate* sandbox from the one goal
		// execution uses moments later) for zero new listing value, and
		// risks exactly the kind of cross-sandbox staleness hermetic caching
		// is supposed to prevent. The one exception is `discoverExpansionGet`
		// (used only by the `--changed-since` staleness walk): a Cargo/Odin
		// per-package `[TEST]`/`[BUILD]` root is itself an `expansion-get`,
		// and the dependency edges staleness needs to see (crate path deps,
		// inferred Odin imports) only exist once `create()` has run — see #7.
		if (record.kind === "expansion-all" && discoverExpansionAll) {
			const { expansionId, workflow, facet } = record.data;
			const children = await _graphExecuteExpansion(expansionId, _GRAPH_ROOT_SCOPE, []);
			node.expansionId = expansionId;
			node.children = {};
			for (const key of Object.keys(children).sort()) {
				try {
					const handle = _graphChildHandle(children[key], workflow, facet, "introspection");
					node.children[key] = handle.__graph_id;
					queue.push(handle.__graph_id);
				} catch (_) {
					// This child has no handle for the requested workflow/facet —
					// simply not listed for it, same as expansion.all()'s own
					// resolution silently would not reach it either.
				}
			}
		} else if (record.kind === "expansion-get" && discoverExpansionGet) {
			const { expansionId, workflow, facet, childKey } = record.data;
			const children = await _graphExecuteExpansion(expansionId, _GRAPH_ROOT_SCOPE, []);
			const child = children[childKey];
			if (child !== undefined) {
				try {
					const handle = _graphChildHandle(child, workflow, facet, "staleness");
					edges.push({ name: `#${childKey}`, handleId: handle.__graph_id });
					queue.push(handle.__graph_id);
				} catch (_) {
					// No handle for this workflow/facet on the discovered child —
					// nothing further to walk into for staleness purposes.
				}
			}
		}
		nodes.push(node);
	}
	return JSON.stringify({ nodes });
}
globalThis.__imp_walk_graph_for_introspection = _graphWalkForIntrospection;

globalThis.__imp_collect_graph_exports = function collectGraphExports(ns, scope) {
	const roots = [];
	for (const exportName of Object.getOwnPropertyNames(ns)) {
		const value = ns[exportName];
		if (value === null || typeof value !== "object") continue;
		const isDefault = exportName === "default";
		const address = isDefault ? scope : `${scope}:${exportName}`;
		for (const key of Object.getOwnPropertySymbols(value)) {
			const workflow = _workflow_name_by_symbol.get(key);
			if (workflow === undefined) continue;
			const action = value[key];
			if (action && action.__imp_graph_handle === true) {
				roots.push({ address, workflow, facet: null, handleId: action.__graph_id, isDefault });
				continue;
			}
			if (action === null || typeof action !== "object" || Array.isArray(action))
				throw _graphError(`${address}#${workflow} must be a handle or named facet object`);
			for (const facet of Object.keys(action).sort()) {
				if (!/^[A-Za-z0-9_.-]+$/.test(facet)) throw _graphError(`${address} has invalid facet '${facet}'`);
				const handle = action[facet];
				_graphRecord(handle, `${address}@${facet}#${workflow}`);
				roots.push({ address, workflow, facet, handleId: handle.__graph_id, isDefault });
			}
		}
	}
	return JSON.stringify(roots);
};

// Open an invocation scope: an invocation record plus the in-flight memo
// tables that make one node execute once for its duration.
//
// Saves and RESTORES all three, the same discipline
// _graphWalkForIntrospection already uses for _graphInvocation alone. The
// restore matters because resolution can nest: a task body may resolve
// another handle through resolveGraphHandle() (rules/rust/kache's
// RUSTC_WRAPPER role does exactly this, from inside toolEnvAndTools()). An
// inner scope that nulled the invocation and cleared the tables on the way
// out would leave the outer execution with no invocation — every later
// semantic.* read throwing "resolved outside a workflow invocation" — and no
// memo table, silently re-executing tasks it had already run.
//
// At the top level this is identical to what it replaces: the previous
// invocation is null and the tables it restores are the empty module-level
// ones, so no state crosses between invocations.
async function _graphWithInvocation(invocation, fn) {
	const previousInvocation = _graphInvocation;
	const previousTaskMemo = _graphTaskMemo;
	const previousExpansionMemo = _graphExpansionMemo;
	_graphInvocation = Object.freeze(invocation);
	// A goal run has two phases: discovery walks the graph and resolves what
	// `expand()` needs, then dispatch executes it. Both call this function.
	// A new map here would throw away every promise discovery made, thus
	// each node they share would run a second time. Inside a run, keep the
	// tables; `__imp_graph_begin_run` already made them fresh for this run.
	if (!_graphRunActive) {
		_graphTaskMemo = new Map();
		_graphExpansionMemo = new Map();
		_graphValueMemo = new Map();
		_graphAxes = new Map();
		_graphExpansionAxes = new Map();
	}
	try {
		return await fn();
	} finally {
		_graphInvocation = previousInvocation;
		if (!_graphRunActive) {
			_graphTaskMemo = previousTaskMemo;
			_graphExpansionMemo = previousExpansionMemo;
		}
	}
}

// One goal run owns the memo tables for the whole of its discovery and
// dispatch. More than one run can happen in one process: production runs a
// single goal for each command, but the tests run several against one
// workspace, and each of those must start with nothing remembered.
//
// `__imp_graph_begin_run` always makes the tables fresh, thus a run that
// ends with an error cannot leave a value for the next run to find.
globalThis.__imp_graph_begin_run = function beginRun(invocationJson) {
	_graphInvocation = Object.freeze(JSON.parse(invocationJson));
	_graphTaskMemo = new Map();
	_graphExpansionMemo = new Map();
	_graphValueMemo = new Map();
	_graphAxes = new Map();
	_graphExpansionAxes = new Map();
	_graphRunActive = true;
};

globalThis.__imp_graph_end_run = function endRun() {
	_graphRunActive = false;
	_graphInvocation = null;
	_graphTaskMemo = new Map();
	_graphExpansionMemo = new Map();
	_graphValueMemo = new Map();
	_graphAxes = new Map();
	_graphExpansionAxes = new Map();
};

function _graphResolveRecord(handle, record) {
	return record.kind === "task"
		? _graphExecuteTask(record.data.taskId, _GRAPH_ROOT_SCOPE, [])
		: _graphResolveHandle(handle.__graph_id, _GRAPH_ROOT_SCOPE);
}

/**
 * Execute whatever a graph handle needs and return its resolved binding.
 *
 * The imperative escape hatch for a caller that holds a handle but is not
 * itself a graph root — Toolchain.bin() answering `imp @tool`, say. Prefer
 * declaring the handle as a task input: that keeps the edge in the graph,
 * where culling, caching, and introspection can all see it. This exists for
 * the callers that cannot.
 *
 * Inside an active invocation this JOINS that invocation rather than opening
 * a new one, so an install task the surrounding build already started is
 * awaited instead of run a second time.
 *
 * The handle must have been constructed at declaration time: task() refuses
 * to add graph nodes during execution, so a caller reachable from inside a
 * task body must look its handle up, not build one.
 *
 * @category graph
 * @param {object} handle A graph handle from task()/tool()/an output slot.
 * @returns {Promise<object|undefined>} The resolved binding.
 */
export async function resolveGraphHandle(handle) {
	const record = _graphRecord(handle, "resolveGraphHandle(handle)");
	if (_graphInvocation !== null) return _graphResolveRecord(handle, record);
	return _graphWithInvocation({}, () => _graphResolveRecord(handle, record));
}

// Measure how much the graph grows after dispatch starts.
//
// The graph rework wants the shape of the graph to be final before any
// action runs. Two things stop that today. `expansion.get()` children are
// found while dispatch runs, not before it. And `expand()` runs `create()`
// in the "expansion" phase, which task() permits to add nodes, unlike the
// "execution" phase.
//
// This probe counts the nodes at the start and at the end of dispatch. A
// count that grows shows the size of the hole for one selection. Read it
// with `--level debug` and look for the "graph shape" line. Delete this
// probe when the shape is final before dispatch.
function _graphShapeCounts() {
	return {
		handles: _graphHandles.size,
		tasks: _graphTasks.size,
		expansions: _graphExpansions.size,
	};
}

globalThis.__imp_execute_graph_handles = async function executeGraphHandles(handleIdsJson, invocationJson) {
	const roots = JSON.parse(handleIdsJson);
	const before = _graphShapeCounts();
	// Plan the graph into leaf-first waves next to the pull-based run, to
	// show that a plan exists and covers every node, before anything is
	// scheduled from it. A node that no wave holds means a cycle.
	if (globalThis.__imp_graph_shape_probe) {
		const plan = _graphPlanWaves(roots.map((root) => root.handleId));
		const widest = plan.waves.reduce((most, wave) => Math.max(most, wave.length), 0);
		__host_log(
			"warn",
			`graph plan: ${plan.scheduled}/${plan.total} nodes in ` +
				`${plan.waves.length} waves, widest ${widest}` +
				(plan.scheduled === plan.total ? "" : " — CYCLE, nodes unreachable by any wave"),
		);
	}
	const result = await _graphWithInvocation(JSON.parse(invocationJson), async () => {
		// Leaf-first: run the graph one wave at a time, from the leaves up.
		// Every node of a wave can start together, because all of its
		// dependencies are in waves that already finished. The roots below
		// then only collect what is already resolved.
		//
		// Order is the only thing this changes. Each node still resolves
		// through the same code as before, thus a node reached from inside
		// another node finds a value instead of starting new work.
		// Fill the axis closure before anything is dispatched. Every scoped
		// memo key is read synchronously (see `_graphNarrowKey`), thus the
		// closure has to be known before the first node starts. A node the
		// pass did not see keeps the whole scope as its key, which builds it
		// one time for each configuration — correct, only less shared.
		const startedAt = Date.now();
		const configs = await _graphPlanConfigs(roots.map((root) => root.handleId));
		if (globalThis.__imp_graph_shape_probe) {
			__host_log(
				"warn",
				`config axes: ${configs.total} nodes — ${configs.blind} read nothing, ` +
					`${configs.reading} read ${configs.names.length > 0 ? `{${configs.names.join(",")}}` : "{}"}, ` +
					`${configs.all} read the whole bundle (${Date.now() - startedAt}ms)`,
			);
		}
		if (globalThis.__imp_graph_wave_execution) {
			const startedAt = Date.now();
			const built = await _graphRunReadyQueue(
			roots.map((root) => root.handleId),
			_GRAPH_ROOT_SCOPE,
		);
			if (globalThis.__imp_graph_shape_probe)
				__host_log(
					"warn",
					`ready queue: ${built.total} nodes, build ${built.buildMs}ms, ` +
						`drain ${Date.now() - startedAt - built.buildMs}ms`,
				);
		}
		return Promise.all(roots.map(async ({ address, handleId }) => {
			const record = _graphHandles.get(handleId);
			if (record === undefined) throw _graphError(`unknown handle id ${handleId}`);
			const result = record.kind === "task"
				? await _graphExecuteTask(record.data.taskId, _GRAPH_ROOT_SCOPE, [])
				: await _graphResolveHandle(handleId, _GRAPH_ROOT_SCOPE);
			return Object.freeze({ address, result });
		}));
	});
	const after = _graphShapeCounts();
	const grew =
		after.handles !== before.handles ||
		after.tasks !== before.tasks ||
		after.expansions !== before.expansions;
	if (globalThis.__imp_graph_shape_probe)
		__host_log(
			"warn",
			`graph shape ${grew ? "GREW" : "final"} during dispatch: ` +
				`handles ${before.handles}->${after.handles} ` +
				`tasks ${before.tasks}->${after.tasks} ` +
				`expansions ${before.expansions}->${after.expansions}`,
		);
	return result;
};
