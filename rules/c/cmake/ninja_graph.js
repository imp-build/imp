// Parses CMake's generated Ninja build files (build.ninja + rules.ninja)
// well enough to replay individual build edges as standalone imp run()
// calls, so an unchanged source file's compile edge is a cache hit instead
// of the whole CMake project rebuilding as one atomic unit.
//
// Deliberately narrow: only the subset of Ninja's file format CMake's own
// Ninja generator actually emits (rule/build blocks, $in/$out/edge-scoped
// vars, |/|| dependency syntax, a single level of `include`) — not a
// general-purpose Ninja parser.

// Ninja escapes a literal `$`, `:`, or ` ` as `$$`, `$:`, `$ ` wherever one
// of those characters must appear in a value or path token instead of
// taking on its usual syntactic meaning. CMake's Ninja generator relies on
// `$:` specifically to emit Windows drive-letter paths (e.g.
// `cmake_ninja_workdir = C$:/tmp/imp/sandbox-.../`) — colon is otherwise the
// `build out: rule in` separator, so an unescaped one there would corrupt
// parsing. `$identifier`/`${identifier}` variable references (`$in`, `$out`,
// `$DEP_FILE`, ...) are untouched here: `\w` never matches `$`, `:`, or a
// space, so this always runs safely before expandVar() resolves those
// references later.
//
// Also normalizes any raw backslash to a forward slash. CMake's Windows
// Ninja generator writes several of its own per-edge variable values (not
// just OBJECT_DIR — DEP_FILE, TARGET_FILE, and the compiler's own absolute
// path all do it too) with native backslash separators, unlike build-line
// path tokens and cmake_ninja_workdir itself, which always stay
// forward-slashed. Left un-normalized, a resolved edge command carrying one
// of these reaches executeEdge()'s `argv: ["sh", "-c", ...]` with a raw
// backslash in it — confirmed (via a real Windows run, then a controlled
// repro isolating each layer) to come out mangled on the other side: Rust's
// `Command::args()` escapes for a standard C-runtime argv parser, which
// MSYS bash's own argv reparsing doesn't match, so the backslash sequences
// get corrupted in transit and the command silently fails ("command not
// found") long before anything CMake- or Ninja-specific is at fault. Since
// this codebase already treats forward slashes as the one true separator
// everywhere else (sandboxRoot, path tokens, ...), and both separators
// resolve identically on Windows' own filesystem APIs, normalizing here
// removes the raw backslash before it can ever reach that boundary. Safe
// for this file's own deliberately-narrow scope (see its own docstring):
// every backslash CMake's generator emits into a value here is a path
// separator, never a literal character with some other meaning.
function unescapeNinjaValue(s) {
	return s.replace(/\$([$: ])/g, "$1").replace(/\\/g, "/");
}

function tokenizePaths(s) {
	const trimmed = (s || "").trim();
	return trimmed.length === 0
		? []
		: trimmed.split(/\s+/).map(unescapeNinjaValue);
}

function splitOnce(s, sep) {
	const idx = s.indexOf(sep);
	return idx === -1 ? [s, ""] : [s.slice(0, idx), s.slice(idx + sep.length)];
}

// Comment line CMake's Ninja generator emits directly above a target's own
// object/link edges — the only reliable, machine-readable source of a
// target's real CMake type (STATIC_LIBRARY/SHARED_LIBRARY/MODULE_LIBRARY/
// EXECUTABLE/OBJECT_LIBRARY/INTERFACE_LIBRARY/UTILITY). Confirmed against a
// real `cmake -G Ninja` run: e.g. "# Link build statements for
// SHARED_LIBRARY target mylib" / "# Object build statements for EXECUTABLE
// target mytest".
const TARGET_TYPE_COMMENT_RE =
	/^#\s*(?:Object|Link) build statements for (\S+) target (.+)$/;

