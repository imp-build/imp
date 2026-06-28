Below is the rewritten version using the corrected model:

```text
ordinary functions as the public API
memoized functions as the graph primitive
products as memoized functions with CLI registration
targets as plain data
no providers
no request strings
no ctx.request pattern
sandboxing owned by run(...)
```

Your current implementation already has the ingredients: target constructors, products, source capture, toolchain acquisition, and CAS/sandbox execution. The refactor is mostly about moving from "source/product plumbing as rule graph" to "memoized function calls as graph". In the uploaded code, `readSources()` eagerly captures workspace entries, serializes source manifests, creates `source-set` targets, and `odinPackage()` manually merges transitive source CAS entries into target fields. That is the part to remove from the rule API surface.

# Target API example: Odin

## Build file

The build file should remain simple and script-like:

```ts
import { odin } from "//rules/odin";

export const root_collection = odin.collection({
    name: "root",
    path: ".",
});

export const lib_collection = odin.collection({
    name: "lib",
    path: "lib",
});

export const ottar = odin.package({
    path: "ottar",

    srcs: [
        "^ottar/.*\\.odin$",
    ],

    collections: [
        root_collection,
        lib_collection,
    ],

    deps: [
        // other odin.package targets
    ],

    toolchain: odin.toolchain({
        version: "dev-2026-06-01",
    }),

    default_product: "executable",
});
```

CLI examples:

```sh
imp build //:ottar
imp build //:ottar#executable
imp build //:ottar#library
imp test //:ottar
imp check //:ottar
imp fmt //:ottar
imp sources //:ottar
```

Meaning:

```text
//:ottar                 -> default product
//:ottar#executable      -> odin.executable(ottar)
//:ottar#library         -> odin.library(ottar)
//:ottar#test            -> odin.test(ottar)
//:ottar#format-check    -> odin.format_check(ottar)
//:ottar#sources         -> odin.sources(ottar), if exposed as a CLI product/view
```

# Core model

The public model is function calls:

```ts
const srcs = await odin.sources(pkg);
const flags = await odin.collection_flags(pkg);
const exe = await odin.executable(pkg);
```

The internal model is memoized function execution:

```text
odin.executable(ottar)
  calls odin.sources(ottar)
  calls odin.collection_flags(ottar)
  calls odin.tool(toolchain)
  calls run(...)
```

The graph is discovered by executing memoized functions.

There is no public:

```ts
ctx.request(pkg, "odin.sources");
```

and no hidden stringly request layer in the rule API.

# Core primitives

## `target`

A target is plain declared data with stable identity.

```ts
type Target<TAttrs = unknown> = {
    __imp: true;
    label: Label;
    kind: string;
    attrs: TAttrs;
};
```

Constructor:

```ts
function target<TAttrs>(opts: {
    kind: string;
    attrs: TAttrs;
}): Target<TAttrs> {
    // Assign label from export binding / package context.
    // Store kind + attrs as plain serializable data.
}
```

## `memo`

`memo` turns an ordinary async function into a cached build function.

```ts
function memo<F extends (...args: any[]) => Promise<any>>(
    fn: F,
): F {
    const function_id = stable_function_id(fn);

    return async function memoized(...args: any[]) {
        const ctx = current_eval_context();

        const key = {
            function_id,
            args_digest: stable_digest(args),
            config_digest: ctx.config_digest,
        };

        return ctx.memo_eval(key, async () => {
            ctx.push_call(key);
            try {
                return await fn(...args);
            } finally {
                ctx.pop_call();
            }
        });
    } as F;
}
```

Cache identity is based on:

```text
function identity
arguments
configuration
tracked effects
called memo functions
actions created by run(...)
```

## `product`

`product` is `memo` plus CLI registration.

```ts
function product<F extends (target: Target, ...args: any[]) => Promise<any>>(
    target_kind: string,
    product_name: string,
    fn: F,
): F {
    const memoized = memo(fn);

    register_product({
        target_kind,
        product_name,
        invoke: memoized,
    });

    return memoized;
}
```

So this:

```ts
export const executable = product("odin-package", "executable",
    async function executable(pkg) {
        ...
    }
);
```

does two things:

```text
1. Allows normal calls:
   await odin.executable(pkg)

2. Allows CLI selection:
   imp build //:pkg#executable
```

## `run`

`run` is the only place where execution and sandboxing happen.

