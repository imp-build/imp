import { target, glob, memo, product, run } from "imp:core";

// ---------------------------------------------------------------------------
// Memo/product functions for asset targets
// ---------------------------------------------------------------------------

export const sources = memo(async function sources(handle) {
    return glob({ root: ".", include: handle.attrs.sources || [] });
});

export const bundle = product("asset", "bundle", async function bundle(handle) {
    const srcs = await sources(handle);
    return run({
        argv: ["sh", "-c", "true"],
        inputs: [srcs],
        display: `bundle ${handle.label.name}`,
        impure: true,
    });
});

// ---------------------------------------------------------------------------
// Target constructors
// ---------------------------------------------------------------------------

export function asset({ srcs }) {
    return target({ kind: "asset", attrs: { sources: srcs } });
}
