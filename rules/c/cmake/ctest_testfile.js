// Parses CTest's generated CTestTestfile.cmake well enough to recover each
// add_test() call's test name and command — deliberately narrow (same
// philosophy as ninja_graph.js's own doc comment): this only understands the
// exact subset CMake's own CTest integration emits, not CMake's scripting
// language in general. Everything else in the file (set_tests_properties,
// comments, subdirs()) is ignored.
//
// CMake emits three token shapes for add_test()'s arguments:
//   - bracket-quoted:  [=[literal content]=]  (any number of '=', incl. 0)
//   - double-quoted:    "content"
//   - bare:             whitespace/')'-delimited token
//
// The command can be a fully resolved absolute path (modern
// `add_test(NAME ... COMMAND target)` form, auto-substituted by CMake) or a
// bare, unresolved token (old-style `add_test(name cmd args...)` — kept
// literal, relies on ctest's cwd being the build directory to resolve it) —
// callers are responsible for correlating either shape back to a target.
const ADD_TEST_RE = /add_test\s*\(/gi;

export function parseCTestTestfile(text) {
    const tests = [];
    let match;
    ADD_TEST_RE.lastIndex = 0;
    while ((match = ADD_TEST_RE.exec(text)) !== null) {
        const { tokens, endIndex } = tokenizeArgs(text, ADD_TEST_RE.lastIndex);
        ADD_TEST_RE.lastIndex = endIndex;
        if (tokens.length === 0) continue;
        const [name, ...command] = tokens;
        tests.push({ name, command });
    }
    return tests;
}

function tokenizeArgs(text, startIndex) {
    const tokens = [];
    let i = startIndex;
    while (i < text.length) {
        while (i < text.length && /\s/.test(text[i])) i += 1;
        if (i >= text.length) break;
        if (text[i] === ")") {
            i += 1;
            break;
        }
        if (text[i] === "[") {
            const bracketMatch = /^\[(=*)\[/.exec(text.slice(i));
            if (bracketMatch) {
                const eqs = bracketMatch[1];
                const closer = `]${eqs}]`;
                const contentStart = i + bracketMatch[0].length;
                const closeIndex = text.indexOf(closer, contentStart);
                const end = closeIndex === -1 ? text.length : closeIndex;
                tokens.push(text.slice(contentStart, end));
                i = closeIndex === -1 ? text.length : closeIndex + closer.length;
                continue;
            }
        }
        if (text[i] === '"') {
            let j = i + 1;
            let value = "";
            while (j < text.length && text[j] !== '"') {
                if (text[j] === "\\" && j + 1 < text.length) {
                    value += text[j + 1];
                    j += 2;
                } else {
                    value += text[j];
                    j += 1;
                }
            }
            tokens.push(value);
            i = j + 1;
            continue;
        }
        let j = i;
        while (j < text.length && !/\s/.test(text[j]) && text[j] !== ")") j += 1;
        tokens.push(text.slice(i, j));
        i = j;
    }
    return { tokens, endIndex: i };
}
