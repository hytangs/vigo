"""Build the current documentation reader from its Markdown sources, without dependencies."""

from __future__ import annotations

import argparse
import ast
import base64
import html
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

sys.dont_write_bytecode = True

from docs_renderer import markdown, slug

ROOT = Path(__file__).resolve().parents[1]


def headings(source):
    fenced = False
    used = {}
    for index, line in enumerate(source.splitlines()):
        if line.startswith("```"):
            fenced = not fenced
        if fenced:
            continue
        match = re.match(r"^(#{1,6}) (.+)$", line)
        if match:
            anchor = slug(match[2])
            count = used.get(anchor, 0)
            used[anchor] = count + 1
            yield (
                index,
                len(match[1]),
                match[2],
                anchor + (f"-{count}" if count else ""),
            )


def build(config):
    output = ROOT / config["output"]
    version_source = (ROOT / config["version_file"]).read_text(encoding="utf-8")
    version = re.search(r'(?m)^\s*"?version"?\s*[:=]\s*"([^"]+)"', version_source)[1]
    pages = []
    anchors = {}
    files = {}
    for item in config["pages"]:
        path = ROOT / item["source"]
        source = path.read_text(encoding="utf-8")
        entries = list(headings(source))
        selected = (
            next(entry for entry in entries if entry[3] == item["section"])
            if item.get("section")
            else entries[0]
        )
        start, level, title, anchor = selected
        end = (
            next(
                (
                    entry[0]
                    for entry in entries
                    if entry[0] > start and entry[1] <= level
                ),
                len(source.splitlines()),
            )
            if item.get("section")
            else len(source.splitlines())
        )
        body = "\n".join(source.splitlines()[start + 1 : end])
        if item.get("section"):
            body = re.sub(r"(?m)^(#{3,6}) ", lambda m: m[1][1:] + " ", body)
        page = {
            **item,
            "title": item.get("title", title),
            "body": body,
            "heading": title if item["id"] == "overview" else item.get("title", title),
            "path": path,
        }
        pages.append(page)
        files.setdefault(path, item["id"])
        anchors[(path, anchor)] = item["id"]
        for _, _, heading_title, heading_anchor in entries:
            if any(
                entry[0] > start and entry[0] < end and entry[3] == heading_anchor
                for entry in entries
            ):
                anchors[(path, heading_anchor)] = (
                    item["id"] + "--" + slug(heading_title)
                )
    logo = ROOT / config["logo"]
    embedded_logo = (
        "data:image/png;base64," + base64.b64encode(logo.read_bytes()).decode()
    )
    readers = {
        (ROOT / reader["source"]).resolve(): reader
        for reader in config.get("readers", [])
    }
    groups = {}
    for page in pages:
        if page.get("nav", True):
            groups.setdefault(page["group"], []).append(page)
    nav = "".join(
        '<section class="nav-group"><h2>'
        + html.escape(group)
        + "</h2>"
        + "".join(
            '<a href="#'
            + p["id"]
            + '" data-nav="'
            + p["id"]
            + '">'
            + html.escape(p["title"])
            + "</a>"
            for p in group_pages
        )
        + "</section>"
        for group, group_pages in groups.items()
    )
    articles = []
    for position, p in enumerate(pages):
        rendered = markdown(p["body"], {}, p["id"], prefix_headings=True)

        def rewrite(match, source_path=p["path"]):
            attribute, target = match[1], html.unescape(match[2])
            split = urlsplit(target)
            if split.scheme or split.netloc:
                return match[0]
            path = (
                (source_path.parent / unquote(split.path)).resolve()
                if split.path
                else source_path
            )
            fragment = unquote(split.fragment)
            if attribute == "src" and path.is_file():
                mime = {
                    "png": "image/png",
                    "svg": "image/svg+xml",
                    "jpg": "image/jpeg",
                }.get(path.suffix[1:])
                if mime:
                    return (
                        f'src="data:{mime};base64,'
                        + base64.b64encode(path.read_bytes()).decode()
                        + '"'
                    )
            if path in readers:
                reader = readers[path]
                target = Path(
                    os.path.relpath(ROOT / reader["output"], output.parent)
                ).as_posix()
                target += "#" + (split.fragment or reader.get("default", "overview"))
                return attribute + '="' + html.escape(target, quote=True) + '"'
            identifier = anchors.get((path, fragment)) if fragment else files.get(path)
            if identifier:
                return f'{attribute}="#{identifier}"'
            if split.path:
                target = Path(os.path.relpath(path, output.parent)).as_posix() + (
                    "#" + split.fragment if split.fragment else ""
                )
            return attribute + '="' + html.escape(target, quote=True) + '"'

        rendered = re.sub(r'(href|src)="([^"]+)"', rewrite, rendered)
        if p.get("parent"):
            rendered = (
                '<p class="breadcrumb"><a href="#'
                + p["parent"]
                + '">Developer resources</a></p>'
                + rendered
            )
        if p["id"] == "overview":
            rendered = rendered.replace("<ul>", '<ul class="topic-index">', 1)
        if p.get("tool") == "viewer":
            rendered += '<div class="result-tool"><label for="result-file">Choose Result JSON</label><input id="result-file" type="file" accept=".json,application/json"><div id="result-answer" role="status">Your file stays on this device.</div><details><summary>Original JSON</summary><pre id="result-raw">No file selected.</pre></details></div>'
        sections = re.findall(r'<h2 id="([^"]+)">(.+?)</h2>', rendered)
        outline = (
            '<aside class="page-outline" aria-label="On this page"><p>On this page</p><nav>'
            + "".join(f'<a href="#{key}">{title}</a>' for key, title in sections)
            + "</nav></aside>"
            if len(sections) > 1
            else ""
        )
        pagination = []
        sequence = [
            page for page in pages if page.get("nav", True) == p.get("nav", True)
        ]
        position = sequence.index(p)
        for offset, label, rel in [(-1, "Previous", "prev"), (1, "Next", "next")]:
            if 0 <= position + offset < len(sequence):
                target = sequence[position + offset]
                pagination.append(
                    f'<a class="{label.lower()}" href="#{target["id"]}" rel="{rel}"><span>{label}</span>{html.escape(target["title"])}</a>'
                )
        source_link = Path(os.path.relpath(p["path"], output.parent)).as_posix()
        if p.get("section"):
            source_link += "#" + p["section"]
        articles.append(
            f'<article class="doc-page" id="page-{p["id"]}" data-page="{p["id"]}" data-title="{html.escape(p["title"], quote=True)}" data-nav="{p.get("parent", p["id"])}"'
            + (" hidden" if p["id"] != "overview" else "")
            + f'><p class="eyebrow">{html.escape(p["group"])} <span> / {version}</span></p><h1 id="{p["id"]}" tabindex="-1">{html.escape(p["heading"])}</h1>{outline}<div class="page-body">{rendered}</div><footer class="page-meta"><a href="{source_link}">Markdown source</a><span>{html.escape(config["product"])} {version}</span></footer><nav class="pagination" aria-label="Page navigation">'
            + "".join(pagination)
            + "</nav></article>"
        )
    css = (ROOT / "scripts/docs.css").read_text(encoding="utf-8")
    js = (ROOT / "scripts/docs.js").read_text(encoding="utf-8")
    if any(p.get("tool") == "viewer" for p in pages):
        js += "\n" + (ROOT / "scripts/docs-viewer.js").read_text(encoding="utf-8")
    actions = "".join(
        f'<a href="{html.escape(link["href"], quote=True)}">{html.escape(link["label"])}</a>'
        for link in config["links"]
    )
    product = html.escape(config["product"])
    result = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="description" content="{html.escape(config["description"], quote=True)}"><title>{product} {version} documentation</title><style>{css}</style></head>