```ts
function run(opts: {
    mnemonic: string;
    display?: string;
    argv: string[];
    env?: Record<string, string>;
    tools?: Tool[];
    inputs?: ActionInput[];
    outputs?: Output[];
    sandbox?: boolean;
}): Promise<ArtifactResult> {
    // Records an action dependency on the current memo/product call.
    // Materializes FileSet/Tool/Artifact inputs later.
    // Owns sandbox/CAS/remote execution details.
}
```

Rule packages do not call:

```ts
casTreeStore(...)
casTreeMerge(...)
```

Those remain executor internals. Your current code exposes these through `sourceSetExec()` and `snapshotSourcesExec()`, which is the thing to eliminate from the Odin rule package.

# Odin rule package example

## Target constructors

```ts
import {
    target,
    memo,
    product,
    glob,
    file_set,
    run,
    output,
    group,
    paths,
    workspace_mutation,
} from "imp:core";

export namespace odin {
    export type ToolchainAttrs = {
        version: string;
    };

    export type CollectionAttrs = {
        name: string;
        path: string;
    };

    export type PackageAttrs = {
        path: string;
        srcs: string[];
        exclude: string[];
        deps: Target<PackageAttrs>[];
        collections: Target<CollectionAttrs>[];
        toolchain: Target<ToolchainAttrs>;
        default_product: string;
    };

    export function toolchain(opts: {
        version?: string;
    }): Target<ToolchainAttrs> {
        return target({
            kind: "odin-toolchain",
            attrs: {
                version: opts.version ?? "default",
            },
        });
    }

    export function default_toolchain(): Target<ToolchainAttrs> {
        return toolchain({
            version: "default",
        });
    }

    export function collection(opts: {
        name: string;
        path: string;
    }): Target<CollectionAttrs> {
        return target({
            kind: "odin-collection",
            attrs: {
                name: opts.name,
                path: opts.path,
            },
        });
    }

    export function package(opts: {
        path?: string;
        srcs: string[];
        exclude?: string[];
        deps?: Target<PackageAttrs>[];
        collections?: Target<CollectionAttrs>[];
        toolchain?: Target<ToolchainAttrs>;
        default_product?: string;
    }): Target<PackageAttrs> {
        return target({
            kind: "odin-package",
            attrs: {
                path: opts.path ?? ".",
                srcs: opts.srcs,
                exclude: opts.exclude ?? [],
                deps: opts.deps ?? [],
                collections: opts.collections ?? [],
                toolchain: opts.toolchain ?? default_toolchain(),
                default_product: opts.default_product ?? "executable",
            },
        });
    }
}
```

# Odin memoized functions

These are not providers and not requests. They are just functions, marked as memoized build functions.

## Own sources

```ts
export const own_sources = memo(async function own_sources(
    pkg: Target<odin.PackageAttrs>,
): Promise<FileSet> {
    return glob({
        root: pkg.attrs.path,
        include: pkg.attrs.srcs,
        exclude: pkg.attrs.exclude,
    });
});
```

This replaces eager `workspaceSourceEntries(...)` in `readSources()`. Today, `readSources()` captures entries immediately and stores the CAS list and manifest in target fields. That should become a lazy tracked `glob(...)` inside a memoized function.

## Transitive sources

```ts
export const sources = memo(async function sources(
    pkg: Target<odin.PackageAttrs>,
): Promise<FileSet> {
    const own = await own_sources(pkg);

    const dep_sources = await Promise.all(
        pkg.attrs.deps.map(dep => sources(dep))
    );

    return file_set.union(own, ...dep_sources);
});
```

This replaces the current manual transitive merge:

```text
odinPackage()
  -> sourceTarget
  -> dep.transitiveSources
  -> merge(sourceTarget, ...odinDepSources)
  -> sourceManifestValue
```

That current merge is visible in `odinPackage()`, where it extracts `transitiveSources` from dependency target handles and creates a merged source manifest.

## Collection flags

```ts
export const collection_flags = memo(async function collection_flags(
    pkg: Target<odin.PackageAttrs>,
): Promise<string[]> {
    return pkg.attrs.collections.map(collection =>
        `-collection:${collection.attrs.name}=${collection.attrs.path}`
    );
});
```

Your current `odinCollectionExec()` does no work because collections are semantic metadata, not actions. That is a strong sign they should be plain target data plus memoized functions, not exec rules.

