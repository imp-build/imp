import {
	BUILD,
	FMT,
	LINT,
	PACKAGE,
	RUN,
	TEST,
	files,
	output,
	packagePath,
	semantic,
	task,
} from "imp:core";
import { nativeTool } from "//rules/imp/native-tool";
import {
	defaultPexToolchain,
	defaultPexToolchainVersion,
	pexGraphTool,
} from "//rules/python/pex_toolchain";
import {
	defaultUvToolchain,
	defaultUvToolchainVersion,
	uvGraphTool,
} from "//rules/python/uv_toolchain";

export const PYTHON_PROJECT_SOURCE_INCLUDES = [
	"pyproject.toml",
	"uv.lock",
	"**/*.py",
];

const appHooks = [];

export function registerPythonAppHook(hook) {
	if (typeof hook !== "function")
		throw new Error("registerPythonAppHook(hook) expects a function");
	if (!appHooks.includes(hook)) appHooks.push(hook);
}

function workspacePath(base, path) {
	if (typeof path !== "string") throw new Error("python path must be a string");
	const parts = [...base.split("/"), ...path.split("/")].filter(
		(part) => part && part !== ".",
	);
	if (parts.includes(".."))
		throw new Error(`python paths must stay within the workspace: ${path}`);
	return parts.join("/") || ".";
}

function resolveSpec({ src, resolve, base }) {
	if (resolve && resolve.__python_resolve !== true)
		throw new Error("Python targets expect resolve: pythonResolve(...)");
	if (src !== undefined && resolve)
		throw new Error("Python targets accept either src or resolve, not both");
	return (
		resolve ||
		Object.freeze({
			__python_resolve: true,
			path: workspacePath(base, src ?? "."),
			flavors: { default: {} },
		})
	);
}

function resolveArgs(resolve, mode) {
	const flavors = resolve.flavors;
	const name =
		Object.keys(flavors).length === 1 ? "default" : mode || "default";
	const flavor = flavors[name];
	if (!flavor)
		throw new Error(
			`python resolve at '${resolve.path}' does not define flavor '${name}' (available: ${Object.keys(flavors).join(", ")})`,
		);
	return flavor.extra ? ["--extra", flavor.extra] : [];
}

function appBuild(spec) {
	const shell = nativeTool("sh");
	const sources = files({
		root: spec.resolve.path,
		include: PYTHON_PROJECT_SOURCE_INCLUDES,
	});
	const pythonSources = files({
		root: spec.resolve.path,
		include: ["**/*.py"],
	});
	const build = task({
		display: `python-app build ${spec.resolve.path}`,
		inputs: {
			sources,
			uv: spec.uv,
			pex: spec.pex,
			shell,
			resolve: spec.resolve,
			mode: semantic.mode("python"),
			entryPoint: spec.entryPoint ?? null,
			extraPexArgs: spec.extraPexArgs,
			deps: spec.deps,
		},
		outputs: { artifact: output.artifact() },
		async run(exec, inputs) {
			for (const dep of inputs.deps) exec.path(dep);
			const syncArgs = resolveArgs(inputs.resolve, inputs.mode);
			const outputPath = ".imp-out/app.pex";
			const result = await exec.action({
				argv: [
					exec.tool(inputs.shell, "sh"),
					"-c",
					'src=$1; uv=$2; pex=$3; out=$4; sync=$5; entry=$6; pexargs=$7; "$uv" sync --project "$src" --locked --no-progress $sync && "$src/.venv/bin/python" "$pex" --venv-repository="$src/.venv" --no-transitive --pre -o "$out" ${entry:+-e "$entry"} -D "$src" $pexargs',
					"python-app-build",
					inputs.resolve.path,
					exec.tool(inputs.uv, "uv"),
					exec.tool(inputs.pex, "pex"),
					outputPath,
					syncArgs.join(" "),
					inputs.entryPoint || "",
					inputs.extraPexArgs.join(" "),
				],
				inputs: [inputs.sources],
				tools: [inputs.shell],
				outputs: { artifact: output.file(outputPath) },
			});
			return { artifact: result.outputs.artifact };
		},
	});
	const run = task({
		display: `python run ${spec.resolve.path}`,
		cache: false,
		inputs: {
			app: build.outputs.artifact,
			uv: spec.uv,
			args: semantic.args(),
		},
		async run(exec, inputs) {
			await exec.action({
				argv: [
					exec.tool(inputs.uv, "uv"),
					"run",
					"--no-project",
					"--managed-python",
					"--python",
					"3.13.0",
					"--",
					exec.path(inputs.app),
					...inputs.args,
				],
				inputs: [inputs.app],
			});
		},
	});
	return { build, run, sources, pythonSources };
}