<body data-product="{product}"><a class="skip" href="#content">Skip to content</a><header class="site-header"><a class="brand" href="#overview" aria-label="{product} documentation"><img src="{embedded_logo}" alt="VIGO" width="148" height="28"></a><span class="site-title">{html.escape(config["label"])} <span class="version">{version}</span></span><div class="header-actions">{actions}<button id="print" type="button">Print</button></div></header>
<details class="sidebar" id="navigation" open><summary>Documentation</summary><div class="sidebar-body"><div class="search-box"><label class="sr-only" for="search">Search documentation</label><input id="search" type="search" placeholder="Search documentation" autocomplete="off" aria-controls="search-results"><span class="search-key" aria-hidden="true">/</span></div><div id="search-results" hidden><p id="search-status" role="status"></p><div id="search-links"></div></div><nav id="chapters" aria-label="Documentation">{nav}</nav></div></details>
<main id="content" tabindex="-1">{"".join(articles)}</main><span id="copy-status" class="sr-only" role="status"></span><noscript><style>.doc-page[hidden],.platform-group [role="tabpanel"][hidden]{{display:block!important}}.pagination,.page-outline,.search-box{{display:none}}</style></noscript><script>{js}</script></body></html>\n'''
    return output, result, pages


def validate_sources():
    """Check Markdown links, anchors and executable Python examples in both repositories."""
    documents = set((ROOT / "docs").rglob("*.md"))
    documents.update(
        path
        for path in [
            ROOT / "README.md",
            ROOT / "CONTRIBUTING.md",
            ROOT / "notebooks/README.md",
        ]
        if path.exists()
    )
    snippets = links = 0
    for path in sorted(documents):
        source = path.read_text(encoding="utf-8")
        for language, code in re.findall(
            r"^```([^\n]*)\n(.*?)^```", source, re.MULTILINE | re.DOTALL
        ):
            if language == "python":
                ast.parse(code, filename=path.relative_to(ROOT).as_posix())
                snippets += 1
        prose = re.sub(
            r"^```[^\n]*\n.*?^```", "", source, flags=re.MULTILINE | re.DOTALL
        )
        for target in re.findall(r"!?\[[^\]]*\]\(([^)]+)\)", prose):
            url = urlsplit(target)
            if url.scheme or url.netloc:
                continue
            destination = (
                (path.parent / unquote(url.path)).resolve() if url.path else path
            )
            assert destination.is_relative_to(ROOT), (
                f"Link outside repository: {target}"
            )
            assert destination.exists(), f"{path.name}: missing link {target}"
            if url.fragment and destination.suffix == ".md":
                ids = {
                    entry[3]
                    for entry in headings(destination.read_text(encoding="utf-8"))
                }
                assert unquote(url.fragment) in ids, (
                    f"{path.name}: missing anchor {target}"
                )
            links += 1
    return {"links": links, "pythonExamples": snippets}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    config = json.loads((ROOT / "docs/navigation.json").read_text(encoding="utf-8"))
    output, result, pages = build(config)
    ids = re.findall(r'\bid="([^"]+)"', result)
    assert len(ids) == len(set(ids)), "Documentation has duplicate IDs"
    for target in re.findall(r'href="#([^"]+)"', result):
        assert unquote(target) in ids, f"Broken generated anchor: {target}"
    if args.check:
        assert output.read_text(encoding="utf-8") == result, (
            "Reader is stale: run python3 scripts/build-docs.py"
        )
    else:
        output.write_text(result, encoding="utf-8")
    validation = validate_sources()
    print(
        json.dumps(
            {
                "status": "current" if args.check else "generated",
                "pages": len(pages),
                **validation,
                "output": config["output"],
            }
        )
    )


if __name__ == "__main__":
    main()
