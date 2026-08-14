import { BUILD } from "//rules/workflows/build";
import { RUN } from "//rules/workflows/run";
import {
	digestOf,
	files,
	mergeDigests,
	output,
	packagePath,
	resolveGraphHandle,
	task,
} from "imp:core";
import { nativeTool } from "//rules/imp/native-tool";
import {
	defaultNodeToolchain,
	defaultNodeToolchainVersion,
	nodeGraphTool,
	nodeTool,
} from "//rules/js/node/toolchain";
import {
	defaultPnpmToolchain,
	defaultPnpmToolchainVersion,
	pnpmGraphTool,
} from "//rules/js/pnpm/toolchain";

// Recursive whole-app tree, distinct from jsSources()'s shallow per-directory
// glob (see //rules/js) — an app's build/run/lint needs every source file
// under its root, not just the ones directly in it.
export const JS_APP_SOURCE_INCLUDES = [
	"package.json",
	"pnpm-lock.yaml",
	"tsconfig.json",
	"**/*.js",
	"**/*.jsx",
	"**/*.ts",
	"**/*.tsx",
];

// Dependency install only re-runs when the manifest/lockfile change, not on
// every source edit — a separate, narrower files() input than JS_APP_SOURCE_INCLUDES.
const JS_APP_INSTALL_INCLUDES = ["package.json", "pnpm-lock.yaml"];

const appHooks = [];

/** Register an internal facet hook enabled by importing a JS rules extension. */
export function registerJsAppHook(hook) {
	if (typeof hook !== "function")
		throw new Error("registerJsAppHook(hook) expects a function");
	if (!appHooks.includes(hook)) appHooks.push(hook);
}

function workspacePath(base, src) {
	if (typeof src !== "string") throw new Error("js app path must be a string");
	const parts = [...base.split("/"), ...src.split("/")].filter(
		(part) => part && part !== ".",
	);
	if (parts.includes(".."))
		throw new Error(`js paths must stay within the workspace: ${src}`);
	return parts.join("/") || ".";
}

function graphTool(value, tool, defaultTool, defaultVersion, name) {
	if (value?.__imp_graph_handle === true) return value;
	const selected = typeof value === "string" ? value : defaultVersion();
	if (!selected || !defaultTool())
		throw new Error(`no default ${name} toolchain configured`);
	return tool(selected);
}

function appSpec({
	src,
	entry,
	nodeVersion,
	pnpmVersion,
	base = packagePath(),
} = {}) {
	const root = workspacePath(base, src ?? ".");
	return {
		root,
		entry: entry ?? "index.js",
		sources: files({ root, include: JS_APP_SOURCE_INCLUDES }),
		node: graphTool(
			nodeVersion,
			nodeGraphTool,
			defaultNodeToolchain,
			defaultNodeToolchainVersion,
			"node",
		),
		// Kept alongside the resolved `node` handle above: [RUN]'s description
		// resolves node into a legacy tool spec via nodeTool(), which
		// re-resolves by version string against the same toolchain registry
		// graphTool() already consulted, rather than reusing the handle itself.
		nodeVersion,
		pnpm: graphTool(
			pnpmVersion,
			pnpmGraphTool,
			defaultPnpmToolchain,
			defaultPnpmToolchainVersion,
			"pnpm",
		),
	};
}

// pnpmStoreDirTool()/pnpmStoreDirEnv() (//rules/js/pnpm/toolchain) mount pnpm's
// shared content store for the *legacy* run() API only — they return plain
// descriptors, not graph handles, so exec.action() can't consume them (no
// graph-native named-cache mount primitive exists yet; rules/python's
// graph-native `uv sync` has the same gap). Install is still coarsely cached
// at the task level, keyed on package.json/the lockfile, so unrelated source
// edits never re-run it — only per-app-package-store sharing is unavailable.
function appInstall(spec) {
	const shell = nativeTool("sh");
	return task({
		display: `js install ${spec.root}`,
		inputs: {
			sources: files({ root: spec.root, include: JS_APP_INSTALL_INCLUDES }),
			pnpm: spec.pnpm,
			node: spec.node,
			shell,
		},
		outputs: { nodeModules: output.artifact() },
		async run(exec, inputs) {
			const pnpmBin = exec.tool(inputs.pnpm, "pnpm");
			const nodeBin = exec.tool(inputs.node, "node");
			const nodeDir = nodeBin.slice(0, nodeBin.lastIndexOf("/"));
			const result = await exec.action({
				argv: [
					exec.tool(inputs.shell, "sh"),
					"-c",
					`root=$1; pnpm=$2; nodedir=$3; cd "$root" && export PATH="$IMP_SANDBOX_ROOT/$nodedir:$PATH" && "$IMP_SANDBOX_ROOT/$pnpm" install --frozen-lockfile`,
					"js-install",
					spec.root,
					pnpmBin,
					nodeDir,
				],
				inputs: [inputs.sources],
				tools: [inputs.shell],
				outputs: { nodeModules: output.directory(`${spec.root}/node_modules`) },
			});
			return { nodeModules: result.outputs.nodeModules };
		},
	});
}

// A task-output artifact's captured content is nested under its own output
// slot name, so once mounted as another task's input it appears at
// `<sandbox root>/<name>` — not at the app's own `<root>/<targetName>`.
// Symlink it into place before running node/tsc so normal Node module
// resolution (and relative entry paths) find it.
function linkArtifactDir(root, artifactPath, targetName) {
	return `ln -s "$IMP_SANDBOX_ROOT/${artifactPath}" "${root}/${targetName}"`;
}

