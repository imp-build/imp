
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
let _graphTaskInflight = new Map();
let _graphExpansionInflight = new Map();
let _graphInvocation = null;
let _graphPhase = "construction";
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
	return _graphHandle("file", { path }, `file:${path}`);
}

/**
 * Declare a source set using the same root/include/exclude shape as glob().
 * @category graph
 * @param {object} [opts]
 * @returns {object} A semantic source-set handle.
 */
export function files(opts = {}) {
	const spec = _graphJson(opts, "files(options)");
	return _graphHandle("files", spec, `files:${_graphCanonical(spec)}`);
}

/**
 * Interpret an artifact handle as an executable tool.
 * @category graph
 * @param {object} artifactHandle
 * @param {object} [opts]
 * @returns {object} A tool handle accepted by exec.tool().
 */
export function tool(artifactHandle, opts = {}) {
	const artifactRecord = _graphRecord(artifactHandle, "tool(artifact, options)");
	const options = _graphJson(opts, "tool(options)");
	return _graphHandle(
		"tool",
		{ artifact: artifactHandle, options },
		`tool:${artifactRecord.fingerprint}:${_graphCanonical(options)}`,
	);
}

function _nativeGraphTool(name, self = false) {
	if (!self && (typeof name !== "string" || name.length === 0))
		throw _graphError("native tool name must be a non-empty string");
	return _graphHandle(
		"native-tool",
		Object.freeze({ name: self ? "imp" : name, self }),
		`native-tool:${self ? "self" : name}`,
		self ? {} : { __imp_native_tool: "native-tool", name },
	);
}

// rules/imp owns the public policy API. These private constructors let that
// module create native graph handles without exposing a second public core API.
globalThis.__imp_graph_native_tool = (name) => _nativeGraphTool(name, false);
globalThis.__imp_graph_self_tool = () => _nativeGraphTool("imp", true);

function _semanticHandle(kind, name = null, path = null) {
	return _graphHandle(
		"semantic",
		Object.freeze({ kind, name, path }),
		`semantic:${kind}:${name ?? ""}:${path ?? ""}`,
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

function _graphFunctionIdentity(fn, label) {
	const stack = new Error(`${label} registration`).stack || "";
	const site = __host_call_site_identity(stack) || `${label}:${fn.name || "<anonymous>"}`;
	return `${fn.name || "<anonymous>"}@${site}`;
}

function _graphTaskKey(fn, inputs, outputs, cache) {
	const fnId = _graphFunctionIdentity(fn, "task");
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
		inputs: Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.fingerprint])),
		outputs,
		cache,
	});
}

