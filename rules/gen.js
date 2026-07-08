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

/**
 * Declare a target that writes fixed text to an output file.
 *
 * @category target
 * @param {object} opts
 * @param {string} opts.output Workspace-relative output path.
 * @param {string} opts.text Text to write.
 * @returns {object} Target handle.
 */
export function stampFile({ output, text }) {
    return new StampFile({ output, text });
}
