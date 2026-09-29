#!/usr/bin/env python3
"""Make a local, heuristic inventory of Imp-authored JavaScript modules."""

from __future__ import annotations

import collections
import pathlib
import re
import subprocess
import sys


ROOT = pathlib.Path(__file__).resolve().parents[2]
TEST_SUFFIX = "_test.js"
EXCLUDED_RULE_PREFIXES = (
    "rules/js/example/",
)
ENGINE_MODULES = {
    "crates/imp-engine/src/graph_core.js",
    "crates/imp-engine/src/imp_core.js",
}


def tracked_javascript() -> list[str]:
    result = subprocess.run(
        ["git", "ls-files", "-z", "--", "*.js"],
        cwd=ROOT,
        check=True,
        stdout=subprocess.PIPE,
    )
    return sorted(path.decode("utf-8") for path in result.stdout.split(b"\0") if path)


def _blank(chars: list[str], start: int, end: int) -> None:
    for index in range(start, end):
        if chars[index] not in "\r\n":
            chars[index] = " "


def _starts_regex_literal(chars: list[str], slash: int) -> bool:
    """Use the preceding token to distinguish regex literals from division."""
    previous = slash - 1
    while previous >= 0 and chars[previous].isspace():
        previous -= 1
    if previous < 0:
        return True
    if chars[previous] in "=([{,:;!?&|+-*%^~<>":
        return True
    end = previous + 1
    while previous >= 0 and (chars[previous].isalnum() or chars[previous] in "_$"):
        previous -= 1
    token = "".join(chars[previous + 1 : end])
    return token in {
        "await", "case", "delete", "do", "else", "in", "instanceof",
        "of", "return", "throw", "typeof", "void", "yield",
    }


def mask_comments_and_literals(source: str) -> str:
    """Keep code and line positions while masking comments and string bodies."""
    chars = list(source)
    mode = "code"
    quote = ""
    regex_in_class = False
    index = 0
    template_stack: list[dict[str, int | str]] = []

    while index < len(chars):
        char = chars[index]
        following = chars[index + 1] if index + 1 < len(chars) else ""

        if mode == "line_comment":
            if char in "\r\n":
                mode = "code"
            else:
                _blank(chars, index, index + 1)
            index += 1
            continue

        if mode == "block_comment":
            if char == "*" and following == "/":
                _blank(chars, index, index + 2)
                index += 2
                mode = "code"
            else:
                _blank(chars, index, index + 1)
                index += 1
            continue

        if mode == "quoted":
            _blank(chars, index, index + 1)
            if char == "\\" and index + 1 < len(chars):
                _blank(chars, index + 1, index + 2)
                index += 2
            elif char == quote:
                mode = "code"
                index += 1
            else:
                index += 1
            continue

        if mode == "regex":
            _blank(chars, index, index + 1)
            if char == "\\" and index + 1 < len(chars):
                _blank(chars, index + 1, index + 2)
                index += 2
            elif char in "\r\n":
                mode = "code"
                index += 1
            elif char == "[":
                regex_in_class = True
                index += 1
            elif char == "]":
                regex_in_class = False
                index += 1
            elif char == "/" and not regex_in_class:
                index += 1
                while index < len(chars) and chars[index].isalpha():
                    _blank(chars, index, index + 1)
                    index += 1
                mode = "code"
            else:
                index += 1
            continue

        if mode == "template":
            if char == "\\":
                _blank(chars, index, min(index + 2, len(chars)))
                index += 2
            elif char == "`":
                _blank(chars, index, index + 1)
                template_stack.pop()
                mode = "code"
                index += 1
            elif char == "$" and following == "{":
                _blank(chars, index, index + 2)
                template_stack[-1]["braces"] = 1
                mode = "code"
                index += 2
            else:
                _blank(chars, index, index + 1)
                index += 1
            continue

        # Code mode. Template interpolation braces return to template text.
        if template_stack and int(template_stack[-1]["braces"]) > 0:
            if char == "{":
                template_stack[-1]["braces"] = int(template_stack[-1]["braces"]) + 1
            elif char == "}":
                depth = int(template_stack[-1]["braces"]) - 1
                template_stack[-1]["braces"] = depth
                if depth == 0:
                    _blank(chars, index, index + 1)
                    mode = "template"
                    index += 1
                    continue

        if char == "/" and following == "/":
            _blank(chars, index, index + 2)
            mode = "line_comment"
            index += 2
        elif char == "/" and following == "*":
            _blank(chars, index, index + 2)
            mode = "block_comment"
            index += 2
        elif char == "/" and _starts_regex_literal(chars, index):
            _blank(chars, index, index + 1)
            regex_in_class = False
            mode = "regex"
            index += 1
        elif char in "'\"":
            quote = char
            _blank(chars, index, index + 1)
            mode = "quoted"
            index += 1
        elif char == "`":
            _blank(chars, index, index + 1)
            template_stack.append({"braces": 0})
            mode = "template"
            index += 1
        else:
            index += 1

    return "".join(chars)


