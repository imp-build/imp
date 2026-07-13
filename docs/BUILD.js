import { target, product, run, output, output_path, glob, paths, read_file, writeWorkspace, configurationSchemas, ruleCapabilities } from "imp:core";
import { rulesTest } from "//rules/imp/test";
// The reference catalog describes imp's built-in rules, independently of
// which subset this repository happens to import from imp.workspace.js.
import "//rules/c";
import "//rules/c/cmake";
import "//rules/oci";
import "//rules/odin";
import "//rules/python";
import "//rules/python/test";
import "//rules/rust";
import "//rules/workflows/fmt";
import "//rules/workflows/lint";
import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";
import { extractCodeReference, extractUserApiReference } from "//docs/js_api_extract";
import { zolaToolchain, zolaTool, zolaBin } from "//rules/zola/toolchain";
import { distPathFor } from "//rules/workflows/package";

export const rules_test = rulesTest({ root: "//docs" });

const API_REFERENCE_OUT = "generated/docs-api-reference";
const SITE_OUT = "generated/docs-site";

const mkdirTool = nativeTool("mkdir");
const cpTool = nativeTool("cp");
const dirnameTool = nativeTool("dirname");

zolaToolchain("0.22.1", { default: true });

export const api_reference = target({ kind: "js-api-reference", attrs: {} });

export const api_reference_build = product("js-api-reference", "build", async function api_reference_build(handle) {
    const srcs = glob({
        root: ".",
        include: ["src/imp_core.js", "rules/**/*.js", "rules/**/DOC.md"],
        exclude: ["**/*_test.js"],
    });

    const sources = paths(srcs).slice().sort().map(path => ({ sourcePath: path, sourceText: read_file(path) }));
    const files = sources.filter(({ sourcePath }) => sourcePath.endsWith(".js"));
    const guides = sources.filter(({ sourcePath }) => sourcePath.endsWith("/DOC.md"));
    const pages = [
        ...extractCodeReference(files).map(({ path, markdown }) => [`js-api/${path}`, markdown]),
        ...extractUserApiReference(files, configurationSchemas(), ruleCapabilities(), guides).map(({ path, markdown }) => [`user-api/${path}`, markdown]),
    ];

    const script = 'out=$1; shift; mkdir -p "$out"; while [ "$#" -gt 0 ]; do name=$1; content=$2; shift 2; mkdir -p "$out/$(dirname "$name")"; printf "%s" "$content" > "$out/$name"; done';
    const argv = ["sh", "-c", script, "docs-api-reference", output_path(API_REFERENCE_OUT)];
    for (const [name, content] of pages) {
        argv.push(name, content);
    }

    return run({
        argv,
        tools: [await nativeToolSpec(mkdirTool), await nativeToolSpec(dirnameTool)],
        inputs: [srcs],
        outputs: [output(output_path(API_REFERENCE_OUT), { kind: "directory" })],
        materialize: false,
        display: "extract JS API reference",
    });
});

export const site = target({ kind: "zola-site", attrs: {} });

export const site_build = product("zola-site", "build", async function site_build(handle) {
    const apiRef = await api_reference_build(api_reference);
    const zolaToolSpec = await zolaTool();

    const handWritten = glob({
        root: ".",
        include: ["docs/config.toml", "docs/content/**", "docs/templates/**", "docs/static/**"],
    });

    const script = [
        "root=$1; apiref=$2",
        'mkdir -p "$root/content/reference/js-api" "$root/content/reference/user-api" "$root/templates" "$root/static"',
        'cp docs/config.toml "$root/config.toml"',
        'cp -r docs/content/. "$root/content/"',
        'cp -r docs/templates/. "$root/templates/"',
        'cp -r docs/static/. "$root/static/"',
        'cp -r "$apiref/js-api/." "$root/content/reference/js-api/"',
        'cp -r "$apiref/user-api/." "$root/content/reference/user-api/"',
        'zola --root "$root" build --output-dir "$root/public"',
    ].join(" && ");

    // The API reference is threaded in as a {kind:"digest"} entry — merged
    // straight into this run's sandbox from apiRef's CAS-captured output tree
    // (already rooted at API_REFERENCE_OUT, see nest_directory in
    // src/digest.rs) — rather than reading it back off the workspace, since
    // api_reference_build no longer materializes there.
    return run({
        argv: ["sh", "-c", script, "docs-zola-site", output_path(SITE_OUT), output_path(API_REFERENCE_OUT)],
        tools: [await nativeToolSpec(mkdirTool), await nativeToolSpec(cpTool), zolaToolSpec],
        inputs: [handWritten, { kind: "digest", digest: apiRef.outputDigest }],
        outputs: [output(output_path(SITE_OUT), { kind: "directory" })],
        materialize: false,
        display: "build docs site with zola",
    });
});

export const site_package = product("zola-site", "package", async function site_package(handle) {
    const built = await site_build(handle);
    writeWorkspace(distPathFor(handle), built.outputDigest, { from: SITE_OUT });
});

// `imp run //docs:site` supervises a "serve while editing" loop: every
// second it re-invokes the fully-sandboxed, cache-backed `package` goal
// (which writes the built site to dist/, see site_package above), and
// restarts `zola serve` only when the rebuilt output actually changed. The
// supervisor itself runs sandbox:false/impure:true (mirroring odinRun,
// rules/odin/index.js) since it's long-lived and manages a child process —
// but it never touches the repo directly beyond dist/; all repo-adjacent
// work stays exactly as sandboxed as the "build"/"package" goals above. A
// single sandboxed `zola serve` can't hot-reload on real edits: run()'s
// sandbox copies declared inputs once at start (src/exec.rs's
// copy_file/copy_directory) rather than giving a live view, and there's no
// cancelable background-run handle to restart it from within one sandboxed
// call — so this restart-on-change loop is the closest fit without new
// engine primitives.
export const site_serve = product("zola-site", "run", async function site_serve(handle) {
    const zolaBinPath = await zolaBin();
    const distPath = distPathFor(handle);

    const script = [
        'imp_bin=$1; site_root=$2; zola_bin=$3',
        'last_hash=""',
        'zola_pid=""',
        'cleanup() { [ -n "$zola_pid" ] && kill "$zola_pid" 2>/dev/null; }',
        "trap cleanup EXIT INT TERM",
        "while true; do",
        '    "$imp_bin" package //docs:site >&2 || true',
        '    cur_hash=$(find "$site_root" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d" " -f1)',
        '    if [ "$cur_hash" != "$last_hash" ]; then',
        '        if [ -n "$zola_pid" ]; then kill "$zola_pid" 2>/dev/null; wait "$zola_pid" 2>/dev/null; fi',
        '        "$zola_bin" --root "$site_root" serve &',
        "        zola_pid=$!",
        '        last_hash="$cur_hash"',
        "    fi",
        "    sleep 1",
        "done",
    ].join("\n");

    return run({
        argv: ["sh", "-c", script, "docs-watch-serve", globalThis.__imp_self_bin, distPath, zolaBinPath],
        sandbox: false,
        impure: true,
        display: "watch + serve docs site with zola",
    });
});
