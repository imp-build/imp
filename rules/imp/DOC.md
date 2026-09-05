The imp rules are the language-neutral layer the other rule namespaces are
built on. They declare tools, acquire and read back toolchains, generate files
into the graph or into the workspace, define build-mode profiles, and run the
rule library's own JavaScript tests. Nothing here is specific to a language, and
the namespace registers no product, so it adds no `imp <goal>` of its own — a
language rule imports these helpers and supplies the goals.

| Module | What it gives you |
| --- | --- |
| `//rules/imp/native-tool` | An executable resolved from the host PATH |
| `//rules/imp/self-tool` | A tool handle for the running imp executable |
| `//rules/imp/codegen` | Generated sources that stay in the graph |
| `//rules/imp/generate` | Generated files written into the workspace |
| `//rules/imp/lockfile` | Lockfile resolution and verified downloads |
| `//rules/imp/archive` | Archive extraction into a directory artifact |
| `//rules/imp/toolchain` | The host path of an installed toolchain |
| `//rules/imp/mode` | The `opt` axis and the `default`/`release` profiles |
| `//rules/imp/test` | `rulesTest()` and the rule-test harness |

## What the sandbox gives an action

Two properties hold for every action, and the rest of this document depends on
them.

**Every executable must be declared.** An action's PATH is composed only from
the bin directories of its declared `tools`, so a command that is not declared
cannot be found — the host's own PATH is never searched. The one exception is a
bare `sh` in `argv[0]`, which the executor resolves from a fixed list of
absolute paths (`/bin/sh`, `/usr/bin/sh`, and the Git/MSYS locations on
Windows). Because that list is host-dependent on Windows, a rule that must run
there declares `sh` as a native tool as well; see `lockedDownloadTools()`.

**Output directories exist before the program starts.** For each declared
output the executor creates the parent directory of a file or manifest output,
and the directory itself for a directory output. An action never needs `mkdir`
or `dirname` for its own declared outputs, and a nested output path such as
`app/generated/bindings.odin` needs no preparation.

## Declare a tool

`nativeTool(name)` declares an executable that is looked up on the host PATH.
The lookup is lazy and the resolved descriptor is keyed on PATH, so a different
host resolution environment cannot reuse an earlier host's answer.

```js
import { nativeTool } from "//rules/imp/native-tool";

const python3 = nativeTool("python3");
```

The returned value is a graph tool handle: pass it as a task input and use
`exec.tool(resolved.python3, "python3")` to get the path inside the sandbox.
`nativeToolSpec(spec)` resolves the same handle into the descriptor that legacy
`run({ tools })` consumers expect.

To invoke imp itself — a JavaScript generator, a nested goal — use the handle
for the running executable:

```js
import { impTool } from "//rules/imp/self-tool";
```

## Generate a file

Three surfaces write files. They differ in where the output goes, and that
difference is the whole choice:

| Surface | Where the output goes | Reach for it when |
| --- | --- | --- |
| `codegen()` (`//rules/imp/codegen`) | the graph | a package consumes the generated sources; nothing lands on disk |
| `generatedFiles()` (`//rules/imp/generate`) | the workspace | the file is committed and CI checks it for drift |
| `stampFile()` (`//rules/gen`) | the graph | the content is fixed text, not the output of a program |

### The `codegen()` contract

`codegen()` runs a generator in a sandboxed action and hands each output back
as an artifact handle a language rule takes as a declared source.

```js
import { codegen } from "//rules/imp/codegen";
import { nativeTool } from "//rules/imp/native-tool";
import { odinPackage } from "//rules/odin";
import { files } from "imp:core";

const bindings = codegen({
    display: "generate Odin bindings",
    tools: { python3: nativeTool("python3") },
    inputs: { schema: files({ root: ".", include: ["schema.json"] }) },
    outputPaths: ["app/generated/bindings.odin"],
    argv: (exec, { python3 }) => [
        exec.tool(python3, "python3"),
        "tools/schema_to_odin.py",
        "schema.json",
        "app/generated/bindings.odin",
    ],
});

export const app = odinPackage({
    path: "app",
    exclude: ["generated/bindings.odin"],
    generatedSrcs: [bindings],
});
```

A caller can rely on these properties:

- **One handle per path, at construction.** The result is a frozen
  `{ paths, files, [CODEGEN], [BUILD] }`, where `files[path]` is the artifact
  handle for that output path. The handles exist while the graph is still being
  built, which is what lets a package name one as a source.
- **The tools are the ones you declare.** Every executable the generator runs
  comes from `tools`, addressed through `exec.tool()`. An undeclared command is
  not on PATH.
