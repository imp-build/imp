#!/usr/bin/env python3
"""Validate the assembled documentation inputs and site."""

from __future__ import annotations

import argparse
import html
import json
import posixpath
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit


LINK_RE = re.compile(r"\[[^\]]*\]\(([^)]+)\)|href=[\"']([^\"']+)")
FENCE_RE = re.compile(r"^\s*```")
STATUS_RE = re.compile(r"^\s*\*\*(Runnable|Illustrative) example\*\*\s*$")


def _route_for_html(path: Path) -> str:
    relative = path.as_posix()
    if relative == "index.html":
        return "/"
    if relative.endswith("/index.html"):
        return "/" + relative[: -len("index.html")]
    return "/" + relative


def _html_routes(site: Path) -> dict[str, Path]:
    return {_route_for_html(path.relative_to(site)): path for path in site.rglob("*.html")}


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, bool]] = []
        self.ids: set[str] = set()
        self._sidebar_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        classes = set((values.get("class") or "").split())
        if tag == "nav" and "docs-sidebar" in classes:
            self._sidebar_depth += 1
        if values.get("id"):
            self.ids.add(values["id"] or "")
        if tag == "a" and values.get("href"):
            self.links.append((html.unescape(values["href"] or ""), self._sidebar_depth > 0))

    def handle_endtag(self, tag: str) -> None:
        if tag == "nav" and self._sidebar_depth:
            self._sidebar_depth -= 1


def _load_pages(site: Path) -> dict[Path, PageParser]:
    pages: dict[Path, PageParser] = {}
    for path in site.rglob("*.html"):
        parser = PageParser()
        parser.feed(path.read_text(encoding="utf-8"))
        pages[path] = parser
    return pages


def _resolve_route(base: str, href: str) -> tuple[str, str]:
    parsed = urlsplit(href)
    path = parsed.path
    if not path:
        path = base
    elif not path.startswith("/"):
        path = urljoin(base, path)
    path = "/" + posixpath.normpath(path.lstrip("/"))
    if path == "/.":
        path = "/"
    if not path.endswith("/") and not Path(path).suffix:
        path += "/"
    return path, parsed.fragment


def _is_external(href: str) -> bool:
    parsed = urlsplit(href)
    if href.startswith("//") or parsed.scheme in {"mailto", "javascript", "data"}:
        return True
    return bool(parsed.netloc and parsed.netloc != "imps.build")


def check_rendered_links(site: Path) -> list[str]:
    routes = _html_routes(site)
    pages = _load_pages(site)
    errors: list[str] = []
    for path, parser in pages.items():
        base = _route_for_html(path.relative_to(site))
        for href, _ in parser.links:
            parsed = urlsplit(href)
            if _is_external(href):
                continue
            route, fragment = _resolve_route(base, href)
            target = routes.get(route)
            if target is None:
                target = site / route.lstrip("/")
                if not target.is_file():
                    errors.append(f"{path.relative_to(site)}: missing link target {href}")
                    continue
            if fragment:
                target_parser = pages.get(target)
                if target_parser is not None and fragment not in target_parser.ids:
                    errors.append(
                        f"{path.relative_to(site)}: missing fragment {fragment!r} in {href}"
                    )
    return errors


def check_navigation(site: Path) -> list[str]:
    routes = _html_routes(site)
    pages = _load_pages(site)
    guide_routes = {route for route in routes if route.startswith("/guide/") and route != "/guide/"}
    sidebar_routes: set[str] = set()
    for path, parser in pages.items():
        if not _route_for_html(path.relative_to(site)).startswith("/guide/"):
            continue
        for href, in_sidebar in parser.links:
            if not in_sidebar:
                continue
            parsed = urlsplit(href)
            if _is_external(href):
                continue
            route, _ = _resolve_route(_route_for_html(path.relative_to(site)), href)
            sidebar_routes.add(route)
    return [
        f"guide page is not present in guide navigation: {route}"
        for route in sorted(guide_routes - sidebar_routes)
    ]


