#!/usr/bin/env python3
"""Render Luau references from Tree-sitter syntax and registered schemas."""

from __future__ import annotations

import argparse
import json
import posixpath
import re
from pathlib import Path


class ExtractionError(ValueError):
    pass


def field(node, name):
    index = node.get("fields", {}).get(name)
    return node["children"][index] if index is not None else None


def children(node, kind):
    return [n for n in node["children"] if n["kind"] == kind]


def canonical(path):
    if path == "docs/core_api.luau":
        return "@imp/core"
    return "@imp/" + path.removesuffix(".luau").removesuffix("/index")


class Catalog:
    def __init__(self, modules):
        self.modules = modules
        self.addresses = {canonical(p): p for p in modules}
        self.cache = {}

    def require(self, path, address):
        if address.startswith("."):
            address = "@imp/" + posixpath.normpath(
                posixpath.join(posixpath.dirname(path), address)
            ).removeprefix("rules/")
            # Relative imports are file-relative, including index modules.
            address = address.replace("@imp/", "@imp/rules/", 1)
        address = address.removesuffix(".luau").removesuffix("/index")
        if address not in self.addresses:
            raise ExtractionError(f"{path}: unresolved module {address}")
        return self.addresses[address]

    def exports(self, path, chain=()):
        if path in chain:
            raise ExtractionError("cyclic re-export: " + " -> ".join((*chain, path)))
        if path in self.cache:
            return self.cache[path]
        module = self.modules[path]
        statements = module["children"]
        bindings = {}
        for node in statements:
            declaration = node
            if node["kind"] == "variable_declaration":
                parts = children(node, "assignment_statement")
                if not parts:
                    continue
                node = parts[0]
            if node["kind"] == "assignment_statement":
                names = children(node, "variable_list")
                values = children(node, "expression_list")
                if names and values:
                    for name, value in zip(names[0]["children"], values[0]["children"]):
                        bindings[name["text"]] = (value, declaration)
            elif node["kind"] == "function_declaration":
                bindings[field(node, "name")["text"]] = (node, declaration)
        returns = children(module, "return_statement")
        if len(returns) != 1:
            raise ExtractionError(f"{path}: expected one top-level return")

        aliases = {}

        def alias_root(name):
            while name in aliases:
                name = aliases[name]
            return name

        mutated = set()

        def record_write(node):
            if node["kind"] not in (
                "dot_index_expression",
                "bracket_index_expression",
                "method_index_expression",
            ):
                return
            while field(node, "table") is not None:
                node = field(node, "table")
            if node["kind"] == "identifier":
                mutated.add(node["text"])

        def find_writes(node):
            if node["kind"] == "function_declaration":
                record_write(field(node, "name"))
                return
            if node["kind"] == "function_definition":
                return
            if node["kind"] in ("assignment_statement", "update_statement"):
                names = children(node, "variable_list")
                values = children(node, "expression_list")
                if names and values and node["kind"] == "assignment_statement":
                    for name, value in zip(names[0]["children"], values[0]["children"]):
                        if name["kind"] == value["kind"] == "identifier":
                            left, right = (
                                alias_root(name["text"]),
                                alias_root(value["text"]),
                            )
                            if left != right:
                                aliases[left] = right
                for variables in names:
                    for variable in variables["children"]:
                        record_write(variable)
            for child in node["children"]:
                find_writes(child)

        # Scan control-flow blocks too. Evaluating them is outside the static
        # export contract. Conservatively join aliases across scopes and
        # assignments; writes through any of them can affect the returned table.
        find_writes(module)
        mutated = {alias_root(name) for name in mutated}

        def doc(node):
            lines = module["text"].splitlines()
            # A tag before the first field on a physical line must not tag
            # the next comma-separated field on that same line.
            if (
                not lines[node["line"] - 1]
                .lstrip()
                .startswith(node["text"].splitlines()[0])
            ):
                return ""
            i = node["line"] - 2
            parts = []
            while i >= 0 and lines[i].lstrip().startswith("---"):
                parts.append(lines[i].lstrip()[3:].removeprefix(" "))
                i -= 1
            return "\n".join(reversed(parts)).strip()

        def module_source(node, seen=()):
            if node["kind"] == "identifier" and node["text"] in bindings:
                name = node["text"]
                if name in seen:
                    raise ExtractionError(f"{path}: cyclic module alias {name}")
                return module_source(bindings[name][0], (*seen, name))
            if (
                node["kind"] == "function_call"
                and field(node, "name")["text"] == "require"
            ):
                args = field(node, "arguments")["children"]
                if len(args) == 1 and args[0]["kind"] == "string":
                    return self.require(path, args[0]["text"][1:-1])
            return None

        def resolve(node, declaration=None, seen=(), as_exports=False):
            if node["kind"] == "identifier" and node["text"] in bindings:
                name = node["text"]
                if name in seen:
                    raise ExtractionError(f"{path}: cyclic alias {name}")
                if as_exports and alias_root(name) in mutated:
                    raise ExtractionError(
                        f"{path}: mutated export table {name} is not supported"
                    )
                value, declared = bindings[name]
                return resolve(value, declared, (*seen, name), as_exports)
            if node["kind"] == "function_call":
                name = field(node, "name")["text"]
                args = field(node, "arguments")["children"]
                if name in ("table.freeze", "table.clone") and len(args) == 1:
                    return resolve(args[0], declaration, seen, as_exports)
                if name == "require" and len(args) == 1 and args[0]["kind"] == "string":
                    target = self.require(path, args[0]["text"][1:-1])
                    return self.exports(target, (*chain, path))
            if node["kind"] == "dot_index_expression":
                # Follow module aliases, including nested @imp/core names.
                target = node
                members = []
                while target["kind"] == "dot_index_expression":
                    members.insert(0, field(target, "field")["text"])
                    target = field(target, "table")
                source = module_source(target)
                if source is not None:
                    exports = self.exports(source, (*chain, path))
                    name = ".".join(members)
                    if name not in exports:
                        raise ExtractionError(
                            f"{path}: unresolved re-export {node['text']}"
                        )
                    return exports[name]
            if node["kind"] == "table_constructor" and as_exports:
                result = {}
                for item in children(node, "field"):
                    name = field(item, "name")
                    if name is None or name["kind"] not in ("identifier", "string"):
                        raise ExtractionError(
                            f"{path}:{item['line']}: unsupported exported field"
                        )
                    key = name["text"].strip("\"'")
                    if key in result:
                        raise ExtractionError(f"{path}: duplicate export {key}")
                    entry = resolve(field(item, "value"), item, seen)
                    if not isinstance(entry, dict) or "source" not in entry:
                        entry = {
                            "source": path,
                            "line": item["line"],
                            "signature": "",
                            "doc": doc(item),
                            "kind": "table",
                        }
                    entry = dict(entry)
                    if doc(item) and doc(item) != entry["doc"]:
                        entry["doc"] = (entry["doc"] + "\n" + doc(item)).strip()
                    result[key] = entry
                return result
            if node["kind"] == "identifier":
                raise ExtractionError(
                    f"{path}:{node['line']}: unresolved export {node['text']}"
                )
            declared = declaration or node
            parameters = field(node, "parameters")
            return {
                "source": path,
                "line": declared["line"],
                "signature": parameters["text"] if parameters else "",
                "doc": doc(declared),
                "kind": "function" if parameters else "value",
            }

        returned = returns[0]["children"][0]["children"]
        if len(returned) != 1:
            raise ExtractionError(f"{path}: unsupported return")
        exports = resolve(returned[0], as_exports=True)
        if not isinstance(exports, dict) or "source" in exports:
            raise ExtractionError(f"{path}: module must return a static export table")
        self.cache[path] = exports
        return exports