- **The output parent directory exists.** A nested `outputPaths` entry needs no
  `mkdir` in the generator.
- **`outputPaths` are workspace-relative, and they are the contract.** A
  consuming package stages each artifact at exactly that path, so one path has
  exactly one owner: exclude a generated path from any glob that would also
  claim it. A language rule checks this — `odinPackage` fails the build when a
  `generatedSrcs` artifact's real path differs from its declared path.
- **`[BUILD]` is a bare completion handle.** `imp build` on the target runs the
  generator and warms the cache. It writes nothing into the workspace; that is
  `imp generate`'s job, and a different declaration.

`codegen()` rejects an empty or missing `outputPaths`, an `argv` that is not a
function, a repeated output path, the reserved input name `outputPaths`, and a
name used in both `tools` and `inputs`.

There is no JavaScript-callback generator form, on purpose: it would run
workspace code inside the build engine instead of in the sandbox. A JavaScript
generator is a command like any other — use `impTool` as `argv[0]`.

### `generatedFiles()`, for committed files

`generatedFiles()` takes the same authoring surface and returns the
`[GENERATE]` root behind `imp generate`. Its outputs are written into the
workspace at the workflow boundary, which makes it the surface for generated
files that are committed and drift-gated. The generator itself stays hermetic
and knows nothing about the `check` flag, so `imp generate` and
`imp generate --check` share one cache entry.

```js
import { generatedFiles } from "//rules/imp/generate";
import { GENERATE } from "//rules/workflows/generate";
import { nativeTool } from "//rules/imp/native-tool";
import { file } from "imp:core";

export const docs_workflow = {
    [GENERATE]: generatedFiles({
        display: "generate GitHub workflows",
        tools: { python3: nativeTool("python3") },
        inputs: { script: file(SCRIPT) },
        outputPaths: [".github/workflows/docs.yml"],
        argv: (exec, { python3 }) => [
            exec.tool(python3, "python3"),
            SCRIPT,
            ".github/workflows/docs.yml",
        ],
    }),
};
```

`//ci:docs_workflow` in `ci/BUILD.js` is that real example. CI runs
`imp generate //ci:docs_workflow --check`, which fails when the committed file
differs from what the generator produces. Do not hand-edit a file declared this
way: change the generator and run `imp generate`.

`generatedFileIsStale(path, digest)` reports whether the generated content at
`digest` differs from the file on disk. A missing file counts as stale.

### `stampFile()`, for fixed text

```js
import { stampFile } from "//rules/gen";

export const version = stampFile({ output: "build/version.txt", text: "1.4.0" });
```

`stampFile()` produces a graph artifact holding fixed text. It is a degenerate
generator: there is no program and no input to read. Its `argv[0]` is a bare
`sh`, which is the resolved built-in shell described above, not an undeclared
tool.

### Why `codegen()` and `generatedFiles()` stay separate

The two declare the same thing — files a command produces — and differ only in
the destination. That difference decides the return shape, and the shape is why
both exist. `generatedFiles()` returns one value handle carrying
`{ paths, files }` that resolves at execution time, which is enough for a goal
that publishes at the workflow boundary. A package needs the artifact for a
given path while the graph is still being constructed, so `codegen()` declares
one output slot per path and returns those handles directly. The split is
deliberate; the shared authoring rules live in one place, `planGeneratedOutputs()`.

Two things here are worth revisiting, and are recorded as follow-up work rather
than settled by this document:

- `stampFile()` lives in `//rules/gen`, outside this namespace, although it is a
  fixed-text `codegen()`.
- `odinPackage` is the only rule that consumes a `codegen()` result today, so
  the helper is language-neutral where it produces and Odin-only where it is
  consumed.

## Acquire a toolchain

A toolchain declares its acquisition as an ordinary graph task: download the
artifact, unpack it, and publish the installed tree in a named cache. These are
plain helpers, not a pipeline — each toolchain owns its flow and adds its own
steps around them.

A tool lockfile pins the download URL, artifact name, size, and SHA-256 for one
tool, per version and per platform. Lockfiles are additive: every version ever
locked stays in the file, so a downgrade to an earlier version resolves without
regenerating anything. Write and update them with `imp goal gen-lockfiles`.

A lockfile is referenced by workspace address, resolved with the same
precedence as a module import: a file under the workspace root wins, and imp's
built-in rules tree is the fallback for `//rules/...`. A lockfile checked in
next to its rule module therefore ships with the rule library, and a consumer
overrides it by placing a file at the same address or pointing the toolchain at
a different one.

