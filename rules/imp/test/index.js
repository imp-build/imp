import {
	files,
	packagePath,
	task,
	TEST,
	withCapturedPackagePath,
} from "imp:core";
import { impTool } from "//rules/imp/self-tool";

const suites = [];
const tests = [];

function fullName(name) {
	return [...suites, name].join(" ");
}

function formatValue(value) {
	if (typeof value === "string") {
		return JSON.stringify(value);
	}
	if (value === undefined) {
		return "undefined";
	}
	try {
		return JSON.stringify(value);
	} catch (_) {
		return String(value);
	}
}

function isObject(value) {
	return value !== null && typeof value === "object";
}

function deepEqual(actual, expected) {
	if (Object.is(actual, expected)) {
		return true;
	}
	if (Array.isArray(actual) || Array.isArray(expected)) {
		if (
			!Array.isArray(actual) ||
			!Array.isArray(expected) ||
			actual.length !== expected.length
		) {
			return false;
		}
		return actual.every((value, index) => deepEqual(value, expected[index]));
	}
	if (isObject(actual) || isObject(expected)) {
		if (!isObject(actual) || !isObject(expected)) {
			return false;
		}
		const actualKeys = Object.keys(actual).sort();
		const expectedKeys = Object.keys(expected).sort();
		if (!deepEqual(actualKeys, expectedKeys)) {
			return false;
		}
		return actualKeys.every((key) => deepEqual(actual[key], expected[key]));
	}
	return false;
}

function failMatcher(name, actual, expected, negated) {
	const not = negated ? " not" : "";
	throw new Error(
		`${name}: expected ${formatValue(actual)}${not} to match ${formatValue(expected)}`,
	);
}

function makeMatchers(actual, negated = false) {
	function check(name, passed, expected) {
		const ok = negated ? !passed : passed;
		if (!ok) {
			failMatcher(name, actual, expected, negated);
		}
	}

	return {
		get not() {
			return makeMatchers(actual, !negated);
		},
		toBe(expected) {
			check("toBe", Object.is(actual, expected), expected);
		},
		toEqual(expected) {
			check("toEqual", deepEqual(actual, expected), expected);
		},
		toContain(expected) {
			const passed =
				typeof actual === "string"
					? actual.includes(expected)
					: Array.isArray(actual) && actual.includes(expected);
			check("toContain", passed, expected);
		},
		toBeTruthy() {
			check("toBeTruthy", !!actual, true);
		},
		toBeFalsy() {
			check("toBeFalsy", !actual, false);
		},
		toThrow(expected) {
			if (typeof actual !== "function") {
				throw new Error(
					`toThrow: expected ${formatValue(actual)} to be a function`,
				);
			}
			let thrown = null;
			try {
				actual();
			} catch (error) {
				thrown = error;
			}
			const message =
				thrown && thrown.message ? thrown.message : String(thrown);
			const passed =
				thrown !== null &&
				(expected === undefined ||
					(typeof expected === "string" && message.includes(expected)) ||
					(expected instanceof RegExp && expected.test(message)));
			check("toThrow", passed, expected === undefined ? "an error" : expected);
		},
	};
}

export function expect(actual) {
	return makeMatchers(actual);
}

export function describe(name, fn) {
	suites.push(name);
	try {
		fn();
	} finally {
		suites.pop();
	}
}

/**
 * Register a test. The default fixture contains core host bindings plus only
 * the test module's imports; use `fixture: "workspace"` for integration tests.
 * Every test gets a fresh runtime, with `isolation: "process"` available for
 * process-global state and hard-failure containment.
 *
 * @param {string} name
 * @param {{fixture?: "minimal"|"workspace", isolation?: "runtime"|"process"}|Function} optionsOrFn
 * @param {Function} [maybeFn]
 */