def tags(text):
    categories = re.findall(r"^@category\s+(\w+)\s*$", text, re.MULTILINE)
    category = categories[-1] if categories else "api"
    if category not in ("api", "target", "configuration"):
        raise ExtractionError(f"unknown documentation category: {category}")
    prose = []
    for line in text.splitlines():
        if line.startswith(("@category ", "@host ")):
            continue
        if line.startswith("@param "):
            line = (
                "- Parameter `"
                + line[7:].split(" ", 1)[0]
                + "` — "
                + (line[7:].split(" ", 1) + [""])[1]
            )
        elif line.startswith("@returns "):
            line = "Returns: " + line[9:]
        prose.append(line)
    return category, "\n".join(prose)


def entry_markdown(name, entry):
    _, prose = tags(entry["doc"])
    location = f"{entry['source']}:{entry['line']}"
    return f"## `{name}{entry['signature']}`\n\n{prose or 'Documentation is not yet available for this implementation export.'}\n\nSource: `{location}`.\n"


def section(root, relative, title, body):
    dest = root / relative
    dest.parent.mkdir(parents=True, exist_ok=True)
    template = "section.html" if dest.name == "_index.md" else "page.html"
    top = Path(relative).parts[1] if len(Path(relative).parts) > 2 else ""
    order = [
        "core",
        "imp",
        "workflows",
        "asset",
        "c",
        "js",
        "oci",
        "odin",
        "python",
        "rust",
        "treesitter",
        "zola",
    ]
    weight = order.index(top) if top in order else 99
    group = "core" if top in ("core", "imp", "workflows") else "languages"
    extra = f'\nextra = {{ weight = {weight}, group = "{group}" }}'

    dest.write_text(
        "+++\ntitle = "
        + json.dumps(title)
        + '\nsort_by = "title"\ntemplate = '
        + json.dumps(template)
        + extra
        + "\n+++\n\n"
        + body
        + "\n",
        encoding="utf-8",
    )