```js
import { downloadToolArtifact } from "//rules/imp/lockfile";
import { extractArchive } from "//rules/imp/archive";

const archive = downloadToolArtifact({
    lockfile: "//rules/c/mold/mold.lock",
    tool: "mold",
    version: "2.4.1",
    plat,
    url: FALLBACK_URL,
    output: "download/mold.tar.gz",
});

const installed = extractArchive({
    archive,
    dest: "mold",
    format: "tar.gz",
    stripComponents: 1,
    namedCache: { name: "mold", key: version },
});
```

`downloadToolArtifact()` resolves the lockfile entry, downloads, and verifies
the transfer against the recorded SHA-256 and size. A miss — no lockfile at the
address, the wrong tool, an unlocked version, or no entry for the platform —
throws with a pointer to `gen-lockfiles`. Declaring the toolchain with
`unverified: true` downgrades a miss to a warning and an unverified download.
Use `lockPlat` when the lockfile entry is keyed differently from the host, as
for a platform-independent artifact.

`resolveToolLockfile()` returns the entry alone, for a rule that runs its own
download; `lockedDownloadArgv()` builds the verified download command;
`lockedDownloadTools()` names the native tools that command needs; and
`lockfileAddressToPath()` converts a `//a/b.lock` address to the
workspace-relative path `gen-lockfiles` writes.

`extractArchive()` unpacks `"tar.gz"`, `"tar.xz"`, `"tar"`, `"zip"`, or
`"zip-unix"` into `dest` and returns a directory artifact handle. It owns its
own tools, derived from the format, and rejects a `tools` option. Pass
`namedCache` to publish the extracted tree at a real, absolute, stable path —
which an install must do, because callers outside any sandbox need one.
`extractArchiveTools(format)` names the same tools for a rule that assembles a
larger install action itself. Zip extraction supports only a `stripComponents`
of 1.

## Read an installed toolchain back

A sandboxed consumer never needs these helpers: it declares the tool handle as
a task input and `exec.tool()` gives it a path inside the sandbox. They exist
for callers that live outside any sandbox — `imp @tool`, which executes the
binary through the user's shell, and linker flags that must name an absolute
path.

```js
import { toolchainBin, toolchainDir } from "//rules/imp/toolchain";

const root = await toolchainDir(installHandle, { name: "mold", key: version });
const exe = await toolchainBin(installHandle, {
    name: "mold",
    key: version,
    subDir: "bin",
    exe: "mold",
});
```

Each helper runs the install task if necessary and reads the named cache back.
`toolchainDir()` returns the installed root, `toolchainBin()` one executable in
it, and `toolchainToolSpec()` a `run({ tools })` entry for the remaining legacy
`run()` consumers. Pass a handle the module built when the toolchain was
declared: a task cannot add graph nodes while it is executing, and these
helpers are reachable from inside a task body. They throw when the named cache
is empty after the install task ran, which means the task did not declare
`output.directory(dest, { namedCache })`.

## Select a build mode

Importing `//rules/imp/mode` in `imp.workspace.js` defines the `opt` axis
(`debug` and `release`, defaulting to `debug`) and the two named profiles every
goal in the workspace can select:

```js
import "//rules/imp/mode";
```

```sh
imp build --profile release //path/to:target
```

The `default` profile is deliberately redundant with the axis default: it gives
automation a stable profile name without changing invocations that omit
`--profile`. A task reads the axis with `semantic.mode("opt")`, and only a task
that reads an axis forks per configuration —
`//rules/imp/config/example` is a probe that shows which nodes fork and which
stay shared.

## Test the rules

Each directory of rule sources declares its own test root in its `BUILD.js`.
Only `*_test.js` files directly in that directory are owned; a nested directory
declares its own root.

```js
import { rulesTest } from "//rules/imp/test";
import { nativeTool } from "//rules/imp/native-tool";

export const rules_test = rulesTest({
    root: "//rules/imp",
    tools: [nativeTool("sh")],
});
```

Tests are written with `describe`, `test` (also exported as `it`), and
`expect`. The harness supplies fakes for the engine surfaces a rule touches —
`withFakeRun`, `withFakeDiff`, `withFakeMergeDigests`, `withFakeWriteWorkspace`,
`withFakeGoalFlags`, `withFakeSelectedTargets`, and `withFakeToolchainHost` —
so a test can assert the argv and inputs a rule builds without running anything.

Declare `tools` only for a suite that performs a real PATH lookup instead of
stubbing one: the sandboxed test subprocess has no PATH of its own, so an
undeclared real lookup fails.
