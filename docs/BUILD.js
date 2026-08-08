import {
    configurationSchemas,
    files,
    label,
    memo,
    output,
    ruleCapabilities,
    read_file,
    run,
    runGoal,
    task,
    BUILD,
    PACKAGE,
} from "imp:core";

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
import { nativeTool } from "//rules/imp/native-tool";
import { extractCodeReference, extractUserApiReference } from "//docs/js_api_extract";
import { zolaBin, zolaGraphTool, zolaToolchain } from "//rules/zola";

export const rules_test = rulesTest({ root: "//docs" });

// The dist/ destination the generic graphPackageGoal (rules/workflows/package)
// publishes //docs:site to, derived the same way it derives every graph
// package root's destination from its address (//docs:site -> dist/docs/site).
const SITE_DIST_PATH = "dist/docs/site";

const mkdirTool = nativeTool("mkdir");
const cpTool = nativeTool("cp");
const dirnameTool = nativeTool("dirname");

zolaToolchain("0.22.1", { default: true });

const apiReferenceSources = files({
    root: ".",
    include: ["src/imp_core.js", "src/graph_core.js", "rules/**/*.js", "rules/**/DOC.md"],
    exclude: ["**/*_test.js"],
});

const api_reference_build = task({
    display: "extract JS API reference",
    inputs: { sources: apiReferenceSources, mkdir: mkdirTool, dirname: dirnameTool },
    outputs: { dir: output.artifact() },
    async run(exec, { sources, mkdir, dirname }) {
        const srcPaths = exec.paths(sources).slice().sort();
        const entries = srcPaths.map((sourcePath) => ({ sourcePath, sourceText: read_file(sourcePath) }));
        const jsFiles = entries.filter(({ sourcePath }) => sourcePath.endsWith(".js"));
        const guides = entries.filter(({ sourcePath }) => sourcePath.endsWith("/DOC.md"));
        const pages = [
            ...extractCodeReference(jsFiles).map(({ path, markdown }) => [`js-api/${path}`, markdown]),
            ...extractUserApiReference(jsFiles, configurationSchemas(), ruleCapabilities(), guides).map(({ path, markdown }) => [`user-api/${path}`, markdown]),
        ];

        const script = 'out=$1; shift; mkdir -p "$out"; while [ "$#" -gt 0 ]; do name=$1; content=$2; shift 2; mkdir -p "$out/$(dirname "$name")"; printf "%s" "$content" > "$out/$name"; done';
        const argv = ["sh", "-c", script, "docs-api-reference", "out"];
        for (const [name, content] of pages) {
            argv.push(name, content);
        }

        const result = await exec.action({
            argv,
            tools: [mkdir, dirname],
            outputs: { dir: output.directory("out") },
        });
        return { dir: result.outputs.dir };
    },
});

export const api_reference = Object.freeze({
    dir: api_reference_build.outputs.dir,
    [BUILD]: api_reference_build.outputs.dir,
});

const siteSources = files({
    root: ".",
    include: ["docs/config.toml", "docs/content/**", "docs/templates/**", "docs/static/**"],
});

const site_build = task({
    display: "build docs site with zola",
    inputs: { handWritten: siteSources, apiRef: api_reference.dir, zola: zolaGraphTool(), mkdir: mkdirTool, cp: cpTool },
    outputs: { dir: output.artifact() },
    async run(exec, { handWritten, apiRef, zola, mkdir, cp }) {
        const zolaExe = exec.tool(zola, "zola");
        const script = [
            "root=$1; apiref=$2; zola_bin=$3",
            'mkdir -p "$root/content/reference/js-api" "$root/content/reference/user-api" "$root/templates" "$root/static"',
            'cp docs/config.toml "$root/config.toml"',
            'cp -r docs/content/. "$root/content/"',
            'cp -r docs/templates/. "$root/templates/"',
            'cp -r docs/static/. "$root/static/"',
            'cp -r "$apiref/js-api/." "$root/content/reference/js-api/"',
            'cp -r "$apiref/user-api/." "$root/content/reference/user-api/"',
            '"$zola_bin" --root "$root" build --output-dir "$root/public"',
        ].join(" && ");

        const result = await exec.action({
            argv: ["sh", "-c", script, "docs-zola-site", "site", exec.path(apiRef), zolaExe],
            tools: [mkdir, cp],
            inputs: [handWritten, apiRef],
            outputs: { dir: output.directory("site") },
        });
        return { dir: result.outputs.dir };
    },
});

export const site = Object.freeze({
    [BUILD]: site_build.outputs.dir,
    [PACKAGE]: site_build.outputs.dir,
});

// `imp run //docs:site_serve` supervises a "serve while editing" loop: every
// second it re-invokes the fully-sandboxed, cache-backed `package` goal for
// //docs:site (which writes the built site to dist/site, via the generic
// graphPackageGoal now that site's build/package are graph-native — see
// rules/workflows/package/index.js), and restarts `zola serve` only when the
// rebuilt output actually changed. This is a separate legacy label() (rather
// than living on the graph-native `site` export above) because a graph-native
// [RUN] root can only mean "execute a built artifact once" (see
// rules/odin/index.js's `actions[RUN] = build.outputs.artifact`) — there is
// no graph-native equivalent for an impure, long-lived, self-restarting
// supervisor process; exec.action() is always sandboxed with
// materialize:false. Tracked as a follow-up engine gap rather than solved
// here (mirrors the CMake resource-bridge gap tracked as issue #69).
//
// The supervisor itself runs sandbox:false/impure:true (mirroring odinRun,
// rules/odin/index.js) since it's long-lived and manages a child process —
// but it never touches the repo directly beyond dist/; all repo-adjacent
// work stays exactly as sandboxed as the "build"/"package" goals above. A
// single sandboxed `zola serve` can't hot-reload on real edits: run()'s
// sandbox copies declared inputs once at start (src/exec.rs's
// copy_file/copy_directory) rather than giving a live view, and there's no
// cancelable background-run handle to restart it from within one sandboxed
// call — so this restart-on-change loop is the closest fit without new
// engine primitives.
export const site_serve = label();

const site_serve_loop = memo(async function site_serve_loop() {
    const zolaBinPath = await zolaBin();

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
        argv: ["sh", "-c", script, "docs-watch-serve", globalThis.__imp_self_bin, SITE_DIST_PATH, zolaBinPath],
        sandbox: false,
        impure: true,
        display: "watch + serve docs site with zola",
    });
}, { display: "watch + serve docs site", level: "info" });

runGoal(site_serve, async function runSiteServe() {
    return site_serve_loop();
});