export function test(name, optionsOrFn, maybeFn) {
	const options = typeof optionsOrFn === "function" ? {} : optionsOrFn;
	const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
	if (typeof fn !== "function") {
		throw new Error("test(name, [options], fn) requires a test function");
	}
	if (
		options === null ||
		typeof options !== "object" ||
		Array.isArray(options)
	) {
		throw new Error("test options must be an object");
	}
	const known = new Set(["fixture", "isolation"]);
	for (const key of Object.keys(options)) {
		if (!known.has(key))
			throw new Error(`unknown test option ${JSON.stringify(key)}`);
	}
	const fixture = options.fixture || "minimal";
	const isolation = options.isolation || "runtime";
	if (fixture !== "minimal" && fixture !== "workspace") {
		throw new Error(
			`test fixture must be "minimal" or "workspace", got ${JSON.stringify(fixture)}`,
		);
	}
	if (isolation !== "runtime" && isolation !== "process") {
		throw new Error(
			`test isolation must be "runtime" or "process", got ${JSON.stringify(isolation)}`,
		);
	}
	tests.push({
		name: fullName(name),
		fn,
		fixture,
		isolation,
		// runTestCase() invokes fn() well after this module's own top-level
		// evaluation has finished (it's called from a separate test-running
		// driver, past the `await import(testModule)` that registered it) —
		// so packagePath() inside fn() needs this captured now, not
		// recomputed later. See graph_core.js's withCapturedPackagePath().
		packagePath: packagePath(),
	});
}

export const it = test;

/**
 * Run a test body with `__host_run` stubbed out, so `run()` calls resolve
 * without executing anything. Effects are still traced (tracing happens
 * before the host bridge), so `getMemoTrace()` assertions work unchanged.
 */
export async function withFakeRun(fn) {
	const real = globalThis.__host_run;
	globalThis.__host_run = async () => ({ stdout: "", stderr: "", exitCode: 0 });
	try {
		return await fn();
	} finally {
		globalThis.__host_run = real;
	}
}

/**
 * Run a test body with `__host_diff_digests` stubbed out, so `diffDigests()`
 * returns a fixed, caller-provided set of changes regardless of the (fake or
 * real) digests it's called with — for tests that fake `run()` (so there's no
 * real output digest to diff against) but still want to exercise the
 * diff-driven branch of a product.
 *
 * @param {Array<{type: "added"|"removed"|"modified", path: string}>} changes
 * @param {() => Promise<any>} fn
 */
export async function withFakeDiff(changes, fn) {
	const real = globalThis.__host_diff_digests;
	globalThis.__host_diff_digests = () => JSON.stringify(changes);
	try {
		return await fn();
	} finally {
		globalThis.__host_diff_digests = real;
	}
}

/**
 * Run a test body with `__host_merge_digests` stubbed out, so `mergeDigests()`
 * resolves without touching CAS — for tests that fake `run()` (so there's no
 * real per-step digest to merge) but still want to exercise a digest-chained
 * build step. Returns the first input digest (or "" if none) rather than a
 * genuinely merged tree, since no real content backs it in a faked-run test.
 *
 * @param {() => Promise<any>} fn
 */
export async function withFakeMergeDigests(fn) {
	const real = globalThis.__host_merge_digests;
	globalThis.__host_merge_digests = (digestsJson) => {
		const digests = JSON.parse(digestsJson);
		return digests.length > 0 ? digests[0] : "";
	};
	try {
		return await fn();
	} finally {
		globalThis.__host_merge_digests = real;
	}
}

/**
 * Run a test body with `__host_write_workspace` stubbed out, recording each
 * call instead of materializing a real digest — for tests that fake `run()`
 * (so there's no real output digest to publish) but still want to exercise a
 * `package` product's `writeWorkspace()` call.
 *
 * @param {(calls: Array<{path: string, digest: string, from: string|null}>) => Promise<any>} fn
 */
export async function withFakeWriteWorkspace(fn) {
	const real = globalThis.__host_write_workspace;
	const calls = [];
	globalThis.__host_write_workspace = (path, digest, from) => {
		calls.push({ path, digest, from });
	};
	try {
		return await fn(calls);
	} finally {
		globalThis.__host_write_workspace = real;
	}
}