// Parses `mainText` (normally build.ninja's content) plus any files it
// `include`s, resolved via the synchronous `readInclude(path)` callback (so
// this works identically against real CAS-backed reads and plain string
// fixtures in tests). Returns { rules, edges, topVars, targetTypes }.
export function parseNinja(mainText, readInclude) {
	const rules = {};
	const edges = [];
	const topVars = {};
	const targetTypes = {};
	parseInto(mainText, rules, edges, topVars, targetTypes, readInclude);
	return { rules, edges, topVars, targetTypes };
}

function parseInto(text, rules, edges, topVars, targetTypes, readInclude) {
	const lines = text.split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const stripped = line.trim();

		if (stripped.length === 0) {
			i += 1;
			continue;
		}

		if (stripped.startsWith("#")) {
			const match = TARGET_TYPE_COMMENT_RE.exec(stripped);
			if (match) targetTypes[match[2]] = match[1];
			i += 1;
			continue;
		}

		if (stripped.startsWith("include ")) {
			// MSVC's CMake generator emits this path with backslash
			// separators (confirmed via a real `include CMakeFiles\rules.ninja`
			// line) — GCC's never has, so this went unnoticed until now.
			// unescapeNinjaValue() already normalizes backslashes to forward
			// slashes for every other path token in this file; apply it here
			// too, since readInclude() (readFileInDigest() in practice) looks
			// paths up by their forward-slash digest key.
			const incPath = unescapeNinjaValue(
				stripped.slice("include ".length).trim(),
			);
			parseInto(
				readInclude(incPath),
				rules,
				edges,
				topVars,
				targetTypes,
				readInclude,
			);
			i += 1;
			continue;
		}

		if (stripped.startsWith("rule ")) {
			const name = stripped.slice("rule ".length).trim();
			i += 1;
			const body = {};
			while (i < lines.length && lines[i].startsWith("  ")) {
				const [k, v] = splitOnce(lines[i].trim(), "=");
				body[k.trim()] = unescapeNinjaValue(v.trim());
				i += 1;
			}
			rules[name] = body;
			continue;
		}

		if (stripped.startsWith("build ")) {
			const rest = stripped.slice("build ".length);
			const [outsPart, rhsRaw] = splitOnce(rest, ":");
			const rhs = rhsRaw.trim();

			const [explicitOut, implicitOutRaw] = splitOnce(outsPart, "|");
			const [ruleAndInsRaw, orderOnlyRaw] = splitOnce(rhs, "||");
			const ruleAndIns = ruleAndInsRaw.trim();
			const [ruleName, insRaw] = splitOnce(ruleAndIns, " ");
			const [explicitIn, implicitInRaw] = splitOnce(insRaw.trim(), "|");

			i += 1;
			const vars = {};
			while (i < lines.length && lines[i].startsWith("  ")) {
				const [k, v] = splitOnce(lines[i].trim(), "=");
				vars[k.trim()] = unescapeNinjaValue(v.trim());
				i += 1;
			}

			edges.push({
				outputs: tokenizePaths(explicitOut),
				implicitOutputs: tokenizePaths(implicitOutRaw),
				rule: ruleName.trim(),
				inputs: tokenizePaths(explicitIn),
				implicitInputs: tokenizePaths(implicitInRaw),
				orderOnly: tokenizePaths(orderOnlyRaw),
				vars,
			});
			continue;
		}

		// Top-level "name = value" variable assignment.
		if (stripped.includes("=")) {
			const [k, v] = splitOnce(stripped, "=");
			topVars[k.trim()] = unescapeNinjaValue(v.trim());
		}
		i += 1;
	}
}

// Resolves $in / $out / $VAR references in a template string against an
// edge's own bindings, falling back to the rule's defaults, then top-level
// variables — matching Ninja's scoping for the subset CMake emits.
export function expandVar(template, edge, topVars, ruleDefaults) {
	return template.replace(/\$\{?(\w+)\}?/g, (whole, name) => {
		if (name === "in") return edge.inputs.join(" ");
		if (name === "out") return edge.outputs.join(" ");
		if (Object.prototype.hasOwnProperty.call(edge.vars, name)) {
			return expandVar(edge.vars[name], edge, topVars, ruleDefaults);
		}
		if (Object.prototype.hasOwnProperty.call(ruleDefaults, name))
			return ruleDefaults[name];
		if (Object.prototype.hasOwnProperty.call(topVars, name))
			return topVars[name];
		return "";
	});
}

