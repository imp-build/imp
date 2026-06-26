import { target, rule } from "imp:core";

// ---------------------------------------------------------------------------
// Exec functions for asset rules
// ---------------------------------------------------------------------------

function snapshotSourcesExec(target, ctx) {
    // Sources are on disk; this task exists to wire up the dependency graph.
}

function bundleExec(target, ctx) {
    // Bundle assets — currently a placeholder.
    // A real implementation would copy/optimize the source assets into an output bundle.
    const result = ctx.run({
        argv: ["cp", "-r", ...target.fields.sources.split(","), "build"],
        display: `bundle ${target.fields.sources}`,
    });
    if (result.exitCode !== 0) {
        throw new Error(`bundle failed (exit ${result.exitCode}): ${result.stderr}`);
    }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

rule({
    kind: "asset",
    product: "sources",
    action: "snapshot {sources}",
    exec: snapshotSourcesExec,
    requiresOwnSources: false,
    dependencyProduct: null,
});

rule({
    kind: "asset",
    product: "bundle",
    action: "bundle {sources}",
    exec: bundleExec,
    requiresOwnSources: true,
    dependencyProduct: null,
});

// ---------------------------------------------------------------------------
// Target constructors
// ---------------------------------------------------------------------------

export function asset({ srcs }) {
    return target({ kind: "asset", fields: { sources: srcs.join(",") } });
}
