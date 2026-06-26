import { target, rule } from "imp:core";

rule({ kind: "odin-package", product: "sources",      action: "snapshot {sources}", requiresOwnSources: false, dependencyProduct: null });
rule({ kind: "odin-package", product: "odin-package", action: "odin build",         requiresOwnSources: true,  dependencyProduct: "default" });

export function odinPackage({ srcs, deps = [] }) {
    return target({ kind: "odin-package", fields: { sources: srcs.join(",") }, deps });
}