// Backward-reachability: given one or more starting output names (e.g.
// "all"), return just the edges needed to produce them, in topological
// (dependency-first) order. CMake's own bookkeeping edges (build.ninja
// regen, clean, help, edit_cache, rebuild_cache) are naturally excluded
// since nothing real depends on them from "all".
export function reachableEdges(edges, targetNames) {
	const byOutput = new Map();
	for (const edge of edges) {
		for (const o of [...edge.outputs, ...edge.implicitOutputs]) {
			byOutput.set(o, edge);
		}
	}

	const visited = new Set();
	const order = [];

	function visit(edge) {
		if (visited.has(edge)) return;
		visited.add(edge);
		for (const dep of [
			...edge.inputs,
			...edge.implicitInputs,
			...edge.orderOnly,
		]) {
			const depEdge = byOutput.get(dep);
			if (depEdge) visit(depEdge);
		}
		order.push(edge);
	}

	for (const name of targetNames) {
		const edge = byOutput.get(name);
		if (edge) visit(edge);
	}
	return order;
}

// Same backward-reachability walk as reachableEdges(), but treats any
// dependency path in `boundaryOutputs` as a stop: record it, don't recurse
// into whatever edge produces it. `boundaryOutputs` is the set of *other*
// named CMake targets' own final output paths (see listNamedCmakeTargets()) —
// CMake's Ninja generator names exactly this path in a `|`/`||` reference
// when one real target depends on another (confirmed against a real
// `build.ninja`: an order-only `|| libcrypto.a` on a static library's own
// link edge when it depends on another library, an implicit `| libssl.a
// libcrypto.a` on an executable's link edge that actually needs the files
// present — both forms are walked identically here since
// inputs/implicitInputs/orderOnly are checked the same way). Used to avoid
// re-deriving another target's own edges when it already has its own
// independent replay task producing that exact artifact.
export function reachableEdgesBounded(edges, targetNames, boundaryOutputs) {
	const byOutput = new Map();
	for (const edge of edges) {
		for (const o of [...edge.outputs, ...edge.implicitOutputs]) {
			byOutput.set(o, edge);
		}
	}

	const visited = new Set();
	const order = [];
	const boundaries = new Set();

	function visit(edge) {
		if (visited.has(edge)) return;
		visited.add(edge);
		for (const dep of [
			...edge.inputs,
			...edge.implicitInputs,
			...edge.orderOnly,
		]) {
			if (boundaryOutputs.has(dep)) {
				boundaries.add(dep);
				continue;
			}
			const depEdge = byOutput.get(dep);
			if (depEdge) visit(depEdge);
		}
		order.push(edge);
	}

	for (const name of targetNames) {
		const edge = byOutput.get(name);
		if (edge) visit(edge);
	}
	return { edges: order, boundaries: Array.from(boundaries) };
}

