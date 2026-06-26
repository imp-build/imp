import { target, rule } from "imp:core";

rule({ kind: "cpp-sources",  product: "sources",             action: "snapshot {sources}",        requiresOwnSources: false, dependencyProduct: null });
rule({ kind: "cmake-lib",    product: "native-link-library", action: "cmake --build {entrypoint}", requiresOwnSources: false, dependencyProduct: "sources" });

export function cppSources({ srcs }) {
    return target({ kind: "cpp-sources", fields: { sources: srcs.join(",") } });
}

export function cmakeLib({ entrypoint, deps = [] }) {
    return target({ kind: "cmake-lib", fields: { entrypoint }, deps });
}
