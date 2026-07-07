import { Target, product, run, output, output_path } from "imp:core";

export const file = product("stamp-file", "build", async function file(handle) {
    return run({
        argv: [
            "sh",
            "-c",
            "printf '%s\\n' \"$2\" > \"$1\"",
            "imp-stamp",
            output_path(handle.attrs.entrypoint),
            handle.attrs.sources,
        ],
        outputs: [output(handle.attrs.entrypoint)],
        materialize: true,
        display: `write ${handle.attrs.entrypoint}`,
    });
});

export class StampFile extends Target {
    static kind = "stamp-file";
    constructor({ output, text }) {
        super({
            kind: StampFile.kind,
            attrs: { entrypoint: output, sources: text },
        });
    }
}

export function stampFile({ output, text }) {
    return new StampFile({ output, text });
}