def _source_route(path: Path) -> str | None:
    value = path.as_posix()
    if value == "docs/content/_index.md":
        return "/"
    if value.startswith("docs/content/") and value.endswith(".md"):
        value = value[len("docs/content/") : -len(".md")]
        if value.endswith("/_index"):
            value = value[: -len("/_index")]
        return "/" + value.strip("/") + "/"
    return None


def check_source_links(root: Path, files: list[Path]) -> list[str]:
    errors: list[str] = []
    for path in files:
        route = _source_route(path.relative_to(root))
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            for match in LINK_RE.finditer(line):
                href = match.group(1) or match.group(2) or ""
                parsed = urlsplit(href)
                if _is_external(href) or href.startswith("#"):
                    continue
                if parsed.path.startswith("/"):
                    continue
                source_target = (path.parent / parsed.path).resolve()
                if source_target.is_file() or source_target.is_dir():
                    continue
                if route is None:
                    target = (path.parent / parsed.path).resolve()
                    if not target.is_file() and not target.is_dir():
                        errors.append(f"{path}:{line_number}: missing source link target {href}")
                    continue
                target_route, _ = _resolve_route(route, href)
                if target_route.startswith("/reference/"):
                    continue
                target_path = root / "docs/content" / (target_route.strip("/") + ".md")
                if target_route == "/":
                    target_path = root / "docs/content/_index.md"
                elif not target_path.is_file():
                    target_path = root / "docs/content" / target_route.strip("/") / "_index.md"
                if not target_path.is_file():
                    errors.append(f"{path}:{line_number}: missing source link target {href}")
    return errors


def check_examples(files: list[Path]) -> list[str]:
    errors: list[str] = []
    for path in files:
        if "/docs/content/guide/" not in path.as_posix() or path.name == "_index.md":
            continue
        lines = path.read_text(encoding="utf-8").splitlines()
        has_fence = False
        has_status = False
        for index, line in enumerate(lines):
            if not FENCE_RE.match(line):
                continue
            has_fence = True
            previous = index - 1
            while previous >= 0 and not lines[previous].strip():
                previous -= 1
            if previous >= 0 and STATUS_RE.match(lines[previous]):
                has_status = True
        if has_fence and not has_status:
            errors.append(f"{path}: add a Runnable or Illustrative example label")
    return errors


def check_api_reference(root: Path, api_reference: Path) -> list[str]:
    manifest_path = api_reference / "manifest.json"
    errors: list[str] = []
    if not manifest_path.is_file():
        return ["generated API reference is missing manifest.json"]
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    source_paths = sorted(manifest.get("sources", []))
    missing_sources = [path for path in source_paths if not (root / path).is_file()]
    if missing_sources:
        errors.append("generated API manifest names missing sources: " + ", ".join(missing_sources))
    actual_pages = sorted(
        path.relative_to(api_reference).as_posix()
        for path in api_reference.rglob("*.md")
    )
    expected_pages = sorted(manifest.get("pages", []))
    if actual_pages != expected_pages:
        errors.append(
            "generated API page set differs from manifest: "
            f"expected {len(expected_pages)}, found {len(actual_pages)}"
        )
    empty_pages = [path for path in actual_pages if not (api_reference / path).read_text(encoding="utf-8").strip()]
    if empty_pages:
        errors.append("generated API pages are empty: " + ", ".join(empty_pages))
    return errors


def validate(root: Path, site: Path, api_reference: Path) -> list[str]:
    if (site / "public").is_dir():
        site = site / "public"
    source_files = [
        root / "README.md",
        *sorted((root / "docs/content").rglob("*.md")),
        *sorted((root / "rules").rglob("DOC.md")),
    ]
    errors = []
    errors.extend(check_source_links(root, source_files))
    errors.extend(check_examples(source_files))
    errors.extend(check_api_reference(root, api_reference))
    errors.extend(check_rendered_links(site))
    errors.extend(check_navigation(site))
    return errors


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", type=Path, required=True)
    parser.add_argument("--api-reference", type=Path, required=True)
    args = parser.parse_args(argv)
    errors = validate(Path.cwd(), args.site, args.api_reference)
    if errors:
        print("documentation quality failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("documentation quality: links, navigation, examples, and generated references are clean")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