## Tool acquisition

```ts
export const tool = memo(async function tool(
    tc: Target<odin.ToolchainAttrs>,
): Promise<Tool> {
    const version = resolveOdinToolchainVersion(tc.attrs.version);

    return acquireOdinToolchainAsTool({
        version,
        name: "odin",
    });
});
```

This keeps the existing toolchain acquisition concept, but exposes it as a memoized function instead of an exec rule whose product is `"tool"`.

# Odin products

Products are functions too. They are just registered for CLI dispatch.

## Executable

```ts
export const executable = product("odin-package", "executable",
    async function executable(
        pkg: Target<odin.PackageAttrs>,
    ): Promise<Artifact> {
        const srcs = await sources(pkg);
        const flags = await collection_flags(pkg);
        const odin_bin = await tool(pkg.attrs.toolchain);

        return run({
            mnemonic: "OdinBuildExecutable",
            display: `odin build ${pkg.label}`,
            argv: [
                odin_bin.path,
                "build",
                pkg.attrs.path,
                ...flags,
                `-out:${output_path("bin/" + pkg.label.name)}`,
            ],
            tools: [odin_bin],
            inputs: [srcs],
            outputs: [
                output("bin/" + pkg.label.name),
            ],
            sandbox: true,
        });
    }
);
```

## Library

```ts
export const library = product("odin-package", "library",
    async function library(
        pkg: Target<odin.PackageAttrs>,
    ): Promise<Artifact> {
        const srcs = await sources(pkg);
        const flags = await collection_flags(pkg);
        const odin_bin = await tool(pkg.attrs.toolchain);

        return run({
            mnemonic: "OdinBuildLibrary",
            display: `odin build library ${pkg.label}`,
            argv: [
                odin_bin.path,
                "build",
                pkg.attrs.path,
                ...flags,
                "-build-mode:obj",
                `-out:${output_path("lib/" + pkg.label.name + ".o")}`,
            ],
            tools: [odin_bin],
            inputs: [srcs],
            outputs: [
                output("lib/" + pkg.label.name + ".o"),
            ],
            sandbox: true,
        });
    }
);
```

## Test

```ts
export const test = product("odin-package", "test",
    async function test(
        pkg: Target<odin.PackageAttrs>,
    ): Promise<TestResult> {
        const srcs = await sources(pkg);
        const flags = await collection_flags(pkg);
        const odin_bin = await tool(pkg.attrs.toolchain);

        return run({
            mnemonic: "OdinTest",
            display: `odin test ${pkg.label}`,
            argv: [
                odin_bin.path,
                "test",
                pkg.attrs.path,
                ...flags,
            ],
            tools: [odin_bin],
            inputs: [srcs],
            outputs: [
                output("test-results/" + pkg.label.name + ".json", {
                    optional: true,
                }),
            ],
            sandbox: true,
        });
    }
);
```

## Format check

```ts
export const format_check = product("odin-package", "format-check",
    async function format_check(
        pkg: Target<odin.PackageAttrs>,
    ): Promise<CheckResult> {
        const srcs = await own_sources(pkg);
        const odin_bin = await tool(pkg.attrs.toolchain);

        return run({
            mnemonic: "OdinFmtCheck",
            display: `odin fmt -check ${pkg.label}`,
            argv: [
                odin_bin.path,
                "fmt",
                "-check",
                ...paths(srcs),
            ],
            tools: [odin_bin],
            inputs: [srcs],
            outputs: [],
            sandbox: true,
        });
    }
);
```

## Format mutation

Formatting that modifies the workspace should not be a normal cacheable action.

```ts
export const format = product("odin-package", "format",
    async function format(
        pkg: Target<odin.PackageAttrs>,
    ): Promise<MutationResult> {
        const srcs = await own_sources(pkg);
        const odin_bin = await tool(pkg.attrs.toolchain);

        return workspace_mutation({
            mnemonic: "OdinFmt",
            display: `odin fmt ${pkg.label}`,
            argv: [
                odin_bin.path,
                "fmt",
                ...paths(srcs),
            ],
            tools: [odin_bin],
            inputs: [srcs],
        });
    }
);
```

## Check aggregate

```ts
export const check = product("odin-package", "check",
    async function check(
        pkg: Target<odin.PackageAttrs>,
    ): Promise<CheckResult> {
        return group([
            format_check(pkg),
            test(pkg),
        ]);
    }
);
```