/**
 * Run a test body with `__host_selected_targets` stubbed to return `list`,
 * so `selectedTargets()` works inside a test even though tests run outside
 * of `execute_goal_live` (where the real binding always errors).
 *
 * @param {Array<{ id: number, address: string, kind: string, product: string }>} list
 * @param {() => Promise<any>} fn
 */
export async function withFakeSelectedTargets(list, fn) {
	const real = globalThis.__host_selected_targets;
	globalThis.__host_selected_targets = () => JSON.stringify(list);
	try {
		return await fn();
	} finally {
		globalThis.__host_selected_targets = real;
	}
}

/**
 * Run a test body with toolchain host bridge calls stubbed. This is for
 * testing rule-layer toolchain declaration/acquisition logic without network,
 * archive extraction, or real native-tool resolution.
 */
export async function withFakeToolchainHost(platOrFn, maybeFn) {
	const plat =
		typeof platOrFn === "function" ? { os: "linux", arch: "x86_64" } : platOrFn;
	const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
	const calls = [];
	const runs = [];
	const cache = new Map();

	const originals = {
		target: globalThis.__host_target,
		namedCache: globalThis.__host_named_cache,
		namedCacheDetails: globalThis.__host_named_cache_details,
		platformInfo: globalThis.__host_platform_info,
		cacheHas: globalThis.__host_cache_has,
		cacheGet: globalThis.__host_cache_get,
		cachePut: globalThis.__host_cache_put,
		download: globalThis.__host_download,
		extract: globalThis.__host_extract,
		run: globalThis.__host_run,
		nativeToolArtifact: globalThis.__host_native_tool_artifact,
		graphToolDescriptor: globalThis.__host_graph_tool_descriptor,
		workerStart: globalThis.__host_worker_start,
		workerGet: globalThis.__host_worker_get,
		readAddressedFile: globalThis.__host_read_addressed_file,
	};

	const workers = new Map();
	const files = new Map();
	const runStdout = new Map();
	const runStderr = new Map();
	const namedCacheDetails = new Map();

	const host = {
		calls,
		runs,
		workers,
		namedCacheDetails,
		install(name, key, path) {
			cache.set(`${name}/${key}`, path);
		},
		addFile(address, content) {
			files.set(address, content);
		},
		// Opt-in stdout for a run() call, matched by its `display`. Everything
		// not registered here keeps the default empty stdout, so this is
		// additive — only tests that actually parse run() stdout need it.
		setRunStdout(display, stdout) {
			runStdout.set(display, stdout);
		},
		// Same as setRunStdout, but for stderr — some run() callers (e.g.
		// rules/rust/index.js's runWorkspaceDocTests) attribute results from
		// cargo's stderr specifically, not stdout.
		setRunStderr(display, stderr) {
			runStderr.set(display, stderr);
		},
		clearCalls() {
			calls.length = 0;
		},
	};

	globalThis.__host_target = (
		kind,
		attrsJson,
		sourcesJson,
		depIds,
		depModes,
		depLinks,
	) => {
		if (kind === "native-tool") {
			const attrs = JSON.parse(attrsJson);
			calls.push(["nativeTool", attrs.name]);
		}
		return originals.target(
			kind,
			attrsJson,
			sourcesJson,
			depIds,
			depModes,
			depLinks,
		);
	};
	globalThis.__host_named_cache = (name) => {
		calls.push(["namedCache", name]);
	};
	globalThis.__host_named_cache_details = (name, fn) => {
		calls.push(["namedCacheDetails", name, fn]);
		namedCacheDetails.set(name, fn);
	};
	globalThis.__host_platform_info = () => {
		calls.push(["platformInfo"]);
		return JSON.stringify(plat);
	};
	globalThis.__host_cache_has = (name, key) => {
		calls.push(["cacheHas", name, key]);
		return cache.has(`${name}/${key}`);
	};
	globalThis.__host_cache_get = (name, key) => {
		calls.push(["cacheGet", name, key]);
		return cache.get(`${name}/${key}`) || null;
	};
	globalThis.__host_cache_put = (name, key, source) => {
		calls.push(["cachePut", name, key, source]);
		cache.set(`${name}/${key}`, `/cache/${name}/${key}`);
	};
	globalThis.__host_download = (url) => {
		calls.push(["download", url]);
		return "/downloads/odin-release";
	};
	globalThis.__host_extract = (archive, dest, format, stripComponents) => {
		calls.push(["extract", archive, dest, format, stripComponents]);
	};
	globalThis.__host_native_tool_artifact = (name) => {
		calls.push(["nativeToolSpec", name]);
		return `/tools/${name}`;
	};
	// Graph-native counterpart of __host_native_tool_artifact above — resolves
	// a graph-native nativeTool()/tool() native-tool binding's descriptor
	// (imp:core's graph_core.js "native-tool" case), needed by any test that
	// fully resolves a task() depending on nativeTool() (e.g. a toolchain's
	// own graph-native install task, not just its legacy memo()-based sibling).
	globalThis.__host_graph_tool_descriptor = (name, self) => {
		const resolvedName = self ? "imp" : name;
		calls.push(["graphNativeTool", resolvedName]);
		return JSON.stringify({
			name: resolvedName,
			cache: "native-tools",
			key: resolvedName,
			path: `/tools/${resolvedName}`,
			binDirs: ["."],
		});
	};
	globalThis.__host_run = async (opts) => {
		runs.push(opts);
		for (const out of opts.outputs || []) {
			if (out.namedCache) {
				cache.set(
					`${out.namedCache.name}/${out.namedCache.key}`,
					`/cache/${out.namedCache.name}/${out.namedCache.key}`,
				);
			}
		}
		return {
			stdout: runStdout.get(opts.display) ?? "",
			stderr: runStderr.get(opts.display) ?? "",
			exitCode: 0,
		};
	};
	globalThis.__host_worker_start = async (name, opts) => {
		calls.push(["workerStart", name, opts]);
		const handle = workers.get(name) || {
			homeDir: `/workers/${name}/home`,
			tmpDir: `/workers/${name}/tmp`,
			port: 40000,
		};
		workers.set(name, handle);
		return JSON.stringify(handle);
	};
	globalThis.__host_worker_get = (name) => {
		calls.push(["workerGet", name]);
		const handle = workers.get(name);
		return handle ? JSON.stringify(handle) : null;
	};
	globalThis.__host_read_addressed_file = (address) => {
		calls.push(["readAddressedFile", address]);
		return files.get(address) ?? null;
	};

	try {
		return await fn(host);
	} finally {
		globalThis.__host_target = originals.target;
		globalThis.__host_named_cache = originals.namedCache;
		globalThis.__host_named_cache_details = originals.namedCacheDetails;
		globalThis.__host_platform_info = originals.platformInfo;
		globalThis.__host_cache_has = originals.cacheHas;
		globalThis.__host_cache_get = originals.cacheGet;
		globalThis.__host_cache_put = originals.cachePut;
		globalThis.__host_download = originals.download;
		globalThis.__host_extract = originals.extract;
		globalThis.__host_run = originals.run;
		globalThis.__host_native_tool_artifact = originals.nativeToolArtifact;
		globalThis.__host_graph_tool_descriptor = originals.graphToolDescriptor;
		globalThis.__host_worker_start = originals.workerStart;
		globalThis.__host_worker_get = originals.workerGet;
		globalThis.__host_read_addressed_file = originals.readAddressedFile;
	}
}