FEATURE_PATTERNS: dict[str, re.Pattern[str]] = {
    "static_import": re.compile(r"\bimport\s+(?!\()"),
    "export": re.compile(r"\bexport\b"),
    "dynamic_import": re.compile(r"\bimport\s*\("),
    "async": re.compile(r"\basync\b"),
    "await": re.compile(r"\bawait\b"),
    "destructuring": re.compile(r"\b(?:const|let|var)\s*[\[{]"),
    "spread_or_rest": re.compile(r"\.\.\."),
    "optional_chaining": re.compile(r"\?\."),
    "nullish_coalescing": re.compile(r"\?\?"),
    "object_freeze": re.compile(r"\bObject\s*\.\s*freeze\b"),
    "class": re.compile(r"\bclass\s+[A-Za-z_$]"),
    "this": re.compile(r"\bthis\b"),
    "prototype": re.compile(r"\bprototype\b"),
    "instanceof": re.compile(r"\binstanceof\b"),
    "promise": re.compile(r"\bPromise\b"),
    "node_process": re.compile(r"\bprocess\s*\."),
    "node_buffer": re.compile(r"\bBuffer\s*\."),
    "eval_or_function_constructor": re.compile(r"\b(?:eval\s*\(|new\s+Function\s*\()"),
    "map_or_set": re.compile(r"\bnew\s+(?:Map|Set)\s*\("),
    "new_expression": re.compile(r"\bnew\s+[A-Z_$][\w$]*\s*\("),
    "catch_binding": re.compile(r"\bcatch\s*\("),
    "for_of": re.compile(r"\bfor\s*\([^)]*\bof\b"),
    "arrow_function": re.compile(r"=>"),
    "camel_case_keys": re.compile(r"[,{]\s*([a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*)\s*:"),
    "array_or_object_methods": re.compile(
        r"\b(?:Array\s*\.\s*isArray|Object\s*\.\s*(?:keys|values|entries|assign)|"
        r"\.(?:map|filter|reduce|flatMap|includes|some|every|find|findIndex|slice|join|push|pop))\s*\("
    ),
}


MANUAL_FEATURES = {
    "class",
    "this",
    "prototype",
    "instanceof",
    "promise",
    "node_process",
    "node_buffer",
    "eval_or_function_constructor",
    "map_or_set",
}
REVIEW_FEATURES = {
    "dynamic_import",
    "async",
    "await",
    "destructuring",
    "spread_or_rest",
    "optional_chaining",
    "nullish_coalescing",
    "object_freeze",
    "catch_binding",
    "for_of",
    "camel_case_keys",
    "array_or_object_methods",
}


def role_for(path: str) -> tuple[str, str | None]:
    if path.endswith(TEST_SUFFIX):
        return "test", None
    if pathlib.PurePosixPath(path).name == "BUILD.js" or path.startswith("imp.workspace"):
        return "workspace/build", None
    if path.startswith(EXCLUDED_RULE_PREFIXES):
        return "excluded", "JavaScript application example"
    if path.startswith("rules/") or path in ENGINE_MODULES or path.startswith("docs/"):
        return "production", None
    return "excluded", "outside the rule, host, workspace, and documentation module scope"


def inspect_file(path: str) -> dict[str, object]:
    source = (ROOT / path).read_text(encoding="utf-8")
    code = mask_comments_and_literals(source)
    features = {
        name: len(pattern.findall(code))
        for name, pattern in FEATURE_PATTERNS.items()
    }
    features = {name: count for name, count in features.items() if count}
    role, reason = role_for(path)

    if role == "excluded":
        category = "excluded/non-authoring JavaScript"
    elif MANUAL_FEATURES.intersection(features):
        category = "manual redesign"
    elif REVIEW_FEATURES.intersection(features):
        category = "mechanical with review"
    else:
        category = "mechanical"

    return {
        "path": path,
        "role": role,
        "category": category,
        "reason": reason,
        "features": features,
    }