# What the graph looks like

Command:

```sh
imp check //:ottar
```

CLI dispatch:

```text
resolve //:ottar
read default or explicit product
call odin.check(ottar)
```

Discovered function graph:

```text
odin.check(ottar)
  -> odin.format_check(ottar)
      -> odin.own_sources(ottar)
          -> glob(root = "ottar", include = ["^ottar/.*\\.odin$"])
      -> odin.tool(ottar.toolchain)
      -> run(OdinFmtCheck)

  -> odin.test(ottar)
      -> odin.sources(ottar)
          -> odin.own_sources(ottar)
          -> odin.sources(depA)
          -> odin.sources(depB)
      -> odin.collection_flags(ottar)
      -> odin.tool(ottar.toolchain)
      -> run(OdinTest)
```

Cache graph:

```text
Memo(odin.check, ottar)
Memo(odin.format_check, ottar)
Memo(odin.own_sources, ottar)
Memo(odin.test, ottar)
Memo(odin.sources, ottar)
Memo(odin.collection_flags, ottar)
Memo(odin.tool, toolchain)
Action(OdinFmtCheck)
Action(OdinTest)
```

No providers. No request strings. No source-set products.

# How sandboxing works

The product function says:

```ts
return run({
    inputs: [srcs],
    tools: [odin_bin],
    sandbox: true,
    ...
});
```

The executor owns the lowering:

```text
FileSet -> resolved files + digests
Tool -> executable files + runtime files
Artifact -> produced output tree
ActionInput[] -> sandbox tree or CAS upload
```

Possible implementations:

```text
local sandbox with symlinks
local sandbox with hardlinks
local sandbox with copies
CAS tree
remote execution upload
debug manifest
```

Rule code does not know or care.

# Roadmap

## Phase 0: Freeze terms

Use these terms consistently:

| Term               | Meaning                                             |
| ------------------ | --------------------------------------------------- |
| target             | Plain declared data with stable label, kind, attrs  |
| memo function      | Cached build function                               |
| product function   | Memo function registered for CLI selection          |
| action             | Concrete `run(...)` execution                       |
| FileSet            | Lazy tracked file collection                        |
| workspace mutation | Explicit non-cacheable workspace-changing operation |

Avoid these as user/rule concepts:

```text
provider
query
request
dependencyProduct
depOutputs
sourceManifestValue
CAS tree merge
```

These may still exist internally, but not as the rule author model.

## Phase 1: Add `memo(fn)`

Implement memoized function evaluation.

Minimum requirements:

```text
stable function identity
stable argument digest
active evaluation context
memo table
cycle detection
dependency recording between memo calls
debug trace
```

Initial key:

```text
MemoKey {
    function_id
    args_digest
    config_digest
}
```

Output:

```text
MemoKey -> result + dependencies
```

## Phase 2: Add `product(kind, name, fn)`

Implement product functions as:

```text
memo(fn) + CLI registration
```

Product registration table:

```text
(target_kind, product_name) -> function
```

CLI dispatch:

```text
imp build //:ottar#test
  -> target kind = odin-package
  -> product name = test
  -> call odin.test(ottar)
```

Default product:

```text
target.attrs.default_product
or target kind default
```

## Phase 3: Add tracked runtime APIs

Inside `memo` and `product` functions, provide tracked versions of effects:

```ts
glob(...)
read_file(...)
env(...)
which(...)
run(...)
workspace_mutation(...)
```

Ban or lint untracked APIs inside memo/product functions:

```ts
fs.readFileSync(...)
fs.readdirSync(...)
process.env.X
Date.now()
Math.random()
child_process.execSync(...)
```

The rule:

```text
ordinary language for composition
tracked APIs for observation and effects
```

## Phase 4: Add lazy `FileSet`

Introduce:

```ts
type FileSet =
    | GlobFileSet
    | UnionFileSet
    | LiteralFileSet
    | GeneratedFileSet;
```

Operations:

```ts
glob(spec): FileSet
file_set.union(...sets): FileSet
paths(fileset): string[]
```

`paths(fileset)` should be allowed only when the current execution mode can provide stable paths. For sandboxed actions, the executor may rewrite paths at materialization time.

Track invalidation for:

```text
matched file digest
directory listings
new matching files
deleted matching files
exclude/include pattern changes
negative path checks
```

