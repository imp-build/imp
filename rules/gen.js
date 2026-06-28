import { target, rule } from "imp:core";

rule({
    kind: "stamp-file",
    product: "file",
    action: {
        argv: [
            "sh",
            "-c",
            "mkdir -p \"$(dirname \"$1\")\" && printf '%s\\n' \"$2\" > \"$1\"",
            "imp-stamp",
            "{entrypoint}",
            "{sources}",
        ],
        outputs: [{ kind: "file", path: "{entrypoint}" }],
        display: "write {entrypoint}",
    },
    requiresOwnSources: false,
    dependencyProduct: null,
});

export function stampFile({ output, text }) {
    return target({
        kind: "stamp-file",
        attrs: { entrypoint: output, sources: text },
    });
}
