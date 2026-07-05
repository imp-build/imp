import { target, product, run, output, output_path, glob, paths, read_file } from "imp:core";
import { rulesTest } from "//rules/imp/test";
import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";
import { directoryForSourcePath, extractDirectoryDoc } from "//docs/js_api_extract";
import { zolaToolchain, zolaTool, zolaBin } from "//rules/zola/toolchain";

export const rules_test = rulesTest({ root: "//docs" });

const API_REFERENCE_OUT = "generated/docs-js-api-reference";
const SITE_OUT = "generated/docs-site";

const mkdirTool = nativeTool("mkdir");
const cpTool = nativeTool("cp");

zolaToolchain("0.22.1", { default: true });

export const api_reference = target({ kind: "js-api-reference", attrs: {} });

export const api_reference_build = product("js-api-reference", "build", async function api_reference_build(handle) {
    const srcs = glob({
        root: ".",
        include: ["src/imp_core.js", "rules/**/*.js"],
        exclude: ["rules/**/*_test.js"],
    });

    const byDirectory = new Map();
    for (const path of paths(srcs).slice().sort()) {
        const dir = directoryForSourcePath(path);
        if (!byDirectory.has(dir)) byDirectory.set(dir, []);
        byDirectory.get(dir).push({ sourcePath: path, sourceText: read_file(path) });
    }

    const pages = [];
    for (const [dir, files] of byDirectory) {
        const { slug, markdown } = extractDirectoryDoc(dir, files);
        if (markdown) pages.push([`${slug}.md`, markdown]);
    }

    const script = 'out=$1; shift; mkdir -p "$out"; while [ "$#" -gt 0 ]; do name=$1; content=$2; shift 2; printf "%s" "$content" > "$out/$name"; done';
    const argv = ["sh", "-c", script, "docs-api-reference", output_path(API_REFERENCE_OUT)];
    for (const [name, content] of pages) {
        argv.push(name, content);
    }

    return run({
        argv,
        tools: [await nativeToolSpec(mkdirTool)],
        inputs: [srcs],
        outputs: [output(output_path(API_REFERENCE_OUT), { kind: "directory" })],
        display: "extract JS API reference",
    });
});

export const site = target({ kind: "zola-site", attrs: {} });

export const site_build = product("zola-site", "build", async function site_build(handle) {
    await api_reference_build(api_reference);
    const zolaToolSpec = await zolaTool();

    const handWritten = glob({
        root: ".",
        include: ["docs/config.toml", "docs/content/**", "docs/templates/**", "docs/static/**"],
    });

    const script = [
        "root=$1; apiref=$2",
        'mkdir -p "$root/content/reference/js-api" "$root/templates" "$root/static"',
        'cp docs/config.toml "$root/config.toml"',
        'cp -r docs/content/. "$root/content/"',
        'cp -r docs/templates/. "$root/templates/"',
        'cp -r docs/static/. "$root/static/"',
        'cp -r "$apiref/." "$root/content/reference/js-api/"',
        'zola --root "$root" build --output-dir "$root/public"',
    ].join(" && ");

    return run({
        argv: ["sh", "-c", script, "docs-zola-site", output_path(SITE_OUT), output_path(API_REFERENCE_OUT)],
        tools: [await nativeToolSpec(mkdirTool), await nativeToolSpec(cpTool), zolaToolSpec],
        inputs: [handWritten, { kind: "directory", path: output_path(API_REFERENCE_OUT) }],
        outputs: [output(output_path(SITE_OUT), { kind: "directory" })],
        display: "build docs site with zola",
    });
});

// `imp run //docs:site` supervises a "serve while editing" loop: every
// second it re-invokes the fully-sandboxed, cache-backed `build` goal (which
// only ever writes into generated/, never into the real source tree), and
// restarts `zola serve` only when the rebuilt output actually changed. The
// supervisor itself runs sandbox:false/impure:true (mirroring odinRun,
// rules/odin/index.js) since it's long-lived and manages a child process —
// but it never touches the repo directly; all repo-adjacent work stays
// exactly as sandboxed as the "build" goal above. A single sandboxed `zola
// serve` can't hot-reload on real edits: run()'s sandbox copies declared
// inputs once at start (src/exec.rs's copy_file/copy_directory) rather than
// giving a live view, and there's no cancelable background-run handle to
// restart it from within one sandboxed call — so this restart-on-change
// loop is the closest fit without new engine primitives.
export const site_serve = product("zola-site", "run", async function site_serve() {
    const zolaBinPath = await zolaBin();

    const script = [
        'imp_bin=$1; site_root=$2; zola_bin=$3',
        'last_hash=""',
        'zola_pid=""',
        'cleanup() { [ -n "$zola_pid" ] && kill "$zola_pid" 2>/dev/null; }',
        "trap cleanup EXIT INT TERM",
        "while true; do",
        '    "$imp_bin" build //docs:site >&2 || true',
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
        argv: ["sh", "-c", script, "docs-watch-serve", globalThis.__imp_self_bin, output_path(SITE_OUT), zolaBinPath],
        sandbox: false,
        impure: true,
        display: "watch + serve docs site with zola",
    });
});