def print_report(rows: list[dict[str, object]]) -> None:
    category_names = [
        "mechanical",
        "mechanical with review",
        "manual redesign",
        "excluded/non-authoring JavaScript",
    ]
    role_names = ["production", "workspace/build", "test", "excluded"]

    print("# JavaScript-to-Luau conversion inventory")
    print()
    print(f"Tracked JavaScript files: {len(rows)}")
    print()
    print("## Counts by module role and conversion category")
    print()
    print("| Role | " + " | ".join(category_names) + " | Total |")
    print("| --- | " + " | ".join("---:" for _ in category_names) + " | ---: |")
    for role in role_names:
        selected = [row for row in rows if row["role"] == role]
        counts = [sum(row["category"] == category for row in selected) for category in category_names]
        print(f"| {role} | " + " | ".join(map(str, counts)) + f" | {len(selected)} |")
    all_counts = [sum(row["category"] == category for row in rows) for category in category_names]
    print("| **All** | " + " | ".join(map(str, all_counts)) + f" | **{len(rows)}** |")

    print()
    print("## Feature evidence")
    print()
    feature_counts: collections.Counter[str] = collections.Counter()
    for row in rows:
        if row["role"] != "excluded":
            feature_counts.update(row["features"])
    for name, count in feature_counts.most_common():
        print(f"- `{name}`: {count} token match(es)")

    print()
    print("The category rules are conservative triage signals, not a semantic proof. Review every module before scheduling conversion.")

    print()
    print("## Measured rule-family sizes")
    print()
    families: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    for row in rows:
        path = str(row["path"])
        if path.startswith("rules/") and row["role"] != "excluded":
            family_name = path.split("/", 2)[1]
            family = "rules (catalog root)" if family_name.endswith(".js") else "rules/" + family_name
            families[family][str(row["category"])] += 1
    print("| Family | Mechanical | Review | Redesign | Total |")
    print("| --- | ---: | ---: | ---: | ---: |")
    for family, counts in sorted(families.items()):
        mechanical = counts["mechanical"]
        review = counts["mechanical with review"]
        redesign = counts["manual redesign"]
        print(f"| `{family}` | {mechanical} | {review} | {redesign} | {mechanical + review + redesign} |")

    print()
    print("## Module paths by category")
    print()
    for category in category_names:
        selected = [row for row in rows if row["category"] == category]
        print(f"### {category} ({len(selected)})")
        for row in selected:
            features = ", ".join(sorted(row["features"])) or "no flagged syntax"
            reason = f"; {row['reason']}" if row["reason"] else ""
            print(f"- `{row['path']}` — {features}{reason}")

    print()
    print("## Cutover surfaces to review")
    print()
    print("- The engine module loader and runtime host files must load `.luau` sources and preserve module identity.")
    print("- Workspace config and `BUILD.js` naming must align with the Luau resolver and the files generated by `imp init`.")
    print("- `docs/BUILD.js` filters JavaScript sources for generated API references; its extractor, tests, generated `docs/content/reference/` pages, and documentation text need a migration decision.")
    print("- The installed `share/imp/rules/` tree and release smoke test must continue to package and load rule files beside the executable.")

    print()
    print("## Pilot and bounded batch proposal")
    print()
    print("- Pilot: `rules/asset` with its implementation, BUILD module, and tests. It is a small graph-native rule package with imports, option tables, callbacks, and async actions.")
    print("- Batch by rule package, keep each batch at or below 20 authoring modules, and include each package's BUILD and test modules with production modules. Split larger families at their subpackage boundaries.")
    print("- Use the family counts above to group small packages. Start with mechanical packages, then mechanical-with-review packages, and schedule manual-redesign packages as separate bounded work.")


def main() -> int:
    rows = [inspect_file(path) for path in tracked_javascript()]
    print_report(rows)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, subprocess.CalledProcessError) as error:
        print(f"inventory failed: {error}", file=sys.stderr)
        sys.exit(1)
