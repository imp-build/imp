#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter==0.26.0", "tree-sitter-javascript==0.25.0"]
# ///
"""Convert consumer imp.workspace.js and BUILD.js files to Luau.

The converter writes each Luau file beside its JavaScript file. It converts
the mechanical constructs. It replaces each construct that it cannot convert
with an IMP-PORT comment and an error() call, and a file with markers ends
with an error() call, so evaluation fails until a person completes the port.
When it cannot show that a construct keeps its JavaScript meaning in Luau
(truthiness, array indexes, key names), it marks the construct. It does not
convert custom rule modules; it lists them in the summary.

Rule export names come from the Luau rule tree, and core API names come from
the engine source in this checkout.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

import tree_sitter_javascript
from tree_sitter import Language, Node, Parser

CHECKOUT = Path(__file__).resolve().parents[2]
PARSER = Parser(Language(tree_sitter_javascript.language()))

LUAU_KEYWORDS = {
    "and",
    "break",
    "do",
    "else",
    "elseif",
    "end",
    "false",
    "for",
    "function",
    "if",
    "in",
    "local",
    "nil",
    "not",
    "or",
    "repeat",
    "return",
    "then",
    "true",
    "until",
    "while",
}
# Globals that converted code or helpers use. A JavaScript name that has
# one of these names gets a "_" suffix.
LUAU_GLOBALS = {
    "error",
    "ipairs",
    "math",
    "next",
    "pairs",
    "require",
    "select",
    "string",
    "table",
    "tostring",
    "type",
    "core",
}
# Keys of these maps are names that the author chose. Closures read them back
# by the same name, so the converter keeps their spelling.
USER_KEYED_MAPS = {"inputs", "tools", "outputs", "env"}
# Handles whose methods take the handle as self in Luau.
HANDLE_METHODS = {"get", "all"}
HELPERS = {
    "array_concat": """local function array_concat(...)
	local out = {}
	for _, part in { ... } do
		for _, value in part do
			table.insert(out, value)
		end
	end
	return out
end""",
    "table_merge": """local function table_merge(...)
	local out = {}
	for _, part in { ... } do
		for key, value in part do
			out[key] = value
		end
	end
	return out
end""",
    "array_map": """local function array_map(list, fn)
	local out = {}
	for index, value in list do
		out[index] = fn(value)
	end
	return out
end""",
    "array_filter": """local function array_filter(list, fn)
	local out = {}
	for _, value in list do
		if fn(value) then
			table.insert(out, value)
		end
	end
	return out
end""",
    "array_flat_map": """local function array_flat_map(list, fn)
	local out = {}
	for _, value in list do
		for _, item in fn(value) do
			table.insert(out, item)
		end
	end
	return out
end""",
    "array_truthy": """local function array_truthy(list)
	local out = {}
	for _, value in list do
		if value ~= nil and value ~= false and value ~= "" and value ~= 0 then
			table.insert(out, value)
		end
	end
	return out