/**
 * Add an immutable task node to the graph and return its completion handle.
 * Named output handles are available under the returned handle's `outputs`.
 * @category graph
 * @param {object} opts
 * @param {Record<string, *>} [opts.inputs]
 * @param {Record<string, *>} [opts.outputs]
 * @param {function(object, object): Promise<object>} opts.run
 * @param {string} [opts.display]
 * @param {boolean} [opts.cache]
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
	let key = _graphTaskKey(opts.run, inputs, outputs, cache);
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
		display: opts.display || opts.run.name || `task ${id}`,
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

async function _graphResolveHandle(id, stack = []) {
	const record = _graphHandles.get(id);
	if (record === undefined) throw _graphError(`unknown handle id ${id}`);
	if (stack.includes(id)) throw _graphError(`dependency cycle through handle ${id}`);
	const nextStack = [...stack, id];
	switch (record.kind) {
		case "file":
			return _graphBinding("source", {
				fingerprint: record.fingerprint,
				path: record.data.path,
				inputs: [{ kind: "file", path: record.data.path }],
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
		case "semantic": {
			if (_graphInvocation === null)
				throw _graphError("semantic input resolved outside a workflow invocation");
			const { kind, name, path } = record.data;
			if (kind === "args") return Object.freeze([...(_graphInvocation.args || [])]);
			if (kind === "flag") return _graphInvocation.flags?.[name] === true;
			if (kind === "mode") return _graphInvocation.mode?.[name] ?? null;
			if (kind === "config") return _graphLookup(_graphInvocation.config?.[name] ?? null, path);
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
			const artifact = await _graphResolveHandle(record.data.artifact.__graph_id, nextStack);
			return _graphBinding("tool", {
				fingerprint: record.fingerprint,
				artifact,
				options: record.data.options,
				path: artifact.path,
				inputs: artifact.inputs,
			});
		}
		case "task":
			await _graphExecuteTask(record.data.taskId, nextStack);
			return undefined;
		case "task-output": {
			const result = await _graphExecuteTask(record.data.taskId, nextStack);
			return result[record.data.name];
		}
		case "expansion-get":
		case "expansion-all":
			return _graphResolveExpansionProjection(record, nextStack);
		default:
			throw _graphError(`unsupported handle kind '${record.kind}'`);
	}
}

function _graphRuntimeKey(value) {
	if (value && value.__imp_graph_binding === true) return { binding: value.fingerprint };
	if (Array.isArray(value)) return value.map(_graphRuntimeKey);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.keys(value).sort().map((key) => [key, _graphRuntimeKey(value[key])]));
	}
	return value;
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

function _graphExec(record) {
	let consumed = new Set();
	const consume = (binding) => {
		if (!binding || binding.__imp_graph_binding !== true)
			throw _graphError("exec path/tool helpers expect a resolved task input");
		consumed.add(binding);
		return binding;
	};
	return Object.freeze({
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
			const prefix = binDirs.length === 0 ? binding.path : `${binding.path}/${binDirs[0]}`;
			return `${prefix}/${executable}`;
		},
		async action(opts) {
			if (!opts || typeof opts !== "object" || !Array.isArray(opts.argv))
				throw _graphError("exec.action({ argv, ... }) requires an argv array");
			const actionInputs = [];
			const actionTools = [];
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
				if (!binding.native)
					throw _graphError(
						"exec.action().tools currently accepts native tool inputs; use exec.tool() for produced tools",
					);
				consume(binding);
				actionTools.push({
					name: binding.name,
					cache: binding.cache,
					key: binding.key,
					path: binding.path,
					binDirs: binding.binDirs,
				});
			};
			for (const binding of opts.tools || []) addTool(binding);
			for (const binding of consumed) _graphCollectActionInput(binding, actionInputs);
			for (const binding of consumed) {
				if (binding.native) addTool(binding);
			}
			consumed = new Set();
			_graphCollectActionInput(opts.inputs, actionInputs);
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
			const result = await run({
				argv: opts.argv,
				display: opts.display || record.display,
				env: opts.env,
				inputs: actionInputs,
				outputs: outputSpecs,
				tools: uniqueTools,
				allowFailure: opts.allowFailure,
				impure: opts.cache === false || !record.cache,
				forceCache: opts.forceCache,
				materialize: false,
				__graphOutputNames: outputNames,
			});
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

async function _graphExecuteTask(taskId, stack) {
	const record = _graphTasks.get(taskId);
	if (record === undefined) throw _graphError(`unknown task ${taskId}`);
	const resolved = {};
	for (const [name, input] of Object.entries(record.inputs)) {
		resolved[name] = input.kind === "literal" ? input.value : await _graphResolveHandle(input.handle.__graph_id, stack);
	}
	const runtimeKey = `${record.key}:${JSON.stringify(_graphRuntimeKey(resolved))}`;
	const existing = _graphTaskInflight.get(runtimeKey);
	if (existing) return existing;
	const promise = (async () => {
		const previous = _graphPhase;
		const previousPackagePath = _graphAmbientPackagePath;
		_graphPhase = "execution";
		_graphAmbientPackagePath = record.packagePath;
		try {
			const value = await record.run(_graphExec(record), Object.freeze(resolved));
			return _graphValidateTaskResult(record, value);
		} catch (error) {
			throw _graphError(`task '${record.display}' failed: ${error?.message || error}`);
		} finally {
			_graphPhase = previous;
			_graphAmbientPackagePath = previousPackagePath;
		}
	})();
	_graphTaskInflight.set(runtimeKey, promise);
	return promise;
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
	const key = JSON.stringify({
		fnId: _graphFunctionIdentity(opts.create, "expand"),
		inputs: Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.fingerprint])),
	});
	_graphExpansions.set(id, {
		id,
		key,
		display: opts.display || opts.create.name || `expansion ${id}`,
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

async function _graphExecuteExpansion(expansionId, stack) {
	const record = _graphExpansions.get(expansionId);
	if (record === undefined) throw _graphError(`unknown expansion ${expansionId}`);
	const resolved = {};
	for (const [name, input] of Object.entries(record.inputs)) {
		resolved[name] = input.kind === "literal" ? input.value : await _graphResolveHandle(input.handle.__graph_id, stack);
	}
	const runtimeKey = `${record.key}:${JSON.stringify(_graphRuntimeKey(resolved))}`;
	const existing = _graphExpansionInflight.get(runtimeKey);
	if (existing) return existing;
	const promise = (async () => {
		const previous = _graphPhase;
		const previousPackagePath = _graphAmbientPackagePath;
		_graphPhase = "expansion";
		_graphAmbientPackagePath = record.packagePath;
		try {
			const children = await record.create(Object.freeze(resolved));
			if (children === null || typeof children !== "object" || Array.isArray(children))
				throw _graphError(`expansion '${record.display}' must return a keyed object`);
			return children;
		} finally {
			_graphPhase = previous;
			_graphAmbientPackagePath = previousPackagePath;
		}
	})();
	_graphExpansionInflight.set(runtimeKey, promise);
	return promise;
}

async function _graphResolveExpansionProjection(record, stack) {
	const { expansionId, workflow, facet } = record.data;
	const children = await _graphExecuteExpansion(expansionId, stack);
	if (record.kind === "expansion-get") {
		const child = children[record.data.childKey];
		if (child === undefined) throw _graphError(`expansion has no child '${record.data.childKey}'`);
		const handle = _graphChildHandle(child, workflow, facet, `expansion.get('${record.data.childKey}')`);
		return _graphResolveHandle(handle.__graph_id, stack);
	}
	const result = {};
	for (const key of Object.keys(children).sort()) {
		const handle = _graphChildHandle(children[key], workflow, facet, `expansion.all() child '${key}'`);
		result[key] = await _graphResolveHandle(handle.__graph_id, stack);
	}
	return Object.freeze(result);
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
 */