def schema_markdown(schema):
    lines = [
        "## Configuration",
        "",
        "| Field | Type | Default |",
        "| --- | --- | --- |",
    ]
    for name, descriptor in sorted(schema.items()):
        if not isinstance(descriptor, dict):
            continue
        kind = descriptor.get("__imp_field", "object")
        default = json.dumps(
            descriptor.get("default", None), ensure_ascii=False
        ).replace("|", "\\|")
        lines.append(f"| `{name}` | `{kind}` | `{default}` |")
    lines += [
        "",
        "Declare these fields in the corresponding namespace of the table returned by `imp.workspace.luau`.",
    ]
    return "\n".join(lines)


def render(modules, schemas, output, guides):
    catalog = Catalog(modules)
    entries = {}
    for path in sorted(modules):
        entries[path] = catalog.exports(path)
    for kind in ("luau-api", "user-api"):
        section(
            output,
            f"{kind}/_index.md",
            "Luau code reference" if kind == "luau-api" else "User API reference",
            "Generated from Luau source. Require built-in modules through `@imp/rules/...` and the host API through `@imp/core`.",
        )
    for path, exports in entries.items():
        address = canonical(path)
        relative = (
            "core" if address == "@imp/core" else address.removeprefix("@imp/rules/")
        )
        if path.endswith("/index.luau") or address == "@imp/core":
            page = relative + "/_index.md"
        else:
            page = relative + ".md"
        body = f"Module: `{address}`.\n\n" + "\n".join(
            entry_markdown(n, e) for n, e in sorted(exports.items())
        )
        section(output, "luau-api/" + page, address, body)
        public = [
            (n, e)
            for n, e in sorted(exports.items())
            if tags(e["doc"])[0] in ("target", "configuration")
        ]
        guide = (
            guides.get(str(Path(path).parent / "DOC.md"), "")
            if path.endswith("/index.luau")
            else ""
        )
        if public or guide or address == "@imp/core":
            # Guides are useful source context, not generated headings within
            # an export's documentation block.
            body = (guide + "\n\n" if guide else "") + "\n".join(
                entry_markdown(n, e) for n, e in public
            )
            namespace = "imp" if address == "@imp/core" else relative.split("/")[-1]
            if namespace in schemas:
                body += "\n\n" + schema_markdown(schemas[namespace])
            section(output, "user-api/" + page, address, body)
    # Facet packages such as Ruff intentionally have no index module, but
    # their guides still own a user-reference section.
    for path, guide in sorted(guides.items()):
        relative = str(Path(path).parent).removeprefix("rules/")
        page = "user-api/" + relative + "/_index.md"
        if not (output / page).exists():
            body = guide
            namespace = relative.split("/")[-1]
            if namespace in schemas:
                body += "\n\n" + schema_markdown(schemas[namespace])
            section(output, page, "@imp/rules/" + relative, body)
    # Every parent is a real Zola section, including directories with only
    # helper modules. Never create a conflicting index.md leaf.
    for page in sorted(output.rglob("*.md")):
        parent = page.parent
        while parent != output:
            index = parent / "_index.md"
            if not index.exists():
                section(output, str(index.relative_to(output)), parent.name, "")
            parent = parent.parent
    manifest = {
        "sources": sorted([*modules, *guides]),
        "pages": sorted(str(p.relative_to(output)) for p in output.rglob("*.md")),
        "modules": {canonical(p): sorted(e) for p, e in entries.items()},
    }
    (output / "exports.json").write_text(
        json.dumps(
            {canonical(p): e for p, e in entries.items()}, indent=2, sort_keys=True
        )
        + "\n"
    )
    (output / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    )
    return entries


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--syntax", type=Path, required=True)
    parser.add_argument("--schemas", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    modules = json.loads(args.syntax.read_text())
    schemas = json.loads(args.schemas.read_text())
    guides = {str(p): p.read_text() for p in sorted(Path("rules").rglob("DOC.md"))}
    args.output.mkdir(parents=True, exist_ok=True)
    render(modules, schemas, args.output, guides)


if __name__ == "__main__":
    main()