end""",
    "string_starts_with": """local function string_starts_with(text, prefix)
	return string.sub(text, 1, #prefix) == prefix
end""",
    "string_ends_with": """local function string_ends_with(text, suffix)
	return suffix == "" or string.sub(text, -#suffix) == suffix
end""",
}
LINE_LIMIT = 90
COMPARISONS = {"===", "!==", "==", "!=", "<", ">", "<=", ">=", "instanceof", "in"}
# Methods that return a boolean in JavaScript.
BOOLEAN_METHODS = {"startsWith", "endsWith", "includes", "some", "every"}
# Methods and helpers that return an array.
ARRAY_METHODS = {"map", "filter", "flatMap", "slice", "concat", "split"}


def snake(name: str) -> str:
    """Return the snake_case form of a camelCase name.

    Constants and names that start with an upper-case letter do not change.
    """
    if not name[:1].islower() or not any(c.isupper() for c in name):
        return name
    name = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", name)
    return re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", name).lower()


def is_identifier(text: str) -> bool:
    return (
        bool(re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", text))
        and text not in LUAU_KEYWORDS
    )


def luau_string(value: str) -> str:
    quote = "'" if '"' in value and "'" not in value else '"'
    out = []
    for char in value:
        if char == "\\":
            out.append("\\\\")
        elif char == quote:
            out.append("\\" + quote)
        elif char == "\n":
            out.append("\\n")
        elif char == "\r":
            out.append("\\r")
        elif char == "\t":
            out.append("\\t")
        elif ord(char) < 0x20 or ord(char) == 0x7F:
            out.append(f"\\{ord(char):03d}")
        else:
            out.append(char)
    return quote + "".join(out) + quote


def long_bracket(text: str) -> tuple[str, str]:
    level = 0
    while f"]{'=' * level}]" in text:
        level += 1
    return f"[{'=' * level}[", f"]{'=' * level}]"


ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "v": "\v", "0": "\0"}


def decode_escape(text: str) -> str | None:
    body = text[1:]
    if body in ESCAPES:
        return ESCAPES[body]
    if body.startswith("x") and len(body) == 3:
        return chr(int(body[1:], 16))
    if body.startswith("u{"):
        return chr(int(body[2:-1], 16))
    if body.startswith("u") and len(body) == 5:
        return chr(int(body[1:], 16))
    if body.startswith(("\n", "\r\n")):
        return ""
    if len(body) == 1 and not body.isalnum():
        return body
    return None


# ---------------------------------------------------------------------------
# The Luau rule tree and the core API


class RuleCatalog:
    """Export names of the Luau rule modules, read from their source."""

    def __init__(self, rules_dir: Path):
        self.rules_dir = rules_dir
        self._exports: dict[Path, set[str]] = {}
        self._aliases: dict[tuple[Path, str], str] | None = None

    def resolve(self, module: str) -> Path | None:
        base = self.rules_dir / module
        for candidate in (base.with_name(base.name + ".luau"), base / "index.luau"):
            if candidate.is_file():
                return candidate
        return None

    def _resolve_require(self, source: Path, address: str) -> Path | None:
        if address.startswith("@imp/rules/"):
            return self.resolve(address.removeprefix("@imp/rules/"))
        if address.startswith(("./", "../")):
            base = (source.parent / address).resolve()
            for candidate in (base.with_name(base.name + ".luau"), base / "index.luau"):
                if candidate.is_file():
                    return candidate
        return None

    def _return_table(self, text: str) -> str | None:
        starts = list(re.finditer(r"^return \{", text, re.MULTILINE))
        if not starts:
            return None
        body = text[starts[-1].end() :]
        depth = 0
        tokens = re.finditer(
            r"--\[(=*)\[.*?\]\1\]|--[^\n]*|\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[{}()\[\]]",
            body,
            re.DOTALL,
        )
        for token in tokens:
            value = token.group(0)
            if value in "{([":
                depth += 1
            elif value in "})]":
                if depth == 0:
                    return body[: token.start()]
                depth -= 1
        return None

    def _top_level_entries(self, table: str) -> list[tuple[str, str]]:
        """Return (key, value text) pairs at depth zero of a table body."""
        entries = []
        depth = 0
        pattern = re.compile(
            r"--\[(=*)\[.*?\]\1\]|--[^\n]*|\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[{}()\[\]]|\b([A-Za-z_][A-Za-z_0-9]*)\s*=(?!=)\s*([A-Za-z_][A-Za-z_0-9.]*)?",
            re.DOTALL,
        )
        for token in pattern.finditer(table):
            value = token.group(0)
            if value in "{([":
                depth += 1
            elif value in "})]":
                depth -= 1
            elif token.group(2) and depth == 0:
                entries.append((token.group(2), token.group(3) or ""))
        return entries

    def exports(self, path: Path, depth: int = 0) -> set[str]:
        if path in self._exports:
            return self._exports[path]
        text = path.read_text()
        keys: set[str] = set()
        forward = re.search(r'^return require\("([^"]+)"\)', text, re.MULTILINE)
        if forward and depth < 4:
            target = self._resolve_require(path, forward.group(1))
            if target:
                keys = self.exports(target, depth + 1)
        else:
            table = self._return_table(text)
            if table is not None:
                keys = {key for key, _ in self._top_level_entries(table)}
        self._exports[path] = keys
        return keys

    def aliases(self) -> dict[tuple[Path, str], str]:
        """Map (module, field) to the name that another module re-exports it as."""
        if self._aliases is not None:
            return self._aliases
        self._aliases = {}
        for source in sorted(self.rules_dir.rglob("*.luau")):
            if source.name.endswith(".test.luau"):
                continue
            text = source.read_text()
            locals_ = {
                m.group(1): m.group(2)
                for m in re.finditer(
                    r'^local (\w+) = require\("([^"]+)"\)\s*$', text, re.MULTILINE
                )
            }
            table = self._return_table(text)
            if table is None:
                continue
            for key, value in self._top_level_entries(table):
                if "." not in value:
                    continue
                local, field_name = value.split(".", 1)
                if local in locals_:
                    target = self._resolve_require(source, locals_[local])
                    if target:
                        self._aliases.setdefault((target, key), field_name)
        return self._aliases

    def name_for(self, module: str, name: str) -> tuple[str | None, str]:
        """Return the Luau export for a JavaScript export name, and the rule used."""
        path = self.resolve(module)
        if path is None:
            return None, "no module"
        exports = self.exports(path)
        if name in exports:
            return name, "exact"
        snake_name = snake(name)
        if snake_name in exports:
            return snake_name, "snake_case"
        for (target, key), field_name in self.aliases().items():
            if target == path and key == snake_name and field_name in exports:
                return field_name, f"re-export alias {key}"
        # Toolchain modules dropped the tool name from their exports, for
        # example gcc defaultGccGraphToolchain -> default_graph_toolchain.
        segments = [
            s for s in PurePosixPath(module).parts if s not in ("index", "toolchain")
        ]
        tool = (
            segments[-1].removesuffix("_toolchain").replace("-", "_")
            if segments
            else ""
        )
        if tool:
            stripped = re.sub(rf"(^|_){re.escape(tool)}(_|$)", r"\1", snake_name).strip(
                "_"
            )
            for candidate in (
                stripped,
                re.sub(r"graph_tool$", "graph_toolchain", stripped),
            ):
                if candidate in exports:
                    return candidate, f"tool prefix '{tool}' removed"
        return None, "no matching export"


def core_api_names(engine_source: Path) -> set[str]:
    text = engine_source.read_text()
    return set(re.findall(r'\bcore\.set\(\s*"([A-Za-z_]+)"', text))


# ---------------------------------------------------------------------------
# Repository and import resolution


@dataclass
class Resolved:
    kind: str  # core | rule | build | module | missing
    address: str = ""
    path: str = ""  # workspace-relative JS path, for build and module


def object_keys(tree) -> tuple[set[str], set[str]]:
    """Return (keys of user-keyed maps, other camelCase object keys)."""
    user: set[str] = set()
    option: set[str] = set()

    def key_text(entry) -> str | None:
        if entry.type == "shorthand_property_identifier":
            return entry.text.decode()
        if entry.type == "pair":
            key = entry.child_by_field_name("key")
            if key.type in ("property_identifier", "string"):
                return key.text.decode().strip("\"'")
        return None

    stack = [(tree.root_node, False)]
    while stack:
        node, user_keyed = stack.pop()
        if node.type == "object":
            for entry in node.named_children:
                key = key_text(entry)
                if key is None:
                    continue
                if user_keyed:
                    user.add(key)
                elif snake(key) != key:
                    option.add(key)
        for child in node.children:
            child_user = False
            if node.type == "pair" and child == node.child_by_field_name("value"):
                key = key_text(node)
                child_user = key in USER_KEYED_MAPS
            stack.append((child, child_user))
    return user, option


class Repository:
    def __init__(self, root: Path):
        self.root = root.resolve()
        result = subprocess.run(
            ["git", "ls-files", "-z"], cwd=self.root, capture_output=True, check=True
        )
        self.tracked = {p for p in result.stdout.decode().split("\0") if p}
        # Keys of user-keyed maps and of other object literals, over all
        # authoring files: a read in one file can name a key from another.
        self.user_keys: set[str] = set()
        self.option_keys: set[str] = set()
        for path in self.authoring_files():
            user, option = object_keys(PARSER.parse((self.root / path).read_bytes()))
            self.user_keys |= user
            self.option_keys |= option

    def exists(self, path: str) -> bool:
        return path in self.tracked or (self.root / path).is_file()

    def authoring_files(self) -> list[str]:
        return sorted(
            p
            for p in self.tracked
            if re.search(r"(^|/)(imp\.workspace[^/]*\.js|BUILD\.js)$", p)
        )

    def resolve(self, address: str, importer: str, catalog: RuleCatalog) -> Resolved:
        if address == "imp:core":
            return Resolved("core", "@imp/core")
        if address.startswith("//"):
            relative = address[2:].strip("/")
        elif address.startswith("."):
            parts: list[str] = []
            for part in (PurePosixPath(importer).parent / address).parts:
                if part == "..":
                    if not parts:
                        return Resolved("missing")
                    parts.pop()
                elif part != ".":
                    parts.append(part)
            relative = "/".join(parts)
        else:
            return Resolved("missing")
        base = relative.removesuffix(".js")
        module_candidates = [f"{base}.js", f"{base}/index.js"] if base else []
        build = f"{base}/BUILD.js" if base else "BUILD.js"
        for candidate in module_candidates:
            if self.exists(candidate):
                luau = candidate.removesuffix(".js").removesuffix("/index")
                return Resolved("module", f"@workspace/{luau}", candidate)
        if relative.startswith("rules/") and catalog.resolve(relative[6:]):
            return Resolved("rule", f"@imp/rules/{relative[6:]}")
        if self.exists(build):
            prefix = f"{base}/" if base else ""
            return Resolved("build", f"@workspace/{prefix}BUILD", build)
        return Resolved("missing")


# ---------------------------------------------------------------------------
# The converter


@dataclass
class Marker:
    index: int
    js_line: int
    reason: str
    luau_line: int = 0


@dataclass
class Binding:
    """How a JavaScript import name renders in Luau."""

    kind: str  # local | core | module
    text: str
    # For a namespace import: the import kind (rule, build, module) and address.
    source: str = ""
    address: str = ""


class Unsupported(Exception):
    def __init__(self, node: Node, reason: str):
        super().__init__(reason)
        self.node = node
        self.reason = reason


@dataclass
class FileResult:
    path: str
    output: str
    status: str
    markers: list[Marker] = field(default_factory=list)
    renames: list[str] = field(default_factory=list)
    custom_imports: list[str] = field(default_factory=list)
    text: str = ""


class FileConverter:
    def __init__(
        self, repo: Repository, path: str, catalog: RuleCatalog, core: set[str]
    ):
        self.repo = repo
        self.path = path
        self.catalog = catalog
        self.core = core
        self.source = (repo.root / path).read_bytes()
        self.tree = PARSER.parse(self.source)
        self.workspace = PurePosixPath(path).name.startswith("imp.workspace")
        self.markers: list[Marker] = []
        self.renames: list[str] = []
        self.custom_imports: list[str] = []
        self.bindings: dict[str, Binding] = {}
        self.helpers: set[str] = set()
        self.uses_core = False
        self.pending: list[list[str]] = [[]]
        self.scopes: list[set[str]] = []
        self.identifiers = self._all_identifiers()
        self.user_keys = repo.user_keys
        self.option_keys = repo.option_keys
        self.slot_names: set[str] = set()
        self.forward: set[str] = set()
        self.forward_stack: list[set[str]] = [self.forward]
        # Value kinds of file-level names; filled after the imports load.
        self.local_kinds: dict[str, str | None] = {}
        self.taken = set(self.identifiers)

    # -- source helpers ----------------------------------------------------

    def text(self, node: Node) -> str:
        return self.source[node.start_byte : node.end_byte].decode()

    def _walk(self, node: Node):
        stack = [node]
        while stack:
            current = stack.pop()
            yield current
            stack.extend(reversed(current.children))

    def _all_identifiers(self) -> set[str]:
        return {
            self.text(n)
            for n in self._walk(self.tree.root_node)
            if n.type
            in (
                "identifier",
                "shorthand_property_identifier",
                "shorthand_property_identifier_pattern",
            )
        }

    def fresh(self, base: str) -> str:
        name = base
        counter = 1
        while (
            name in self.taken
            or name in LUAU_KEYWORDS
            or name in LUAU_GLOBALS
            or name in HELPERS
        ):
            name = f"{base}_{counter}" if counter > 1 else f"{base}_mod"
            counter += 1
        self.taken.add(name)
        return name

    def ident(self, name: str) -> str:
        if name in LUAU_KEYWORDS or name in LUAU_GLOBALS or name in HELPERS:
            return name + "_"
        return name

    def key_name(self, raw: str, user_keyed: bool) -> str:
        return raw if user_keyed else snake(raw)

    def prop_name(self, raw: str, node: Node) -> str:
        """Return the Luau name for a property read of an object key."""
        if snake(raw) == raw:
            return raw
        if raw in self.user_keys and raw in self.option_keys:
            raise Unsupported(
                node, f"'{raw}' is both a user-chosen key and an option key"
            )
        return raw if raw in self.user_keys else snake(raw)

    # -- value kinds -------------------------------------------------------

    def compute_local_kinds(self):
        """Find names whose every declaration has one known value kind.

        A name that is a parameter or is assigned again has no known kind.
        """
        declarations: dict[str, list[Node]] = {}
        unknown: set[str] = set()
        for node in self._walk(self.tree.root_node):
            if node.type == "variable_declarator":
                name = node.child_by_field_name("name")
                value = node.child_by_field_name("value")
                if name.type == "identifier":
                    declarations.setdefault(self.text(name), []).append(value)
            elif node.type == "for_in_statement":
                left = node.child_by_field_name("left")
                if left.type == "identifier":
                    unknown.add(self.text(left))
            elif node.type in ("formal_parameters", "object_pattern"):
                unknown |= {
                    self.text(n)
                    for n in self._walk(node)
                    if n.type in ("identifier", "shorthand_property_identifier_pattern")
                }
            elif node.type in (
                "assignment_expression",
                "augmented_assignment_expression",
                "update_expression",
            ):
                target = node.child_by_field_name("left") or node.child_by_field_name(
                    "argument"
                )
                if target is not None and target.type == "identifier":
                    unknown.add(self.text(target))
        self.local_kinds = {}
        for _ in range(3):
            kinds = {}
            for name, values in declarations.items():
                found = {self.value_kind(v) if v is not None else None for v in values}
                kinds[name] = (
                    found.pop() if len(found) == 1 and name not in unknown else None
                )
            self.local_kinds = kinds

    def value_kind(self, node: Node | None) -> str | None:
        """Return boolean, array, object, string, number, handle, or None."""
        if node is None:
            return None
        kind = node.type
        if kind in ("true", "false"):
            return "boolean"
        if kind in ("string", "template_string"):
            return "string"
        if kind == "number":
            return "number"
        if kind == "array":
            return "array"
        if kind == "object":
            return "object"
        if kind in ("parenthesized_expression", "await_expression"):
            inner = [c for c in node.named_children if c.type != "comment"]
            return self.value_kind(inner[0]) if inner else None
        if kind == "identifier":
            return self.local_kinds.get(self.text(node))
        if kind == "unary_expression":
            return (
                "boolean"
                if self.text(node.child_by_field_name("operator")) == "!"
                else None
            )
        if kind == "binary_expression":
            operator = self.text(node.child_by_field_name("operator"))
            if operator in COMPARISONS:
                return "boolean"
            if operator in ("&&", "||"):
                left = self.value_kind(node.child_by_field_name("left"))
                right = self.value_kind(node.child_by_field_name("right"))
                return "boolean" if left == right == "boolean" else None
            return None
        if kind == "call_expression":
            callee = node.child_by_field_name("function")
            if callee.type == "member_expression":
                method = self.text(callee.child_by_field_name("property"))
                if method in BOOLEAN_METHODS:
                    return "boolean"
                if method in ARRAY_METHODS:
                    return "array"
                return None
            if callee.type == "identifier" and self.text(callee) in self.bindings:
                binding = self.bindings[self.text(callee)]
                # Rule factories and core graph functions return handles.
                if binding.kind in ("local", "core"):
                    return "handle"
        return None

    def require_boolean(self, node: Node, what: str):
        if self.value_kind(node) != "boolean":
            raise Unsupported(
                node,
                f'JavaScript truthiness of {what}: 0 and "" are true in Luau',
            )

    # -- markers -----------------------------------------------------------

    def marker(self, node: Node, reason: str) -> str:
        """Record a marker; return an error() expression for its place."""
        index = len(self.markers) + 1
        line = node.start_point[0] + 1
        self.markers.append(Marker(index, line, reason))
        original = self.text(node)
        open_, close = long_bracket(original)
        name = PurePosixPath(self.path).name
        comment = (
            f"--{open_} IMP-PORT#{index} ({name}:{line}): {reason}\n{original}\n{close}"
        )
        self.pending[-1].extend(comment.split("\n"))
        return f"error({luau_string(f'IMP-PORT#{index} {self.path}:{line}: {reason}')})"

    def comment_lines(self, node: Node) -> list[str]:
        text = self.text(node)
        if text.startswith("//"):
            rest = text[2:]
            # "--[" would open a Luau long comment.
            return ["--" + (" " if rest.startswith("[") else "") + rest]
        body = text[2:-2].strip("\n")
        lines = []
        for line in body.split("\n"):
            line = re.sub(r"^\s*\*( |$)", "", line).rstrip()
            lines.append(f"-- {line}".rstrip())
        return lines

    def defer_comment(self, node: Node):
        self.pending[-1].extend(self.comment_lines(node))

    # -- statements --------------------------------------------------------

    def statement(self, node: Node, depth: int) -> list[str]:
        self.pending.append([])
        try:
            body = self._statement(node, depth)
        except Unsupported as error:
            body = [self.marker(error.node, error.reason)]
        pending = self.pending.pop()
        pad = "\t" * depth
        return [pad + line if line else "" for line in pending] + body

    def block(self, nodes: list[Node], depth: int) -> list[str]:
        # JavaScript hoists function declarations; declare the ones that an
        # earlier statement in this block refers to.
        functions = {
            self.text(n.child_by_field_name("name")): index
            for index, n in enumerate(nodes)
            if n.type == "function_declaration"
        }
        forward = {
            self.ident(name)
            for index, n in enumerate(nodes)
            for name in self.references(n)
            if functions.get(name, -1) > index
        }
        self.forward_stack.append(forward)
        try:
            lines = self._block(nodes, depth)
        finally:
            self.forward_stack.pop()
        if forward:
            lines.insert(0, "\t" * depth + "local " + ", ".join(sorted(forward)))
        return lines

    def _block(self, nodes: list[Node], depth: int) -> list[str]:
        lines: list[str] = []
        previous: Node | None = None
        for node in nodes:
            if node.type in ("{", "}", ";", "empty_statement"):
                continue
            if node.type == "comment":
                if (
                    previous is not None
                    and node.start_point[0] == previous.end_point[0]
                    and lines
                ):
                    lines[-1] += " " + self.comment_lines(node)[0]
                else:
                    if (
                        previous is not None
                        and node.start_point[0] - previous.end_point[0] > 1
                    ):
                        lines.append("")
                    lines.extend(
                        "\t" * depth + line for line in self.comment_lines(node)
                    )
                previous = node
                continue
            if previous is not None and node.start_point[0] - previous.end_point[0] > 1:
                lines.append("")
            lines.extend(self.statement(node, depth))
            previous = node
        return lines

    def _statement(self, node: Node, depth: int) -> list[str]:
        pad = "\t" * depth
        kind = node.type
        if kind in ("lexical_declaration", "variable_declaration"):
            lines = []
            for declarator in node.named_children:
                if declarator.type == "variable_declarator":
                    lines.extend(self.declarator(declarator, depth))
                elif declarator.type == "comment":
                    self.defer_comment(declarator)
            return lines
        if kind == "function_declaration":
            name = self.ident(self.text(node.child_by_field_name("name")))
            self.declare(name)
            function = self.function(node, depth)
            prefix = "" if name in self.forward_stack[-1] else "local "
            return [f"{pad}{prefix}function {name}{function.removeprefix('function')}"]
        if kind == "expression_statement":
            expression = node.named_children[0]
            return [pad + self.expression_statement(expression, depth)]
        if kind == "return_statement":
            values = [c for c in node.named_children if c.type != "comment"]
            if not values:
                return [f"{pad}return"]
            return [f"{pad}return {self.expr(values[0], depth)}"]
        if kind == "if_statement":
            return self.if_statement(node, depth, "if")
        if kind == "for_in_statement":
            return self.for_statement(node, depth)
        if kind == "throw_statement":
            value = node.named_children[0]
            if (
                value.type == "new_expression"
                and self.text(value.child_by_field_name("constructor")) == "Error"
            ):
                arguments = value.child_by_field_name("arguments").named_children
                return [
                    f"{pad}error({self.expr(arguments[0], depth) if arguments else ''})"
                ]
            return [f"{pad}error({self.expr(value, depth)})"]
        if kind == "statement_block":
            return (
                [f"{pad}do"]
                + self.scoped_block(node.named_children, depth + 1)
                + [f"{pad}end"]
            )
        raise Unsupported(node, f"unsupported statement '{kind}'")

    def scoped_block(self, nodes: list[Node], depth: int) -> list[str]:
        self.scopes.append(set())
        try:
            return self.block(nodes, depth)
        finally:
            self.scopes.pop()

    def declare(self, name: str):
        if self.scopes:
            self.scopes[-1].add(name)

    def declarator(self, node: Node, depth: int) -> list[str]:
        pad = "\t" * depth
        name_node = node.child_by_field_name("name")
        value = node.child_by_field_name("value")
        if name_node.type == "identifier":
            name = self.ident(self.text(name_node))
            rendered = self.expr(value, depth) if value is not None else None
            self.declare(name)
            if name in self.forward and not self.scopes:
                return [f"{pad}{name} = {rendered or 'nil'}"]
            return [f"{pad}local {name}" + (f" = {rendered}" if rendered else "")]
        if name_node.type == "object_pattern" and value is not None:
            source = self.expr(value, depth)
            if value.type != "identifier":
                temp = self.fresh("value")
                lines = [f"{pad}local {temp} = {source}"]
                source = temp
            else:
                lines = []
            for target, read in self.pattern_entries(name_node, source):
                self.declare(target)
                lines.append(f"{pad}local {target} = {read}")
            return lines
        raise Unsupported(node, f"unsupported declaration pattern '{name_node.type}'")

    def pattern_entries(self, pattern: Node, source: str) -> list[tuple[str, str]]:
        entries = []
        for child in pattern.named_children:
            if child.type == "shorthand_property_identifier_pattern":
                raw = self.text(child)
                entries.append(
                    (self.ident(raw), self.member(source, self.prop_name(raw, child)))
                )
            elif child.type == "pair_pattern":
                key_node = child.child_by_field_name("key")
                target = child.child_by_field_name("value")
                if target.type != "identifier":
                    raise Unsupported(child, "nested destructuring")
                if key_node.type == "string":
                    # A quoted key keeps its spelling, as in object literals.
                    key = self.string_value(key_node)
                elif key_node.type == "property_identifier":
                    key = self.prop_name(self.text(key_node), child)
                else:
                    raise Unsupported(child, "computed destructuring key")
                entries.append(
                    (self.ident(self.text(target)), self.member(source, key))
                )
            elif child.type == "object_assignment_pattern":
                left = child.child_by_field_name("left")
                right = child.child_by_field_name("right")
                if left.type != "shorthand_property_identifier_pattern":
                    raise Unsupported(child, "nested destructuring")
                raw = self.text(left)
                read = self.member(source, self.prop_name(raw, child))
                default = self.expr(right, 0)
                entries.append(
                    (self.ident(raw), f"if {read} == nil then {default} else {read}")
                )
            elif child.type == "comment":
                self.defer_comment(child)
            else:
                raise Unsupported(child, f"unsupported destructuring '{child.type}'")
        return entries

    def member(self, source: str, name: str) -> str:
        return (
            f"{source}.{name}"
            if is_identifier(name)
            else f"{source}[{luau_string(name)}]"
        )

    def expression_statement(self, node: Node, depth: int) -> str:
        if node.type == "assignment_expression":
            left = node.child_by_field_name("left")
            if left.type not in (
                "identifier",
                "member_expression",
                "subscript_expression",
            ):
                raise Unsupported(node, "unsupported assignment target")
            return f"{self.expr(left, depth)} = {self.expr(node.child_by_field_name('right'), depth)}"
        if node.type == "augmented_assignment_expression":
            operator = self.text(node.child_by_field_name("operator"))
            if operator not in ("+=", "-=", "*=", "/="):
                raise Unsupported(node, f"unsupported operator '{operator}'")
            if operator == "+=":
                raise Unsupported(node, "'+=' may be string concatenation or addition")
            left = self.expr(node.child_by_field_name("left"), depth)
            return f"{left} {operator} {self.expr(node.child_by_field_name('right'), depth)}"
        if node.type == "update_expression":
            argument = self.expr(node.child_by_field_name("argument"), depth)
            operator = "+=" if "++" in self.text(node) else "-="
            return f"{argument} {operator} 1"
        if node.type == "await_expression":
            return self.expression_statement(node.named_children[0], depth)
        if node.type == "call_expression":
            return self.expr(node, depth)
        raise Unsupported(node, f"unsupported expression statement '{node.type}'")

    def if_statement(self, node: Node, depth: int, keyword: str) -> list[str]:
        pad = "\t" * depth
        condition_node = node.child_by_field_name("condition")
        try:
            inner = [c for c in condition_node.named_children if c.type != "comment"]
            self.require_boolean(
                inner[0] if inner else condition_node, "an if condition"
            )
            condition = self.expr(condition_node, depth)
        except Unsupported as error:
            condition = self.marker(error.node, error.reason)
        if (
            condition.startswith("(")
            and condition.endswith(")")
            and self.balanced(condition[1:-1])
        ):
            condition = condition[1:-1]
        lines = [f"{pad}{keyword} {condition} then"]
        lines += self.branch(node.child_by_field_name("consequence"), depth + 1)
        alternative = node.child_by_field_name("alternative")
        if alternative is not None:
            inner = alternative.named_children[0]
            if inner.type == "if_statement":
                lines += self.if_statement(inner, depth, "elseif")
                return lines
            lines.append(f"{pad}else")
            lines += self.branch(inner, depth + 1)
        lines.append(f"{pad}end")
        return lines

    def branch(self, node: Node, depth: int) -> list[str]:
        if node.type == "statement_block":
            return self.scoped_block(node.named_children, depth)
        return self.scoped_block([node], depth)

    def balanced(self, text: str) -> bool:
        depth = 0
        for char in text:
            depth += char == "("
            depth -= char == ")"
            if depth < 0:
                return False
        return depth == 0

    def for_statement(self, node: Node, depth: int) -> list[str]:
        pad = "\t" * depth
        left = node.child_by_field_name("left")
        right = node.child_by_field_name("right")
        operator = self.text(node.child_by_field_name("operator"))
        if left.type != "identifier":
            raise Unsupported(node, "unsupported loop variable")
        if operator == "in":
            raise Unsupported(node, "for...in yields string keys; Luau keys differ")
        name = self.ident(self.text(left))
        iterable = self.expr(right, depth)
        self.scopes.append({name})
        try:
            header = (
                f"{pad}for _, {name} in {iterable} do"
                if operator == "of"
                else f"{pad}for {name} in {iterable} do"
            )
            body = self.branch(node.child_by_field_name("body"), depth + 1)
        finally:
            self.scopes.pop()
        return [header] + body + [f"{pad}end"]

    # -- functions ---------------------------------------------------------

    def function(self, node: Node, depth: int) -> str:
        parameters = node.child_by_field_name("parameters")
        names: list[str] = []
        prologue: list[str] = []
        pad = "\t" * (depth + 1)
        self.scopes.append(set())
        try:
            nodes = parameters.named_children if parameters is not None else []
            single = node.child_by_field_name("parameter")
            if single is not None:
                nodes = [single]
            for parameter in nodes:
                if parameter.type == "identifier":
                    name = self.ident(self.text(parameter))
                    names.append(name)
                    self.declare(name)
                elif parameter.type == "object_pattern":
                    name = self.fresh("resolved")
                    names.append(name)
                    for target, read in self.pattern_entries(parameter, name):
                        self.declare(target)
                        prologue.append(f"{pad}local {target} = {read}")
                elif parameter.type == "assignment_pattern":
                    left = parameter.child_by_field_name("left")
                    if left.type != "identifier":
                        raise Unsupported(parameter, "unsupported default parameter")
                    name = self.ident(self.text(left))
                    names.append(name)
                    self.declare(name)
                    default = self.expr(
                        parameter.child_by_field_name("right"), depth + 1
                    )
                    prologue.append(f"{pad}if {name} == nil then")
                    prologue.append(f"{pad}\t{name} = {default}")
                    prologue.append(f"{pad}end")
                elif parameter.type == "rest_pattern":
                    target = parameter.named_children[0]
                    name = self.ident(self.text(target))
                    names.append("...")
                    self.declare(name)
                    prologue.append(f"{pad}local {name} = {{ ... }}")
                elif parameter.type == "comment":
                    continue
                else:
                    raise Unsupported(
                        parameter, f"unsupported parameter '{parameter.type}'"
                    )
            body = node.child_by_field_name("body")
            if body.type == "statement_block":
                lines = self.block(body.named_children, depth + 1)
            else:
                self.pending.append([])
                value = self.expr(body, depth + 1)
                pending = self.pending.pop()
                lines = [pad + line if line else "" for line in pending] + [
                    f"{pad}return {value}"
                ]
        finally:
            self.scopes.pop()
        closing = "\t" * depth + "end"
        inner = prologue + lines
        return (
            f"function({', '.join(names)})\n"
            + "\n".join(inner)
            + ("\n" if inner else "")
            + closing
        )

    # -- expressions -------------------------------------------------------

    def in_scope(self, name: str) -> bool:
        return any(name in scope for scope in self.scopes)

    def expr(self, node: Node, depth: int) -> str:
        try:
            return self._expr(node, depth)
        except Unsupported as error:
            return self.marker(error.node, error.reason)

    def operand(self, node: Node, depth: int) -> str:
        rendered = self.expr(node, depth)
        if node.type in ("binary_expression", "ternary_expression", "unary_expression"):
            return f"({rendered})"
        return rendered

    def _expr(self, node: Node, depth: int) -> str:
        kind = node.type
        if kind == "identifier":
            return self.identifier(node)
        if kind in ("undefined", "null"):
            return "nil"
        if kind in ("true", "false"):
            return kind
        if kind == "number":
            text = self.text(node)
            if re.fullmatch(r"0[oObB].*|.*n", text):
                raise Unsupported(node, "unsupported number literal")
            return text
        if kind == "string":
            return luau_string(self.string_value(node))
        if kind == "template_string":
            return self.template(node, depth)
        if kind == "parenthesized_expression":
            inner = [c for c in node.named_children if c.type != "comment"]
            return f"({self.expr(inner[0], depth)})"
        if kind == "await_expression":
            return self.expr(node.named_children[0], depth)
        if kind == "array":
            return self.array(node, depth)
        if kind == "object":
            return self.table(node, depth, user_keyed=False)
        if kind in ("arrow_function", "function_expression", "function"):
            return self.function(node, depth)
        if kind == "member_expression":
            return self.member_expression(node, depth)
        if kind == "subscript_expression":
            return self.subscript(node, depth)
        if kind == "call_expression":
            return self.call(node, depth)
        if kind == "binary_expression":
            return self.binary(node, depth)
        if kind == "unary_expression":
            operator = self.text(node.child_by_field_name("operator"))
            argument_node = node.child_by_field_name("argument")
            if operator == "!":
                self.require_boolean(argument_node, "'!' operand")
            argument = self.operand(argument_node, depth)
            if operator == "!":
                return f"not {argument}"
            if operator == "-":
                return f"-{argument}"
            raise Unsupported(node, f"unsupported operator '{operator}'")
        if kind == "ternary_expression":
            condition_node = node.child_by_field_name("condition")
            self.require_boolean(condition_node, "a '?:' condition")
            condition = self.expr(condition_node, depth)
            consequence = self.operand(node.child_by_field_name("consequence"), depth)
            alternative = self.operand(node.child_by_field_name("alternative"), depth)
            return f"if {condition} then {consequence} else {alternative}"
        raise Unsupported(node, f"unsupported expression '{kind}'")

    def identifier(self, node: Node) -> str:
        name = self.text(node)
        if name == "undefined":
            return "nil"
        if not self.in_scope(self.ident(name)) and name in self.bindings:
            binding = self.bindings[name]
            if binding.kind == "core":
                self.uses_core = True
                if binding.text == "file":
                    raise Unsupported(node, "core file() used as a value")
            return binding.text if binding.kind != "core" else f"core.{binding.text}"
        return self.ident(name)

    def string_value(self, node: Node) -> str:
        parts = []
        for child in node.named_children:
            if child.type == "string_fragment":
                parts.append(self.text(child))
            elif child.type == "escape_sequence":
                decoded = decode_escape(self.text(child))
                if decoded is None:
                    raise Unsupported(node, "unsupported string escape")
                parts.append(decoded)
        return "".join(parts)

    def template(self, node: Node, depth: int) -> str:
        parts: list[str] = []
        has_substitution = False
        for child in node.named_children:
            if child.type == "string_fragment":
                parts.append(("text", self.text(child)))
            elif child.type == "escape_sequence":
                decoded = decode_escape(self.text(child))
                if decoded is None:
                    raise Unsupported(node, "unsupported string escape")
                parts.append(("text", decoded))
            elif child.type == "template_substitution":
                has_substitution = True
                inner = [c for c in child.named_children if c.type != "comment"]
                if self.value_kind(inner[0]) in ("array", "object"):
                    raise Unsupported(
                        node, "interpolation of a table: JavaScript joins arrays"
                    )
                parts.append(("expr", self.expr(inner[0], depth)))
        if not has_substitution:
            return luau_string("".join(text for _, text in parts))
        out = []
        for part_kind, value in parts:
            if part_kind == "expr":
                out.append("{" + value + "}")
                continue
            for char in value:
                if char in "\\`{":
                    out.append("\\" + char)
                elif char == "\n":
                    out.append("\\n")
                elif char == "\t":
                    out.append("\\t")
                elif char == "\r":
                    out.append("\\r")
                else:
                    out.append(char)
        return "`" + "".join(out) + "`"

    def layout(
        self,
        items: list[str],
        comments: dict[int, list[str]],
        depth: int,
        trailing: list[str],
    ) -> str:
        if not items and not comments and not trailing:
            return "{}"
        single = "{ " + ", ".join(items) + " }"
        if (
            not comments
            and not trailing
            and "\n" not in single
            and len(single) + depth * 4 <= LINE_LIMIT
        ):
            return single
        pad = "\t" * (depth + 1)
        lines = ["{"]
        for index, item in enumerate(items):
            lines.extend(pad + c for c in comments.get(index, []))
            lines.append(f"{pad}{item},")
        lines.extend(pad + c for c in trailing)
        lines.append("\t" * depth + "}")
        return "\n".join(lines)

    def collect(
        self, node: Node, render
    ) -> tuple[list[str], dict[int, list[str]], list[str]]:
        """Render the elements of a list node and keep their comments."""
        items: list[str] = []
        comments: dict[int, list[str]] = {}
        waiting: list[str] = []
        previous: Node | None = None
        for child in node.named_children:
            if child.type == "comment":
                lines = self.comment_lines(child)
                if (
                    previous is not None
                    and child.start_point[0] == previous.end_point[0]
                    and items
                ):
                    # A trailing comment moves above its element.
                    comments[len(items) - 1] = comments.get(len(items) - 1, []) + lines
                else:
                    waiting.extend(lines)
                continue
            rendered = render(child)
            if rendered is None:
                continue
            if waiting:
                comments[len(items)] = comments.get(len(items), []) + waiting
                waiting = []
            items.append(rendered)
            previous = child
        return items, comments, waiting

    def array(self, node: Node, depth: int) -> str:
        groups: list[tuple[str, list[str]]] = []
        has_spread = any(c.type == "spread_element" for c in node.named_children)
        if not has_spread:
            items, comments, trailing = self.collect(
                node, lambda c: self.expr(c, depth + 1)
            )
            return self.layout(items, comments, depth, trailing)
        self.helpers.add("array_concat")
        current: list[str] = []
        for child in node.named_children:
            if child.type == "comment":
                self.defer_comment(child)
                continue
            if child.type == "spread_element":
                if current:
                    groups.append(("list", current))
                    current = []
                groups.append(("spread", [self.expr(child.named_children[0], depth)]))
            else:
                current.append(self.expr(child, depth + 1))
        if current:
            groups.append(("list", current))
        parts = [
            self.layout(values, {}, depth, []) if group == "list" else values[0]
            for group, values in groups
        ]
        return self.call_text("array_concat", parts, depth)

    def call_text(self, callee: str, arguments: list[str], depth: int) -> str:
        single = f"{callee}({', '.join(arguments)})"
        if "\n" not in single and len(single) + depth * 4 <= LINE_LIMIT:
            return single
        if len(arguments) == 1:
            return f"{callee}({arguments[0]})"
        pad = "\t" * (depth + 1)
        inner = ",\n".join(
            pad + argument.replace("\n", "\n\t") for argument in arguments
        )
        return f"{callee}(\n{inner}\n" + "\t" * depth + ")"

    def table(self, node: Node, depth: int, user_keyed: bool) -> str:
        if any(c.type == "spread_element" for c in node.named_children):
            return self.spread_table(node, depth, user_keyed)

        def render(child: Node) -> str | None:
            return self.table_entry(child, depth + 1, user_keyed)

        items, comments, trailing = self.collect(node, render)
        return self.layout(items, comments, depth, trailing)

    def spread_table(self, node: Node, depth: int, user_keyed: bool) -> str:
        self.helpers.add("table_merge")
        parts: list[str] = []
        current: list[str] = []
        for child in node.named_children:
            if child.type == "comment":
                self.defer_comment(child)
            elif child.type == "spread_element":
                if current:
                    parts.append(self.layout(current, {}, depth, []))
                    current = []
                parts.append(self.expr(child.named_children[0], depth))
            else:
                current.append(self.table_entry(child, depth + 1, user_keyed))
        if current:
            parts.append(self.layout(current, {}, depth, []))
        return self.call_text("table_merge", parts, depth)

    def table_key(self, key: Node, user_keyed: bool) -> tuple[str, str]:
        """Return (rendered key prefix, raw key name)."""
        if key.type == "property_identifier":
            raw = self.text(key)
            name = self.key_name(raw, user_keyed)
            return (name if is_identifier(name) else f"[{luau_string(name)}]"), raw
        if key.type == "string":
            raw = self.string_value(key)
            return (raw if is_identifier(raw) else f"[{luau_string(raw)}]"), raw
        if key.type == "number":
            raise Unsupported(key, "numeric table key")
        if key.type == "computed_property_name":
            inner = next(c for c in key.named_children if c.type != "comment")
            return f"[{self.expr(inner, 0)}]", ""
        raise Unsupported(key, f"unsupported key '{key.type}'")

    def table_entry(self, child: Node, depth: int, user_keyed: bool) -> str:
        try:
            if child.type == "pair":
                key, raw = self.table_key(child.child_by_field_name("key"), user_keyed)
                value = child.child_by_field_name("value")
                if value.type == "object":
                    rendered = self.table(value, depth, raw in USER_KEYED_MAPS)
                else:
                    rendered = self.expr(value, depth)
                return f"{key} = {rendered}"
            if child.type == "shorthand_property_identifier":
                raw = self.text(child)
                name = self.key_name(raw, user_keyed)
                key = name if is_identifier(name) else f"[{luau_string(name)}]"
                value = self.identifier(child)
                return f"{key} = {value}"
            if child.type == "method_definition":
                if any(c.type in ("get", "set", "*") for c in child.children):
                    raise Unsupported(child, "getter, setter, or generator method")
                key, _ = self.table_key(child.child_by_field_name("name"), user_keyed)
                return f"{key} = {self.function(child, depth)}"
            raise Unsupported(child, f"unsupported object entry '{child.type}'")
        except Unsupported as error:
            return f"_ = {self.marker(error.node, error.reason)}"

    def member_expression(self, node: Node, depth: int) -> str:
        if any(c.type == "optional_chain" for c in node.children):
            raise Unsupported(node, "optional chaining")
        target = node.child_by_field_name("object")
        prop = self.text(node.child_by_field_name("property"))
        if prop == "length":
            inner = self.expr(target, depth)
            return (
                f"#{inner}"
                if target.type in ("identifier", "member_expression")
                else f"#({inner})"
            )
        if target.type == "identifier" and self.text(target) in (
            "Object",
            "JSON",
            "Promise",
            "Math",
            "Array",
        ):
            raise Unsupported(node, f"JavaScript built-in '{self.text(node)}'")
        base = self.prefix(target, depth)
        if target.type == "identifier" and self.text(target) in self.bindings:
            binding = self.bindings[self.text(target)]
            if binding.kind == "core" and binding.text == "output":
                return self.member(base, prop)
            if binding.kind == "module":
                return self.member(base, self.module_member(binding, prop, node))
        if target.type == "member_expression":
            parent = self.text(target.child_by_field_name("property"))
            if parent in USER_KEYED_MAPS:
                # A key of a task's inputs, tools, or outputs keeps its spelling.
                return self.member(base, prop)
        return self.member(base, self.prop_name(prop, node))

    def module_member(self, binding: Binding, name: str, node: Node) -> str:
        """Return the Luau export for a member of a namespace import."""
        if binding.source == "build":
            # BUILD modules keep their export names as target names.
            return name
        if binding.source == "rule":
            luau_name, rule = self.catalog.name_for(
                binding.address.removeprefix("@imp/rules/"), name
            )
            if luau_name is None:
                raise Unsupported(
                    node, f"{binding.address} has no export for {name!r} ({rule})"
                )
            return luau_name
        return snake(name)

    def prefix(self, node: Node, depth: int) -> str:
        rendered = self.expr(node, depth)
        if node.type in (
            "identifier",
            "member_expression",
            "subscript_expression",
            "call_expression",
            "parenthesized_expression",
        ):
            return rendered
        return f"({rendered})"

    def subscript(self, node: Node, depth: int) -> str:
        if any(c.type == "optional_chain" for c in node.children):
            raise Unsupported(node, "optional chaining")
        target_node = node.child_by_field_name("object")
        target = self.prefix(target_node, depth)
        index = node.child_by_field_name("index")
        if index.type == "string":
            key = self.string_value(index)
            if snake(key) != key and key not in self.user_keys:
                raise Unsupported(node, f"quoted read of the camelCase key '{key}'")
            return f"{target}[{luau_string(key)}]"
        if index.type == "number" and self.text(index).isdigit():
            if self.value_kind(target_node) == "array":
                return f"{target}[{int(self.text(index)) + 1}]"
            raise Unsupported(node, "index of a value that is not known to be an array")
        if index.type == "identifier" and self.text(index) in self.slot_names:
            return f"{target}[{self.identifier(index)}]"
        raise Unsupported(node, "index may be a zero-based array index")

    def binary(self, node: Node, depth: int) -> str:
        operator = self.text(node.child_by_field_name("operator"))
        left_node = node.child_by_field_name("left")
        right_node = node.child_by_field_name("right")
        mapped = {
            "===": "==",
            "==": "==",
            "!==": "~=",
            "!=": "~=",
            "&&": "and",
            "||": "or",
            "<": "<",
            ">": ">",
            "<=": "<=",
            ">=": ">=",
            "-": "-",
            "*": "*",
            "/": "/",
            "%": "%",
        }
        if operator == "??":
            if left_node.type not in ("identifier", "member_expression"):
                raise Unsupported(node, "'??' on an expression with side effects")
            left = self.expr(left_node, depth)
            right = self.operand(right_node, depth)
            return f"if {left} == nil then {right} else {left}"
        if operator in ("&&", "||"):
            self.require_boolean(left_node, f"the left operand of '{operator}'")
        if operator == "+":
            strings = ("string", "template_string")
            if left_node.type in strings or right_node.type in strings:
                mapped_operator = ".."
            elif left_node.type == "number" and right_node.type == "number":
                mapped_operator = "+"
            else:
                raise Unsupported(node, "'+' may be string concatenation or addition")
        elif operator in mapped:
            mapped_operator = mapped[operator]
        else:
            raise Unsupported(node, f"unsupported operator '{operator}'")
        left = self.operand(left_node, depth)
        right = self.operand(right_node, depth)
        return f"{left} {mapped_operator} {right}"

    def arguments(self, node: Node, depth: int, skip: int = 0) -> list[str]:
        values = []
        children = [c for c in node.named_children if c.type != "comment"][skip:]
        for child in node.named_children:
            if child.type == "comment":
                self.defer_comment(child)
        for index, child in enumerate(children):
            if child.type == "spread_element":
                if index != len(children) - 1:
                    raise Unsupported(node, "spread argument before the last argument")
                values.append(
                    f"table.unpack({self.expr(child.named_children[0], depth)})"
                )
            else:
                values.append(self.expr(child, depth))
        return values

    def callback_arity(self, node: Node) -> int:
        if node.type not in ("arrow_function", "function_expression"):
            return 99
        if node.child_by_field_name("parameter") is not None:
            return 1
        parameters = node.child_by_field_name("parameters")
        return len([c for c in parameters.named_children if c.type != "comment"])

    def call(self, node: Node, depth: int) -> str:
        callee = node.child_by_field_name("function")
        arguments_node = node.child_by_field_name("arguments")
        if any(c.type == "optional_chain" for c in node.children):
            raise Unsupported(node, "optional call")
        if arguments_node.type == "template_string":
            raise Unsupported(node, "tagged template")
        if callee.type == "identifier":
            name = self.text(callee)
            binding = self.bindings.get(name)
            if binding and binding.kind == "core" and not self.in_scope(name):
                self.uses_core = True
                arguments = self.arguments(arguments_node, depth)
                if binding.text == "file":
                    if len(arguments) != 1:
                        raise Unsupported(
                            node, "core file() with more than one argument"
                        )
                    return f"core.files({{ paths = {{ {arguments[0]} }} }})"
                return self.call_text(f"core.{binding.text}", arguments, depth)
        if callee.type == "member_expression":
            target = callee.child_by_field_name("object")
            method = self.text(callee.child_by_field_name("property"))
            target_text = self.text(target)
            raw_arguments = [
                c for c in arguments_node.named_children if c.type != "comment"
            ]
            if target_text == "Object" and method == "freeze":
                return self.call_text(
                    "table.freeze", self.arguments(arguments_node, depth), depth
                )
            if (
                target_text == "Object"
                and method == "assign"
                and raw_arguments
                and self.text(raw_arguments[0]).replace(" ", "") == "{}"
            ):
                self.helpers.add("table_merge")
                return self.call_text(
                    "table_merge", self.arguments(arguments_node, depth, skip=1), depth
                )
            if method == "tool" and target_text == "exec":
                if len(raw_arguments) == 2 and raw_arguments[1].type == "string":
                    # Declared tools are on PATH in Luau actions.
                    return luau_string(self.string_value(raw_arguments[1]))
                raise Unsupported(node, "exec.tool() without a literal executable name")
            if method == "join" and len(raw_arguments) <= 1:
                separator = (
                    self.expr(raw_arguments[0], depth) if raw_arguments else '","'
                )
                return f"table.concat({self.expr(target, depth)}, {separator})"
            if method == "push" and len(raw_arguments) == 1:
                return f"table.insert({self.expr(target, depth)}, {self.expr(raw_arguments[0], depth)})"
            if (
                method == "filter"
                and len(raw_arguments) == 1
                and self.text(raw_arguments[0]) == "Boolean"
            ):
                # JavaScript truthiness also drops "" and 0.
                self.helpers.add("array_truthy")
                return f"array_truthy({self.expr(target, depth)})"
            if method in ("startsWith", "endsWith") and len(raw_arguments) == 1:
                helper = "string_" + snake(method)
                self.helpers.add(helper)
                return f"{helper}({self.expr(target, depth)}, {self.expr(raw_arguments[0], depth)})"
            helpers = {
                "map": "array_map",
                "filter": "array_filter",
                "flatMap": "array_flat_map",
            }
            if (
                method in helpers
                and len(raw_arguments) == 1
                and self.callback_arity(raw_arguments[0]) <= 1
            ):
                if method == "filter":
                    body = raw_arguments[0].child_by_field_name("body")
                    if body.type == "statement_block":
                        raise Unsupported(node, "filter callback with a block body")
                    self.require_boolean(body, "a filter callback result")
                self.helpers.add(helpers[method])
                return self.call_text(
                    helpers[method],
                    [self.expr(target, depth), self.expr(raw_arguments[0], depth)],
                    depth,
                )
            receiver_kind = self.value_kind(target)
            if (
                method in HANDLE_METHODS
                and receiver_kind != "object"
                and not (
                    target.type == "identifier"
                    and self.bindings.get(target_text, Binding("", "")).kind == "module"
                )
            ):
                if receiver_kind != "handle":
                    raise Unsupported(
                        node, f"cannot tell whether .{method}() is a handle method"
                    )
                return self.call_text(
                    f"{self.prefix(target, depth)}:{method}",
                    self.arguments(arguments_node, depth),
                    depth,
                )
            if method in (
                "map",
                "filter",
                "flatMap",
                "slice",
                "lastIndexOf",
                "indexOf",
                "startsWith",
                "endsWith",
                "includes",
                "some",
                "every",
                "concat",
                "split",
                "replace",
                "find",
                "reduce",
                "forEach",
                "keys",
                "values",
                "entries",
                "trim",
                "toString",
            ):
                raise Unsupported(node, f"JavaScript method '.{method}()'")
        rendered = self.prefix(callee, depth)
        return self.call_text(rendered, self.arguments(arguments_node, depth), depth)

    # -- the module --------------------------------------------------------

    def imports(self, node: Node) -> list[str]:
        source = node.child_by_field_name("source")
        address = self.string_value(source)
        resolved = self.repo.resolve(address, self.path, self.catalog)
        clause = next(
            (c for c in node.named_children if c.type == "import_clause"), None
        )
        if resolved.kind == "missing":
            raise Unsupported(node, f"cannot resolve import '{address}'")
        if resolved.kind == "module":
            self.custom_imports.append(resolved.path)
        if resolved.address.startswith("@imp/rules/workflows/") and clause is not None:
            self.slot_names |= {
                self.text(n) for n in self._walk(clause) if n.type == "identifier"
            }
        if resolved.kind == "core" and clause is None:
            return []
        if clause is None:
            return [f"require({luau_string(resolved.address)})"]
        specifiers: list[tuple[str, str]] = []
        lines: list[str] = []
        for part in clause.named_children:
            if part.type == "named_imports":
                for spec in part.named_children:
                    if spec.type != "import_specifier":
                        continue
                    name = self.text(spec.child_by_field_name("name"))
                    alias_node = spec.child_by_field_name("alias")
                    alias = self.text(alias_node) if alias_node else name
                    specifiers.append((name, alias))
            elif part.type == "namespace_import":
                alias = self.text(part.named_children[0])
                if resolved.kind == "core":
                    raise Unsupported(node, "namespace import of imp:core")
                local = self.ident(alias)
                self.bindings[alias] = Binding(
                    "module", local, resolved.kind, resolved.address
                )
                lines.append(
                    f"local {local} = require({luau_string(resolved.address)})"
                )
            else:
                raise Unsupported(node, "default import")
        if resolved.kind == "core":
            missing = []
            for name, alias in specifiers:
                luau_name = {"file": "file", "files": "glob"}.get(name, snake(name))
                if luau_name not in self.core and luau_name != "file":
                    missing.append((name, alias))
                    continue
                self.bindings[alias] = Binding("core", luau_name)
            if missing:
                names = ", ".join(name for name, _ in missing)
                stub = self.marker(node, f"imp:core has no Luau export for {names}")
                for _, alias in missing:
                    lines.append(f"local {self.ident(alias)} = {stub}")
            return lines
        fields: list[tuple[str, str]] = []
        for name, alias in specifiers:
            if resolved.kind == "rule":
                luau_name, rule = self.catalog.name_for(
                    resolved.address.removeprefix("@imp/rules/"), name
                )
                if luau_name is None:
                    lines.append(
                        f"local {self.ident(alias)} = "
                        + self.marker(
                            node,
                            f"{resolved.address} has no export for {name!r} ({rule})",
                        )
                    )
                    continue
                if rule not in ("exact", "snake_case"):
                    self.renames.append(
                        f"{resolved.address}: {name} -> {luau_name} ({rule})"
                    )
            elif resolved.kind == "module":
                luau_name = snake(name)
            else:
                luau_name = name
            fields.append((alias, luau_name))
        if len(fields) == 1:
            alias, luau_name = fields[0]
            local = self.ident(alias)
            self.bindings[alias] = Binding("local", local)
            lines.append(
                f"local {local} = "
                + self.member(f"require({luau_string(resolved.address)})", luau_name)
            )
        elif fields:
            stem = (
                PurePosixPath(resolved.address).name.replace("-", "_").replace(".", "_")
            )
            if stem == "BUILD":
                parent = PurePosixPath(resolved.address).parent.name
                stem = (
                    parent.replace("-", "_") if parent != "@workspace" else "root"
                ) + "_build"
            module = self.fresh(snake(stem))
            lines.append(f"local {module} = require({luau_string(resolved.address)})")
            for alias, luau_name in fields:
                local = self.ident(alias)
                self.bindings[alias] = Binding("local", local)
                lines.append(f"local {local} = " + self.member(module, luau_name))
        return lines

    def references(self, node: Node) -> set[str]:
        return {
            self.text(n)
            for n in self._walk(node)
            if n.type in ("identifier", "shorthand_property_identifier")
        }

    def declared_names(self, node: Node) -> list[str]:
        if node.type == "export_statement":
            declaration = node.child_by_field_name("declaration")
            return self.declared_names(declaration) if declaration is not None else []
        if node.type == "function_declaration":
            return [self.text(node.child_by_field_name("name"))]
        if node.type in ("lexical_declaration", "variable_declaration"):
            names = []
            for declarator in node.named_children:
                if declarator.type == "variable_declarator":
                    target = declarator.child_by_field_name("name")
                    if target.type == "identifier":
                        names.append(self.text(target))
            return names
        return []

    def export_key(self, name: str) -> str:
        if self.workspace and name.endswith("Config") and len(name) > len("Config"):
            return snake(name.removesuffix("Config"))
        return name

    def convert(self) -> str:
        root = self.tree.root_node
        if root.has_error:
            raise ValueError(f"{self.path}: JavaScript parse error")
        children = [c for c in root.named_children]
        # ESM imports run before the module body.
        statements = [
            c for c in children if c.type not in ("import_statement", "comment")
        ]
        declared_at: dict[str, int] = {}
        for index, statement in enumerate(statements):
            for name in self.declared_names(statement):
                declared_at.setdefault(name, index)
        self.forward: set[str] = set()
        self.forward_stack = [self.forward]
        for index, statement in enumerate(statements):
            for name in self.references(statement):
                if declared_at.get(name, -1) > index:
                    self.forward.add(self.ident(name))
        self.taken |= {self.ident(n) for n in declared_at}

        header: list[str] = []
        first = next((c for c in children if c.type != "comment"), None)
        body_nodes = list(children)
        if first is not None:
            leading = [
                c
                for c in children
                if c.type == "comment" and c.end_byte <= first.start_byte
            ]
            if leading and first.start_point[0] - leading[-1].end_point[0] > 1:
                for comment in leading:
                    header.extend(self.comment_lines(comment))
                body_nodes = [c for c in children if c not in leading]

        import_lines: list[str] = []
        others: list[Node] = []
        attached: list[Node] = []
        for child in body_nodes:
            if child.type == "comment":
                attached.append(child)
                continue
            if child.type == "import_statement":
                for comment in attached:
                    import_lines.extend(self.comment_lines(comment))
                attached = []
                self.pending.append([])
                try:
                    lines = self.imports(child)
                except Unsupported as error:
                    lines = [self.marker(error.node, error.reason)]
                import_lines.extend(self.pending.pop() + lines)
            else:
                others.extend(attached + [child])
                attached = []
        others.extend(attached)

        self.compute_local_kinds()
        exports: list[tuple[str, str, Node]] = []
        body: list[str] = []
        previous: Node | None = None
        for node in others:
            if previous is not None and node.start_point[0] - previous.end_point[0] > 1:
                body.append("")
            if node.type == "comment":
                if (
                    previous is not None
                    and node.start_point[0] == previous.end_point[0]
                    and body
                ):
                    body[-1] += " " + self.comment_lines(node)[0]
                else:
                    body.extend(self.comment_lines(node))
            elif node.type == "export_statement":
                body.extend(self.export_statement(node, exports))
            else:
                body.extend(self.statement(node, 0))
            previous = node

        lines = header + ([""] if header else [])
        if self.uses_core:
            lines.append('local core = require("@imp/core")')
        lines.extend(import_lines)
        for helper, text in HELPERS.items():
            if helper in self.helpers:
                lines += ["", text]
        if self.forward:
            lines += ["", "local " + ", ".join(sorted(self.forward))]
        lines += [""] + body
        seen: set[str] = set()
        entries = []
        self.pending.append([])
        # Luau reserves configuration namespace names, so a <ns>Config
        # export keeps the key and another export with that name is marked.
        config_keys = {
            key
            for key, value, _ in exports
            if self.workspace and value == f"{key}Config"
        }
        config_keys |= {
            key
            for key, value, _ in exports
            if self.workspace
            and value.endswith("Config")
            and self.export_key(value) == key
        }
        for key, value, node in exports:
            if key == value and key in config_keys:
                reason = f"export {key!r} has the name of the configuration namespace {key!r}"
                entries.append(f"_ = {self.marker(node, reason)}")
                continue
            if key in seen:
                entries.append(
                    f"_ = {self.marker(node, f'duplicate export key {key!r}')}"
                )
                continue
            seen.add(key)
            entries.append(
                f"{key} = {value}"
                if is_identifier(key)
                else f"[{luau_string(key)}] = {value}"
            )
        # Luau workspace and BUILD modules must return a table.
        lines.append("")
        lines.extend(self.pending.pop())
        if self.markers:
            # Some stubs are in branches or closures that may not run. This
            # line makes sure that the module fails until the port is done.
            count = len(self.markers)
            lines.append(
                f'error("IMP-PORT: {count} unconverted construct(s) in {self.path}")'
            )
        lines.append("return " + self.layout(entries, {}, 0, []))
        while lines and lines[0] == "":
            lines.pop(0)
        text = "\n".join(lines)
        text = re.sub(r"\n{3,}", "\n\n", text).rstrip() + "\n"
        return self.place_markers(text)

    def place_markers(self, text: str) -> str:
        lines = text.split("\n")
        for marker in self.markers:
            tag = f"IMP-PORT#{marker.index} "
            for number, line in enumerate(lines, 1):
                if tag in line and "--[" in line:
                    marker.luau_line = number
                    break
        return text

    def export_statement(
        self, node: Node, exports: list[tuple[str, str, Node]]
    ) -> list[str]:
        declaration = node.child_by_field_name("declaration")
        if declaration is not None:
            names = self.declared_names(declaration)
            lines = self.statement(declaration, 0)
            for name in names:
                exports.append((self.export_key(name), self.ident(name), node))
            return lines
        if any(c.type == "default" for c in node.children):
            return self.statement_marker(node, "default export")
        source = node.child_by_field_name("source")
        clause = next(
            (c for c in node.named_children if c.type == "export_clause"), None
        )
        if clause is None:
            return self.statement_marker(node, "unsupported export")
        lines: list[str] = []
        module = None
        if source is not None:
            resolved = self.repo.resolve(
                self.string_value(source), self.path, self.catalog
            )
            if resolved.kind in ("missing", "core"):
                return self.statement_marker(node, "unsupported re-export")
            module = self.fresh("reexport")
            lines.append(f"local {module} = require({luau_string(resolved.address)})")
        for spec in clause.named_children:
            if spec.type != "export_specifier":
                continue
            name = self.text(spec.child_by_field_name("name"))
            alias_node = spec.child_by_field_name("alias")
            alias = self.text(alias_node) if alias_node else name
            if module:
                value = self.member(module, name)
            elif name in self.bindings:
                binding = self.bindings[name]
                if binding.kind == "core":
                    if binding.text == "file":
                        return self.statement_marker(node, "re-export of core file()")
                    self.uses_core = True
                    value = f"core.{binding.text}"
                else:
                    value = binding.text
            else:
                value = self.ident(name)
            exports.append((self.export_key(alias), value, node))
        return lines

    def statement_marker(self, node: Node, reason: str) -> list[str]:
        self.pending.append([])
        value = self.marker(node, reason)
        return self.pending.pop() + [value]


# ---------------------------------------------------------------------------
# Repository runs


def custom_modules(repo: Repository, imported: set[str]) -> tuple[list[str], list[str]]:
    """Return imp authoring JavaScript modules and tests that are not converted."""
    modules, tests = set(imported), set()
    authoring = re.compile(r"""from\s+["'](//|imp:core)|import\s+["']//""")
    for path in repo.tracked:
        if not re.search(r"\.m?js$", path) or re.search(
            r"(^|/)(imp\.workspace[^/]*\.js|BUILD\.js)$", path
        ):
            continue
        if path in imported:
            continue
        try:
            text = (repo.root / path).read_text(errors="replace")
        except OSError:
            continue
        if authoring.search(text):
            (tests if re.search(r"[._]test\.m?js$", path) else modules).add(path)
    return sorted(modules), sorted(tests)


def safe_output(repo: Repository, js_path: str) -> Path:
    source = repo.root / js_path
    output = source.with_name(source.name.removesuffix(".js") + ".luau")
    if output.is_symlink() or not output.resolve().is_relative_to(repo.root):
        raise ValueError(f"output path leaves the repository: {output}")
    return output


def convert_repository(
    root: Path, catalog: RuleCatalog, core: set[str], force: bool, dry_run: bool
) -> dict:
    repo = Repository(root)
    files: list[FileResult] = []
    imported: set[str] = set()
    for path in repo.authoring_files():
        output = safe_output(repo, path)
        relative_output = output.relative_to(repo.root).as_posix()
        converter = FileConverter(repo, path, catalog, core)
        try:
            text = converter.convert()
            text.encode("utf-8")
        except (ValueError, UnicodeError) as error:
            files.append(FileResult(path, relative_output, f"failed: {error}"))
            continue
        imported.update(converter.custom_imports)
        if output.exists() and not force:
            # The custom imports still count for the module list.
            files.append(FileResult(path, relative_output, "skipped-existing"))
            continue
        if converter.markers:
            status = "marked"
        elif converter.custom_imports:
            # The file loads only after its custom modules are ported.
            status = "needs-custom-modules"
        else:
            status = "complete"
        files.append(
            FileResult(
                path,
                relative_output,
                status,
                converter.markers,
                converter.renames,
                sorted(set(converter.custom_imports)),
                text,
            )
        )
        if not dry_run:
            # Write a temporary file and rename it, so that a failure cannot
            # leave a partial file that a later run skips.
            temporary = output.with_name(f".{output.name}.tmp")
            temporary.write_text(text, encoding="utf-8")
            temporary.replace(output)
    modules, tests = custom_modules(repo, imported)
    counts = {
        "files": len(files),
        "complete": sum(f.status == "complete" for f in files),
        "marked": sum(f.status == "marked" for f in files),
        "needs_custom_modules": sum(f.status == "needs-custom-modules" for f in files),
        "skipped": sum(f.status == "skipped-existing" for f in files),
        "failed": sum(f.status.startswith("failed") for f in files),
        "markers": sum(len(f.markers) for f in files),
        "custom_modules": len(modules),
        "custom_tests": len(tests),
    }
    return {
        "repository": str(repo.root),
        "counts": counts,
        "custom_modules": modules,
        "custom_tests": tests,
        "files": [
            {
                "source": f.path,
                "output": f.output,
                "status": f.status,
                "markers": [
                    {
                        "output_line": m.luau_line,
                        "source_line": m.js_line,
                        "reason": m.reason,
                    }
                    for m in f.markers
                ],
                "renames": f.renames,
                "custom_imports": f.custom_imports,
            }
            for f in files
        ],
    }


def print_summary(report: dict):
    counts = report["counts"]
    print(
        f"{report['repository']}: {counts['files']} file(s): {counts['complete']} complete, "
        f"{counts['marked']} with markers ({counts['markers']} marker(s)), "
        f"{counts['needs_custom_modules']} need custom modules, "
        f"{counts['skipped']} skipped, {counts['failed']} failed; "
        f"{counts['custom_modules']} custom module(s), {counts['custom_tests']} custom test(s)"
    )
    for entry in report["files"]:
        for marker in entry["markers"]:
            print(
                f"  {entry['output']}:{marker['output_line']} "
                f"({entry['source']}:{marker['source_line']}): {marker['reason']}"
            )
        if entry["status"].startswith(("failed", "skipped")):
            print(f"  {entry['source']}: {entry['status']}")
    for module in report["custom_modules"]:
        print(f"  custom module: {module}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("repositories", nargs="+", type=Path)
    parser.add_argument(
        "--force", action="store_true", help="replace existing Luau files"
    )
    parser.add_argument("--dry-run", action="store_true", help="write no Luau files")
    parser.add_argument(
        "--summary", type=Path, help="write a JSON summary to this path"
    )
    parser.add_argument("--rules", type=Path, default=CHECKOUT / "rules")
    parser.add_argument(
        "--engine",
        type=Path,
        default=CHECKOUT / "crates/imp-engine/src/luau.rs",
        help="engine source that registers the @imp/core API",
    )
    args = parser.parse_args(argv)
    catalog = RuleCatalog(args.rules.resolve())
    core = core_api_names(args.engine)
    reports = []
    for root in args.repositories:
        report = convert_repository(root, catalog, core, args.force, args.dry_run)
        print_summary(report)
        reports.append(report)
    if args.summary:
        args.summary.write_text(json.dumps(reports, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