// Absolute host paths CMake bakes into rule commands (e.g. "/usr/bin/cc")
// don't resolve inside a fresh imp sandbox — every sandbox mounts tools
// at a fixed ".imp/tools/<name>/..." location, never at the tool's
// original host path (confirmed against src/exec.rs's tool-mounting code).
// Only rewrite paths in *command position* (start of string, or right after
// a shell control operator) — argument paths like "-I/abs/inc" or a source
// file path must be left alone.
//
// Matches a Windows drive-absolute path (`C:/...`, forward-slashed by the
// time this runs — see unescapeNinjaValue()) as well as a Unix one:
// confirmed against a real Windows `cmake -G Ninja` run that the compiler
// path gccCMakeCompilerArgs() bakes in (`-DCMAKE_C_COMPILER=C:/Users/.../
// clang.exe`) reaches this function unrewritten to a bare tool name when
// only the leading-`/` Unix form was matched — the drive letter isn't a
// leading `/`, so a forward-slashed Windows path slipped straight past the
// old pattern. Left unrewritten, that literal absolute host path (a
// "named" cache path, not the ephemeral sandbox root — never valid inside
// the replay sandbox) reached executeEdge()'s `sh -c` as a raw command
// name, which just doesn't exist there ("command not found").
const HOST_ABSOLUTE_TOOL_RE =
	/(^|&&|\|\||;|\()\s*(\/[^\s&|;()'"]+|[A-Za-z]:[\\/][^\s&|;()'"]+)/g;

// A compiler path CMake resolved *through* imp's own tool-mount
// convention at configure time (e.g. a Zig toolchain's CMAKE_C_COMPILER
// resolving to the literal relative path ".imp/tools/zig/zig", or
// CMAKE_RANLIB to ".imp/tools/zig/zigranlib") is never a real host-wide
// binary — "zigranlib" has no meaning on a plain PATH lookup, it only
// exists as a sibling file inside the zig toolchain's own mounted
// directory. So these names must never be resolved via a fresh nativeTool()
// PATH lookup (which would always fail) — the command text still needs
// rewriting to the bare name (only ".imp/tools/zig/zig", the absolute
// form, resolves on disk; "zig" resolves via PATH once compilerTools is
// mounted), but the name itself is deliberately *not* added to toolNames,
// since whatever already mounted that tool directory (compilerTools/
// cmakeToolSpec) already covers it.
const IMP_MOUNT_TOOL_RE =
	/(^|&&|\|\||;|\()\s*((?:\.\.\/)*\.imp\/tools\/)([^\s&|;()'"]+)/g;

export function rewriteToolInvocations(command) {
	const toolNames = new Set();

	let rewritten = command.replace(
		IMP_MOUNT_TOOL_RE,
		(whole, prefix, mountPrefix, rest) => {
			const base = rest.split("/").pop();
			return prefix.length > 0 ? `${prefix} ${base}` : base;
		},
	);

	rewritten = rewritten.replace(
		HOST_ABSOLUTE_TOOL_RE,
		(whole, prefix, absPath) => {
			const base = absPath.split("/").pop();
			toolNames.add(base);
			return prefix.length > 0 ? `${prefix} ${base}` : base;
		},
	);

	return { command: rewritten, toolNames: Array.from(toolNames) };
}

// CMake always canonicalizes CMAKE_SOURCE_DIR/CMAKE_BINARY_DIR to absolute
// paths internally, regardless of how -S/-B were invoked — so every path
// embedded in generated commands is prefixed with the *configure sandbox's*
// absolute root, which won't exist in a later replay sandbox (each run()
// gets a fresh, randomly-rooted sandbox; confirmed via src/cache.rs's
// create_sandbox_root). CMake conveniently stamps that exact absolute root
// into build.ninja itself as `cmake_ninja_workdir = <abs build dir>/`, which
// combined with the workspace-relative buildDirPath we invoked configure
// with, lets us compute and strip the sandbox-root prefix so paths become
// workspace-relative again and resolve correctly in any later sandbox.
export function sandboxRootFromWorkdir(cmakeNinjaWorkdir, buildDirPath) {
	if (!cmakeNinjaWorkdir) return null;
	const workdir = cmakeNinjaWorkdir.replace(/\/+$/, "");
	const suffix = `/${buildDirPath}`;
	if (!workdir.endsWith(suffix)) return null;
	return workdir.slice(0, workdir.length - suffix.length);
}

// Ninja always executes build commands with cwd = the build directory (that
// is what `cmake_ninja_workdir` denotes), so a replayed edge's command must
// also run with cwd = buildDirPath for its own build-dir-relative paths
// (object outputs, DEP_FILE, etc. — left untouched by rebasing) to resolve.
// That means an absolute path rebased out of the *configure* sandbox needs
// to become relative *to the build directory*, not to the sandbox root —
// hence the "../" x depth prefix instead of stripping to "".
function upPrefixForBuildDir(buildDirPath) {
	const depth = buildDirPath
		.split("/")
		.filter((part) => part.length > 0 && part !== ".").length;
	return "../".repeat(depth);
}

export function rebaseAbsolutePaths(text, sandboxRoot, replacement = "") {
	if (!sandboxRoot) return text;
	return text.split(sandboxRoot + "/").join(replacement);
}

// CMake's Windows Ninja generator wraps a link rule's whole command in its
// own `cmd.exe /C "$PRE_LINK && <linker> ... && $POST_BUILD"` shell wrapper
// — confirmed against a real Windows `cmake -G Ninja` run: ninja doesn't
// invoke a shell for a rule's command the way it effectively does via
// `sh -c` on Unix, so CMake bakes cmd.exe's own equivalent in directly
// wherever a rule needs more than one statement. `$PRE_LINK`/`$POST_BUILD`
// are themselves edge-scoped variables — when a target needs a POST_BUILD
// custom command run from a different directory (e.g. a SHARED_LIBRARY's
// own build-then-copy-to-source-tree step), CMake gives POST_BUILD *its
// own* nested `cmd.exe /C "..."` wrapper, so expandVar() substituting it
// into the outer template produces a command with one `cmd.exe /C "` +
// `"` pair nested inside another — not something a single balanced-quote
// regex can unwrap correctly (matching only the first inner `"` as if it
// closed the outer wrapper truncates the command). resolveEdgeCommand()'s
// result already gets run through executeEdge()'s `sh -c` (see
// graph_replay.js), so every layer of this wrapper is both redundant and
// unusable there: CMake emits "cmd.exe" as a bare name, never an absolute
// path, so rewriteToolInvocations() never recognizes it as a tool needing
// a mount, and the sandbox's minimal, declared-tools-only PATH has nothing
// by that name — it just fails outright ("command not found"). Handled
// instead by stripping every "cmd.exe /C" prefix (regardless of nesting
// depth) and every stray double-quote outright, rather than trying to
// parse balanced quoting: nothing in a CMake-generated command legitimately
// needs a literal quote preserved (matching this file's own deliberately
// narrow scope — see its docstring), so this always leaves a clean, plain
// `&&`-joined shell command behind, at any nesting depth.
const CMD_EXE_PREFIX_RE = /cmd(?:\.exe)?\s+\/[Cc]\s+/g;

// The one piece of cmd.exe-specific syntax that survives the above
// otherwise: CMake pairs a `cmd.exe /C` wrapper that changes directory with
// `cd /D <dir>`, not a plain `cd <dir>` — `/D` is needed there because
// plain `cd` on cmd.exe can't switch drives. bash's own `cd` builtin has no
// such flag (and no need for one: a replay sandbox is always one drive), so
// left as-is it would try to `cd` into a literal directory named `/D`.
const CMD_CD_SLASH_D_RE = /\bcd\s+\/[Dd]\s+/g;

function stripCmdExeWrapper(command) {
	return command
		.replace(CMD_EXE_PREFIX_RE, "")
		.replace(CMD_CD_SLASH_D_RE, "cd ")
		.replace(/"/g, "");
}

// Rebases a single path token the same way, for use on edge input/output
// path lists (which are workspace/sandbox-root-relative, independent of
// whatever cwd a replayed command executes from) rather than command text.
export function rebasePath(path, sandboxRoot) {
	if (sandboxRoot && path.startsWith(sandboxRoot + "/")) {
		return path.slice(sandboxRoot.length + 1);
	}
	return path;
}

// Ninja writes a rule's `rspfile_content` out to `rspfile`'s path before
// running its command whenever a rule declares those two variables (used by
// CMake's static-library archive rules to pass a long object-file list to
// `ar` via `@rspfile` instead of a command line that could overflow argv/
// CreateProcess limits). Since edges here are replayed directly via `sh -c`
// rather than through real ninja, nothing else ever materializes that file —
// confirmed against a real Windows `cmake -G Ninja` run of BoringSSL, whose
// CXX_STATIC_LIBRARY_LINKER rule reads `rspfile = $RSP_FILE` / `rspfile_content
// = $in $LINK_PATH $LINK_LIBRARIES` and whose crypto edge sets `RSP_FILE =
// CMakeFiles/crypto.rsp` — exactly the path ar.exe reports missing
// ("@CMakeFiles/crypto.rsp: No such file or directory") without this.
// rspfile is always build-dir-relative (mirroring $out), so no
// upPrefixForBuildDir rebasing is needed on the path itself, only on any
// absolute configure-sandbox paths the content's $in-expanded token list
// might still carry.
function resolveEdgeRspfile(edge, rule, topVars, sandboxRoot, buildDirPath) {
	if (!rule.rspfile) return null;
	const path = expandVar(rule.rspfile, edge, topVars, rule);
	const rawContent = expandVar(
		rule.rspfile_content || "",
		edge,
		topVars,
		rule,
	).replace(/\\/g, "/");
	const content = rebaseAbsolutePaths(
		rawContent,
		sandboxRoot,
		upPrefixForBuildDir(buildDirPath),
	);
	return { path, content };
}

// Fully resolves one edge into a shell command ready to hand to run() with
// cwd = buildDirPath (matching ninja's own execution convention): rebases
// any absolute configure-sandbox paths to be relative to the build
// directory, and rewrites tool-binary invocations (absolute host paths, or
// imp's own ".imp/tools/..." mount paths) to bare names, resolved via
// PATH by whatever tools the caller declares for the run(). Also resolves
// the rule's rspfile (see resolveEdgeRspfile() above), if any, so the
// caller can write it before invoking the command.
export function resolveEdgeCommand(
	edge,
	rules,
	topVars,
	sandboxRoot,
	buildDirPath,
) {
	const rule = rules[edge.rule];
	if (!rule || !rule.command) return null;

	// MSVC's CMake/Ninja generator emits backslash-separated paths in flag
	// values too, not just the `include` directive fixed above (confirmed by
	// a real replayed edge silently writing its object file to the wrong
	// place: an unquoted `/FoCMakeFiles\hello_cmake.dir\hello.c.obj` reaching
	// `sh -c` has each backslash-letter pair collapsed by bash's own escape
	// handling, e.g. \h -> h, gluing the path into one nonexistent
	// component). rebaseAbsolutePaths() below only rewrites *absolute*
	// sandbox paths, so a relative flag value like this one would otherwise
	// reach `sh -c` completely unnormalized. Same invariant
	// unescapeNinjaValue() already documents for this file's own narrow
	// scope: every backslash CMake's generator emits into a value here is a
	// path separator, never a literal character with some other meaning —
	// safe to normalize globally, before any other processing.
	const expanded = expandVar(rule.command, edge, topVars, rule).replace(
		/\\/g,
		"/",
	);
	const rebased = rebaseAbsolutePaths(
		expanded,
		sandboxRoot,
		upPrefixForBuildDir(buildDirPath),
	);
	const unwrapped = stripCmdExeWrapper(rebased);
	const { command, toolNames } = rewriteToolInvocations(unwrapped);
	const rspfile = resolveEdgeRspfile(
		edge,
		rule,
		topVars,
		sandboxRoot,
		buildDirPath,
	);
	return { command, toolNames, rspfile };
}

// Joins a build-dir-relative path onto buildDirPath and normalizes ".."
// segments, producing a workspace-relative path. Used for a resolved
// edge's own embedded side effects (see extractCopyDestinations below),
// whose paths are expressed relative to cwd = buildDirPath, not the
// workspace root.
export function joinAndNormalize(baseDir, relativePath) {
	const stack = baseDir
		.split("/")
		.filter((part) => part.length > 0 && part !== ".");
	for (const part of relativePath.split("/")) {
		if (part.length === 0 || part === ".") continue;
		if (part === "..") {
			stack.pop();
		} else {
			stack.push(part);
		}
	}
	return stack.join("/");
}

// A CMakeLists.txt can attach an arbitrary POST_BUILD/PRE_BUILD custom
// command to a target — commonly `cmake -E copy`/`copy_if_different`,
// baked directly into the link rule's resolved command text (via the
// $POST_BUILD/$PRE_LINK variables), copying the built artifact somewhere
// outside ninja's own modeled outputs (e.g. into the source tree). Ninja's
// static graph has no edge for that copy at all, so it isn't something
// reachableEdges/edge.outputs can ever expose — the only way to capture it
// is to recognize the copy *command* itself and pull its destination out
// as an extra thing this edge's run() needs to materialize, alongside its
// normal ninja-modeled outputs.
const CMAKE_COPY_RE = /\bcmake\s+-E\s+copy(?:_if_different)?\s+(\S+)\s+(\S+)/g;

// CMake's Ninja generator stamps every target's own scratch directory,
// `CMakeFiles/<name>.dir/`, into that target's compile/link edges' variables
// (OBJECT_DIR, DEP_FILE, TARGET_COMPILE_PDB, ...) — reliable even when there
// is no separate top-level phony alias for the name (an executable whose
// output filename already equals its target name gets no `build <name>:
// phony ...` alias at all; only a library whose real output differs, e.g.
// `libmylib.so` for target `mylib`, needs one). Scanning for that directory
// stamp instead of relying on phony aliases finds every real target name
// CMake knows about, regardless of which shape its edges take.
//
// Filtered to just the names that reach at least one real (non-phony,
// has-a-command) edge, so bookkeeping-only markers never surface here.
//
// OBJECT_DIR (unlike path tokens elsewhere in this file) comes out of a real
// Windows `cmake -G Ninja` run backslashed (`OBJECT_DIR = CMakeFiles\hello.dir`)
// rather than forward-slashed — a forward-slash-only pattern silently
// matched zero targets on Windows. unescapeNinjaValue() normalizes that away
// at parse time (see its own docstring), so this only ever sees forward
// slashes by the time it runs.
const TARGET_DIR_RE = /CMakeFiles\/([^/]+)\.dir\//;

// Only these CMake target types have a single well-defined build artifact
// worth exposing as its own imp target. OBJECT_LIBRARY (no link step of
// its own), INTERFACE_LIBRARY (no build output at all), UTILITY (custom
// targets — arbitrary, no reliable single output), and anything
// unrecognized are left unexpanded; they're still built as part of the
// parent's own "all" replay whenever something depends on them.
const REAL_TARGET_TYPES = new Set([
	"STATIC_LIBRARY",
	"SHARED_LIBRARY",
	"MODULE_LIBRARY",
	"EXECUTABLE",
]);

export function listNamedCmakeTargets(graph) {
	const { rules, edges, targetTypes } = graph;
	const names = new Set();
	for (const edge of edges) {
		for (const value of Object.values(edge.vars)) {
			const match = TARGET_DIR_RE.exec(value);
			if (match) names.add(match[1]);
		}
	}

	const named = [];
	for (const name of names) {
		const type = targetTypes[name];
		if (!REAL_TARGET_TYPES.has(type)) continue;
		const reached = reachableEdges(edges, [name]).filter(
			(e) => e.rule !== "phony" && rules[e.rule] && rules[e.rule].command,
		);
		if (reached.length === 0) continue;
		// Only the final product(s): outputs consumed as another reached
		// edge's own input (e.g. an intermediate .o file feeding the link
		// edge) are internal build byproducts, not the target's own result.
		const consumed = new Set(
			reached.flatMap((e) => [
				...e.inputs,
				...e.implicitInputs,
				...e.orderOnly,
			]),
		);
		const outputs = Array.from(
			new Set(
				reached
					.flatMap((e) => [...e.outputs, ...e.implicitOutputs])
					.filter((p) => !consumed.has(p)),
			),
		);
		named.push({ name, outputs, type });
	}
	return named;
}

export function extractCopyDestinations(command, buildDirPath) {
	const destinations = new Set();
	let match;
	CMAKE_COPY_RE.lastIndex = 0;
	while ((match = CMAKE_COPY_RE.exec(command)) !== null) {
		const dest = match[2].replace(/^['"]|['"]$/g, "");
		destinations.add(joinAndNormalize(buildDirPath, dest));
	}
	return Array.from(destinations);
}