async function _graphWalkForIntrospection(rootsJson, invocationJson, optsJson = "{}") {
	const roots = JSON.parse(rootsJson);
	const { discoverExpansionGet = false } = JSON.parse(optsJson);
	const visited = new Set();
	const queue = roots.map((root) => root.handleId);
	const nodes = [];
	const previousInvocation = _graphInvocation;
	_graphInvocation = Object.freeze(JSON.parse(invocationJson));
	try {
		return await _graphWalkForIntrospectionInner(queue, visited, nodes, discoverExpansionGet);
	} finally {
		_graphInvocation = previousInvocation;
	}
}
async function _graphWalkForIntrospectionInner(queue, visited, nodes, discoverExpansionGet) {
	while (queue.length > 0) {
		const id = queue.shift();
		if (visited.has(id)) continue;
		visited.add(id);
		const record = _graphHandles.get(id);
		if (record === undefined) continue;
		const edges = _graphDeclaredEdges(record);
		for (const edge of edges) queue.push(edge.handleId);
		const node = { id, kind: record.kind, edges };
		if (record.kind === "file" || record.kind === "files") {
			node.data = record.data;
		}
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
		if (record.kind === "expansion-all") {
			const { expansionId, workflow, facet } = record.data;
			const children = await _graphExecuteExpansion(expansionId, []);
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
			const children = await _graphExecuteExpansion(expansionId, []);
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

globalThis.__imp_execute_graph_handles = async function executeGraphHandles(handleIdsJson, invocationJson) {
	const roots = JSON.parse(handleIdsJson);
	_graphInvocation = Object.freeze(JSON.parse(invocationJson));
	_graphTaskInflight = new Map();
	_graphExpansionInflight = new Map();
	try {
		return await Promise.all(roots.map(async ({ address, handleId }) => {
			const record = _graphHandles.get(handleId);
			if (record === undefined) throw _graphError(`unknown handle id ${handleId}`);
			const result = record.kind === "task"
				? await _graphExecuteTask(record.data.taskId, [])
				: await _graphResolveHandle(handleId);
			return Object.freeze({ address, result });
		}));
	} finally {
		_graphInvocation = null;
		_graphTaskInflight.clear();
		_graphExpansionInflight.clear();
	}
};