async function importTestModule(testModule) {
	const from = tests.length;
	await import(testModule);
	const selected = tests.slice(from);
	if (selected.length === 0)
		throw new Error(`no tests registered for ${testModule}`);
	return selected;
}

/**
 * Discover one module in a disposable runtime. Test ordinals are local to the
 * module and remain stable even when display names are duplicated.
 */
export async function discoverTestModule(testModule) {
	const selected = await importTestModule(testModule);
	return selected.map((entry, ordinal) => ({
		ordinal,
		name: entry.name,
		fixture: entry.fixture,
		isolation: entry.isolation,
	}));
}

/** Execute exactly one test in a fresh runtime. */
export async function runTestCase(testModule, ordinal) {
	const selected = await importTestModule(testModule);
	const entry = selected[ordinal];
	if (entry === undefined) {
		throw new Error(`${testModule} has no test at ordinal ${ordinal}`);
	}
	await withCapturedPackagePath(entry.packagePath, () => entry.fn());
}

// The rules-test subprocess is a coordinator. It discovers these modules and
// gives every registered test a fresh core-only runtime, execution service,
// and scheduler; tests can explicitly request the loaded workspace or a
// fresh OS process. The coordinator remains unsandboxed because suites such
// as the native-tool and tracked-API suites deliberately probe ambient host
// state.
async function runRulesTest(exec, inputs) {
	const testModules = exec
		.paths(inputs.testModules)
		.slice()
		.sort()
		.map((path) => `//${path.replace(/\.js$/, "")}`);
	if (testModules.length === 0) {
		throw new Error(`no JS rule tests found directly in //${inputs.root}`);
	}
	const tools = inputs.toolNames.map((_, index) => inputs[`tool${index}`]);
	await exec.action({
		argv: [exec.tool(inputs.imp, "imp"), "rules-test", ...testModules],
		inputs: [inputs.sharedSources, inputs.rootSources],
		tools,
		env: [`IMP_CACHE_DIR=${inputs.cacheDir}`],
		display: `test JS rules //${inputs.root}`,
	});
}