## Phase 5: Move CAS and sandboxing behind `run`

Change action inputs to accept:

```ts
FileSet
Tool
Artifact
LiteralFile
```

Then materialize them in the executor.

Refactor away from rule-level calls to:

```ts
casTreeStore(...)
casTreeMerge(...)
```

Your current `sourceSetExec()` and `snapshotSourcesExec()` are executor concerns exposed as build rules. Move that logic behind `run(...)` input materialization.

## Phase 6: Port Odin source logic

Replace:

```text
readSources()
source-set target
source-set product
snapshotSourcesExec()
merge(...source artifacts)
sourceManifest
sourceManifestValue
transitiveSources target fields
```

with:

```ts
odin.own_sources(pkg)
odin.sources(pkg)
```

Target constructor becomes only:

```ts
export function package(opts) {
    return target({
        kind: "odin-package",
        attrs: normalize_package_opts(opts),
    });
}
```

No eager source scanning.

## Phase 7: Port Odin collections

Replace no-op collection exec rule with plain target data and functions.

Current behavior:

```text
odin-collection target exists only to represent name/path
exec does nothing
```

New behavior:

```ts
odin.collection(...)
odin.collection_flags(pkg)
```

No action needed.

## Phase 8: Port Odin toolchain

Move toolchain acquisition into a memoized function:

```ts
odin.tool(toolchain)
```

Then products call:

```ts
const odin_bin = await odin.tool(pkg.attrs.toolchain);
```

If tool acquisition itself creates files, it can internally call `run(...)` or a special tool acquisition primitive.

## Phase 9: Port products

Implement:

```ts
odin.executable
odin.library
odin.test
odin.format_check
odin.format
odin.check
```

as product functions.

At this point, requested work is dynamic:

```text
If user asks for format-check:
  only own_sources + tool + fmt action happen

If user asks for test:
  sources + collections + tool + test action happen

If user asks for executable:
  sources + collections + tool + build action happen
```

## Phase 10: Add graph introspection

This model needs strong debugging.

Commands:

```sh
imp explain //:ottar#test
imp graph //:ottar#test
imp inputs //:ottar#test
imp actions //:ottar#test
imp files //:ottar#sources
```

Example output:

```text
odin.test(//:ottar)
  calls odin.sources(//:ottar)
  calls odin.collection_flags(//:ottar)
  calls odin.tool(//toolchains:odin)
  creates action OdinTest
```

Also expose cache diagnostics:

```text
cache hit: odin.own_sources(//:ottar)
cache miss: odin.sources(//:ottar), dep changed
cache hit: odin.tool(default)
action hit: OdinTest
```

## Phase 11: Add correctness checks

Add optional validation modes:

```text
sandbox strict mode:
  action can only read declared materialized inputs

trace mode:
  compare observed reads with declared inputs

dirty workspace mode:
  detect changed files during action

untracked effect lint:
  detect process.env, fs.*, Date.now, random, child_process
```

This is especially important because the API looks scripted. The runtime must prevent hidden observations from bypassing the memo graph.

## Phase 12: Delete old source/product plumbing

Once Odin is ported, remove or demote:

```text
requiresOwnSources
dependencyProduct
depOutputs
source-set as rule kind
source-set as product
sourceManifestValue as target field
target-time workspaceSourceEntries
CAS merge from rule packages
```

Keep CAS, manifests, and tree merging only as executor internals.

# Final shape

The end-state model is:

```text
Build files:
  ordinary code that creates targets

Rule packages:
  ordinary exported functions

Memo functions:
  cached build computations

Product functions:
  memo functions registered for CLI products

Actions:
  run(...) calls created from product functions

Sandboxing:
  executor-owned materialization of FileSet/Tool/Artifact inputs

Graph:
  discovered from memoized function calls and tracked effects
```

The Odin example becomes:

```ts
const srcs = await odin.sources(pkg);
const flags = await odin.collection_flags(pkg);
const odin_bin = await odin.tool(pkg.attrs.toolchain);

return run({
    argv: [odin_bin.path, "build", pkg.attrs.path, ...flags],
    tools: [odin_bin],
    inputs: [srcs],
    outputs: [output("bin/" + pkg.label.name)],
    sandbox: true,
});
```

That is the intended shape: plain functions at the API level, memoized function graph underneath, products only where they are user-visible, and sandbox/CAS behavior hidden below `run(...)`.