function testRoot(spec) {
	const shell = nativeTool("sh");
	const sources = files({
		root: spec.resolve.path,
		include: PYTHON_PROJECT_SOURCE_INCLUDES,
	});
	return task({
		display: `python test ${spec.resolve.path}`,
		inputs: {
			sources,
			uv: spec.uv,
			shell,
			resolve: spec.resolve,
			mode: semantic.mode("python"),
			testArgs: spec.testArgs,
			deps: spec.deps,
		},
		async run(exec, inputs) {
			for (const dep of inputs.deps) exec.path(dep);
			const syncArgs = resolveArgs(inputs.resolve, inputs.mode);
			await exec.action({
				argv: [
					exec.tool(inputs.shell, "sh"),
					"-c",
					'src=$1; uv=$2; sync=$3; testargs=$4; "$uv" sync --project "$src" --locked --no-progress $sync && "$src/.venv/bin/python" -m pytest "$src" $testargs',
					"python-test",
					inputs.resolve.path,
					exec.tool(inputs.uv, "uv"),
					syncArgs.join(" "),
					inputs.testArgs.join(" "),
				],
				inputs: [inputs.sources],
				tools: [inputs.shell],
			});
		},
	});
}

function graphTool(value, tool, defaultTool, defaultVersion, name) {
	if (value?.__imp_graph_handle === true) return value;
	const selected = typeof value === "string" ? value : defaultVersion();
	if (!selected || !defaultTool())
		throw new Error(`no default ${name} toolchain configured`);
	return tool(selected);
}

export function pythonApp({
	src,
	entryPoint,
	uvVersion,
	pexVersion,
	extraPexArgs = [],
	resolve,
	deps = [],
	base = packagePath(),
} = {}) {
	const spec = {
		resolve: resolveSpec({ src, resolve, base }),
		entryPoint,
		extraPexArgs: [...extraPexArgs],
		deps: [...deps],
		uv: graphTool(
			uvVersion,
			uvGraphTool,
			defaultUvToolchain,
			defaultUvToolchainVersion,
			"uv",
		),
		pex: graphTool(
			pexVersion,
			pexGraphTool,
			defaultPexToolchain,
			defaultPexToolchainVersion,
			"PEX",
		),
	};
	const { build, run, sources, pythonSources } = appBuild(spec);
	const value = {
		sources,
		pythonSources,
		root: spec.resolve.path,
		[BUILD]: build.outputs.artifact,
		[PACKAGE]: build.outputs.artifact,
		[RUN]: run,
	};
	for (const hook of appHooks)
		Object.assign(value, hook(Object.freeze({ ...value })));
	return Object.freeze(value);
}

export function pythonTest({
	src,
	testArgs = [],
	uvVersion,
	resolve,
	deps = [],
	base = packagePath(),
} = {}) {
	const spec = {
		resolve: resolveSpec({ src, resolve, base }),
		testArgs: [...testArgs],
		deps: [...deps],
		uv: graphTool(
			uvVersion,
			uvGraphTool,
			defaultUvToolchain,
			defaultUvToolchainVersion,
			"uv",
		),
	};
	return Object.freeze({ root: spec.resolve.path, [TEST]: testRoot(spec) });
}