/**
 * Declare a JS rule-test graph root for one workspace directory. Only
 * `_test.js` files directly in `root` are owned; nested directories declare
 * their own root.
 *
 * @category target
 * @param {object} opts
 * @param {string} opts.root Workspace-rooted directory, e.g. "//rules/odin".
 * @param {object[]} [opts.tools] `nativeTool(...)` handles this root's test
 *   suite genuinely resolves via PATH (not stubbed with withFakeToolchainHost)
 *   — e.g. odin's tests call real `nativeToolSpec(nativeTool("mkdir"))`. The
 *   sandboxed test subprocess otherwise has no PATH at all, so any undeclared
 *   real lookup fails.
 * @returns {object} Object exporting a TEST graph root.
 */
export function rulesTest({ root, tools = [] }) {
	if (typeof root !== "string" || !root.startsWith("//") || root.length <= 2) {
		throw new Error(
			"rulesTest({ root }) requires a //workspace-rooted directory",
		);
	}
	if (!Array.isArray(tools)) {
		throw new Error(
			"rulesTest({ tools }) expects an array of graph tool handles",
		);
	}
	const relativeRoot = root.slice(2);
	const toolNames = tools.map((tool, index) => {
		if (!tool || tool.__imp_graph_handle !== true) {
			throw new Error(`rulesTest tool ${index} is not a graph tool handle`);
		}
		return tool.name || `tool${index}`;
	});
	const inputs = {
		root: relativeRoot,
		testModules: files({ root: relativeRoot, include: ["*_test.js"] }),
		rootSources: files({ root: relativeRoot, include: ["**/*"] }),
		sharedSources: files({ include: ["rules/**/*", "imp.workspace.js"] }),
		imp: impTool,
		toolNames,
		cacheDir: globalThis.__imp_cache_dir,
	};
	for (const [index, tool] of tools.entries()) inputs[`tool${index}`] = tool;
	const testTask = task({
		inputs,
		run: runRulesTest,
		display: `test JS rules ${root}`,
	});
	return Object.freeze({ [TEST]: testTask });
}