const TS_OUT_DIR = "dist";

function appTypecheck(spec, install) {
	const shell = nativeTool("sh");
	const ln = nativeTool("ln");
	// pnpm's .bin/tsc is a POSIX shell shim (not a bare symlink) that resolves
	// its real target via dirname/sed/uname — all ambient lookups the hermetic
	// sandbox needs declared explicitly, same reasoning as biome/ruff's cp/mkdir.
	const dirname = nativeTool("dirname");
	const sed = nativeTool("sed");
	const uname = nativeTool("uname");
	return task({
		display: `js typecheck ${spec.root}`,
		inputs: {
			sources: spec.sources,
			nodeModules: install.outputs.nodeModules,
			node: spec.node,
			shell,
			ln,
			dirname,
			sed,
			uname,
		},
		outputs: { ok: output.value(), dist: output.artifact() },
		async run(exec, inputs) {
			const nodeModulesPath = exec.path(inputs.nodeModules);
			const nodeBin = exec.tool(inputs.node, "node");
			const nodeDir = nodeBin.slice(0, nodeBin.lastIndexOf("/"));
			const result = await exec.action({
				argv: [
					exec.tool(inputs.shell, "sh"),
					"-c",
					`root=$1; nm=$2; nodedir=$3; ${linkArtifactDir("$root", "$nm", "node_modules")} && cd "$root" && export PATH="$IMP_SANDBOX_ROOT/$nodedir:$PATH" && test -x node_modules/.bin/tsc || { echo "tsApp() requires a 'typescript' devDependency (node_modules/.bin/tsc not found)" >&2; exit 1; }; node_modules/.bin/tsc -p tsconfig.json`,
					"js-typecheck",
					spec.root,
					nodeModulesPath,
					nodeDir,
				],
				inputs: [inputs.sources],
				tools: [
					inputs.shell,
					inputs.ln,
					inputs.dirname,
					inputs.sed,
					inputs.uname,
				],
				outputs: { dist: output.directory(`${spec.root}/${TS_OUT_DIR}`) },
			});
			return { ok: true, dist: result.outputs.dist };
		},
	});
}

// Describes the program rather than running it: //rules/workflows/run's
// graphRunGoal is the one place that actually executes a [RUN] root, so it
// alone owns sandboxing/streaming/CLI-tail policy. sources/nodeModules/dist
// are merged into one staged digest (see mergeDigests()'s own doc comment on
// combining several run() outputs this way) — nodeModules and dist are each
// already declared at their real spec.root-relative path
// (`${spec.root}/node_modules`, `${spec.root}/dist`), so once merged and
// staged under $IMP_SANDBOX_ROOT they land as ordinary siblings of the
// sources, the same tree shape `cd spec.root && node entry` expects; no
// symlinking into the user's real working directory required. nodeTool()
// resolves node into the legacy tool-spec shape run() consumes directly, the
// same bridge rules/js/node's nodeTool() and rules/python's uvTool() use.
function appRun(spec, install, dist) {
	return task({
		display: `js run ${spec.root}`,
		inputs: {
			sources: spec.sources,
			nodeModules: install.outputs.nodeModules,
			dist: dist ?? null,
			entry: dist ? `${TS_OUT_DIR}/${spec.entry}` : spec.entry,
		},
		outputs: { description: output.value() },
		async run(_exec, inputs) {
			const node = await nodeTool(spec.nodeVersion);
			const sourcesBinding = await resolveGraphHandle(spec.sources);
			const digests = [
				digestOf(sourcesBinding.fileset),
				inputs.nodeModules.digest,
			];
			if (inputs.dist) digests.push(inputs.dist.digest);
			return {
				description: {
					argv: [
						"sh",
						"-c",
						'root=$1; entry=$2; shift 2; cd "$IMP_SANDBOX_ROOT/$root" && exec node "$entry" "$@"',
						"js-run",
						spec.root,
						inputs.entry,
					],
					tools: [node],
					digest: mergeDigests(digests),
				},
			};
		},
	});
}

function buildAppValue(spec, buildOutput, install, dist) {
	const value = {
		sources: spec.sources,
		root: spec.root,
		[BUILD]: buildOutput,
		[RUN]: appRun(spec, install, dist).outputs.description,
	};
	for (const hook of appHooks)
		Object.assign(value, hook(Object.freeze({ ...value })));
	return Object.freeze(value);
}

/**
 * Declare a plain JavaScript application: dependency install only, no
 * type-checking. `entry` is a path relative to the app root. Use tsApp() for
 * a TypeScript application.
 */
export function jsApp(opts = {}) {
	const spec = appSpec(opts);
	const install = appInstall(spec);
	return buildAppValue(spec, install.outputs.nodeModules, install);
}

/**
 * Declare a TypeScript application: dependency install, then `tsc`
 * type-checks and emits against the app's own `tsconfig.json` (which must set
 * `outDir: "dist"`). `entry` is a path relative to that emitted `dist/`
 * directory. Requires `typescript` as a declared dependency.
 */
export function tsApp(opts = {}) {
	const spec = appSpec(opts);
	const install = appInstall(spec);
	const typecheck = appTypecheck(spec, install);
	return buildAppValue(
		spec,
		typecheck.outputs.ok,
		install,
		typecheck.outputs.dist,
	);
}
