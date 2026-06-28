import { target, product, run, output, output_path } from "imp:core";

export const file = product("stamp-file", "file", async function file(handle) {
    return run({
        argv: [
            "sh",
            "-c",
            "mkdir -p \"$(dirname \"$1\")\" && printf '%s\\n' \"$2\" > \"$1\"",
            "imp-stamp",
            output_path(handle.attrs.entrypoint),
            handle.attrs.sources,
        ],
        outputs: [output(handle.attrs.entrypoint)],
        display: `write ${handle.attrs.entrypoint}`,
    });
});

export function stampFile({ output, text }) {
    return target({
        kind: "stamp-file",
        attrs: { entrypoint: output, sources: text },
    });
}
