"""Build the single offline VIGO guide from its Markdown sources, without dependencies.

``docs/navigation.json`` lists every page. A page renders one Markdown file,
one section of a file, or several sections composed in order. The output is a
self-contained HTML document: Studio embeds it, the engine serves it, and it
opens directly from disk.
"""

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
REPOSITORY = "https://github.com/hytangs/vigo"



def _asset(name: str) -> str:
    data = base64.b64encode((ROOT / "scripts" / "docs-brand" / name).read_bytes()).decode("ascii")
    return f"data:image/png;base64,{data}"


# The VIGO logo artwork, cut from the supplied lockup; the dark variants only
# lighten its ink. Embedded so the guide stays one offline file.
LOGO = (
    f'<img class="brand-logo brand-logo-light" src="{_asset("vigo-lockup-light.png")}" alt="VIGO" width="130" height="24">'
    f'<img class="brand-logo brand-logo-dark" src="{_asset("vigo-lockup-dark.png")}" alt="" width="130" height="24">'
)
FAVICON = _asset("vigo-mark-light.png")
FAVICON_DARK = _asset("vigo-mark-dark.png")
ICONS = {
    "search": '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>',
    "menu": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    "sun": '<svg class="icon-light" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>',
    "moon": '<svg class="icon-dark" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
    "github": '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="fill" d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.4 1.1 2.9.8.1-.6.4-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.8 1a9.6 9.6 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10 10 0 0 0 12 2z"/></svg>',
    "link": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/></svg>',
    "source": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 8-4 4 4 4M15 8l4 4-4 4"/></svg>',
    "print": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 9V4h10v5M7 17H5a1 1 0 0 1-1-1v-5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5a1 1 0 0 1-1 1h-2M7 14h10v6H7z"/></svg>',
    "arrow": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    "back": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
    "chevron": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
}


SEPARATOR = '<span aria-hidden="true">/</span>'


SPRITE_ICONS = ("link", "source", "print", "arrow", "back")


def sprite():
    """Define repeated page icons once; pages reference them with <use>."""
    symbols = []
    for name in SPRITE_ICONS:
        inner = re.sub(r"^<svg[^>]*>|</svg>$", "", ICONS[name])
        inner = inner.replace("<path ", '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ')
        symbols.append(f'<symbol id="icon-{name}" viewBox="0 0 24 24">{inner}</symbol>')
    return '<svg class="sprite" width="0" height="0" aria-hidden="true" focusable="false">' + "".join(symbols) + "</svg>"


def icon(name):
    return f'<svg aria-hidden="true" focusable="false"><use href="#icon-{name}"/></svg>'


def headings(source):
    """Yield (line, level, title, anchor) for Markdown headings outside fences."""
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


class Source:
    """One Markdown file with its heading table."""

    cache: dict[Path, "Source"] = {}

    def __init__(self, path):
        self.path = path
        self.text = path.read_text(encoding="utf-8")
        self.lines = self.text.splitlines()
        self.entries = list(headings(self.text))

    @classmethod
    def load(cls, relative):
        path = (ROOT / relative).resolve()
        if path not in cls.cache:
            cls.cache[path] = cls(path)
        return cls.cache[path]

    def section(self, anchor=None, exclude=(), intro=False):
        """Return (title, level, lines, entries, heading) for a heading's section.

        ``intro`` keeps only the text before the section's first subheading.
        """
        if anchor:
            matches = [entry for entry in self.entries if entry[3] == anchor]
            assert matches, f"{self.path.relative_to(ROOT)}: missing section #{anchor}"
            start, level, title, _ = matches[0]
            end = next(
                (e[0] for e in self.entries if e[0] > start and e[1] <= level),
                len(self.lines),
            )
        else:
            start, level, title, _ = self.entries[0]
            end = len(self.lines)
        if intro:
            end = next((e[0] for e in self.entries if e[0] > start), end)
        removed = set()
        for anchor_name in exclude:
            matches = [e for e in self.entries if e[3] == anchor_name]
            assert matches, f"{self.path.relative_to(ROOT)}: missing excluded #{anchor_name}"
            x_start, x_level = matches[0][0], matches[0][1]
            x_end = next(
                (e[0] for e in self.entries if e[0] > x_start and e[1] <= x_level),
                len(self.lines),
            )
            removed.update(range(x_start, min(x_end, end)))
        kept = [n for n in range(start + 1, end) if n not in removed]
        entries = [e for e in self.entries if start < e[0] < end and e[0] not in removed]
        return title, level, [self.lines[n] for n in kept], entries, self.entries_at(start)

    def entries_at(self, line):
        return next(entry for entry in self.entries if entry[0] == line)


def shift_headings(lines, delta):
    """Move Markdown heading levels by delta outside fenced code."""
    fenced = False
    result = []
    for line in lines:
        if line.startswith("```"):
            fenced = not fenced
        match = None if fenced else re.match(r"^(#{1,6}) (.+)$", line)
        if match:
            level = min(6, max(2, len(match[1]) + delta))
            line = "#" * level + " " + match[2]
        result.append(line)
    return result


def read_version(relative):
    source = (ROOT / relative).read_text(encoding="utf-8")
    return re.search(r'(?m)^\s*"?version"?\s*[:=]\s*"([^"]+)"', source)[1]


def compose(page):
    """Return (heading, markdown lines, heading origins, source links) for a page."""
    parts = page.get("sections") or [
        {
            "source": page["source"],
            "section": page.get("section"),
            "exclude": page.get("exclude", []),
            "intro": page.get("intro", False),
        }
    ]
    lines = []
    origins = []  # Parallel to emitted headings: (path, anchor) of the source heading.
    sources = []
    heading = None
    for n, part in enumerate(parts):
        source = Source.load(part["source"])
        title, level, body, entries, own = source.section(
            part.get("section"), part.get("exclude", ()), part.get("intro", False)
        )
        sources.append((source.path, part.get("section")))
        if n == 0:
            heading = title
            delta = 2 - (level + 1)
            anchors_owner = (source.path, own[3])
            origins.append(("page", anchors_owner))
        else:
            # Later parts become a second-level section of the composed page.
            delta = 3 - (level + 1)
            label = part.get("title", title)
            lines += ["", "## " + label, ""]
            origins.append(("heading", (source.path, own[3])))
        if n and source.path.parent != sources[0][0].parent:
            body = relink(body, source.path, sources[0][0])
        if part.get("lead") is False:
            body = drop_lead(body)
        lines += shift_headings(body, delta)
        origins += [("heading", (source.path, entry[3])) for entry in entries]
    return heading, lines, origins, sources


def relink(lines, source, base):
    """Rewrite a later part's relative links so they resolve from the page's first source."""
    def target(match):
        url = urlsplit(match[2])
        if url.scheme or url.netloc:
            return match[0]
        path = (source.parent / unquote(url.path)).resolve() if url.path else source
        relative = Path(os.path.relpath(path, base.parent)).as_posix()
        return f"{match[1]}({relative}{'#' + url.fragment if url.fragment else ''})"

    fenced = False
    result = []
    for line in lines:
        if line.startswith("```"):
            fenced = not fenced
        result.append(line if fenced else re.sub(r"(\])\(([^)\s]+)\)", target, line))
    return result


def drop_lead(lines):
    """Remove the first paragraph of a section body (used where a page has its own lead)."""
    index = 0
    while index < len(lines) and not lines[index].strip():
        index += 1
    while index < len(lines) and lines[index].strip():
        index += 1
    return lines[index:]


def split_children(page, lines, origins):
    """Turn each second-level heading of a page into its own child page."""
    children = []
    parent_lines = []
    current = None
    heading_index = 0
    fenced = False
    for line in lines:
        if line.startswith("```"):
            fenced = not fenced
        match = None if fenced else re.match(r"^(#{1,6}) (.+)$", line)
        if match:
            heading_index += 1
        if match and len(match[1]) == 2:
            origin = origins[heading_index]
            current = {
                "id": slug(match[2]),
                "title": match[2],
                "group": page["group"],
                "parent": page["id"],
                "nav": page.get("children_nav", False),
                "source": page["source"],
                "body": [],
                "origin": origin[1],
                "origins": [("page", origin[1])],
                "sources": [(origin[1][0], origin[1][1])],
            }
            children.append(current)
            continue
        if current is None:
            parent_lines.append(line)
        else:
            if match:
                current["origins"].append(origins[heading_index])
            current["body"].append(
                ("#" * (len(match[1]) - 1) + " " + match[2]) if match else line
            )
    kept_origins = origins[: 1 + sum(1 for _ in _headings_in(parent_lines))]
    return parent_lines, kept_origins, children


def _headings_in(lines):
    fenced = False
    for line in lines:
        if line.startswith("```"):
            fenced = not fenced
        if not fenced and re.match(r"^(#{1,6}) (.+)$", line):
            yield line


def rendered_heading_ids(rendered):
    return re.findall(r'<h[1-6] id="([^"]+)"', rendered)


def home_diagram():
    """The City → Query → Result flow drawn on the welcome page."""
    def box(x, y, w, h, label, sub="", kind="node"):
        text_y = y + (h / 2 + 5 if not sub else h / 2 - 3)
        out = f'<g class="flow-{kind}"><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10"/>'
        out += f'<text x="{x + w / 2}" y="{text_y}" text-anchor="middle" class="flow-label">{label}</text>'
        if sub:
            out += f'<text x="{x + w / 2}" y="{y + h / 2 + 14}" text-anchor="middle" class="flow-sub">{sub}</text>'
        return out + "</g>"

    def arrow(x1, y1, x2, y2):
        return f'<path class="flow-arrow" d="M{x1} {y1} C{(x1 + x2) / 2} {y1} {(x1 + x2) / 2} {y2} {x2 - 6} {y2}"/><path class="flow-head" d="M{x2 - 7} {y2 - 4.5} L{x2} {y2} L{x2 - 7} {y2 + 4.5}"/>'

    parts = [
        box(0, 22, 140, 50, "GTFS", "timetables", "input"),
        box(0, 106, 140, 50, "OpenStreetMap", "streets", "input"),
        arrow(140, 47, 190, 89),
        arrow(140, 131, 190, 89),
        box(190, 56, 128, 66, "City", "prepared once", "city"),
        arrow(318, 89, 364, 89),
        box(364, 64, 108, 50, "Scenario", "optional", "optional"),
        arrow(472, 89, 520, 30),
        arrow(472, 89, 520, 89),
        arrow(472, 89, 520, 148),
        box(520, 8, 108, 44, "Route", "", "query"),
        box(520, 67, 108, 44, "Matrix", "", "query"),
        box(520, 126, 108, 44, "Reach", "", "query"),
        arrow(628, 30, 676, 89),
        arrow(628, 89, 676, 89),
        arrow(628, 148, 676, 89),
        box(676, 56, 116, 66, "Result", "status + evidence", "result"),
    ]
    return (
        '<figure class="flow"><svg viewBox="-2 0 796 178" role="img" aria-labelledby="flow-title flow-desc">'
        '<title id="flow-title">How VIGO answers a question</title>'
        '<desc id="flow-desc">GTFS timetables and OpenStreetMap streets are built once into a City. '
        "An optional Scenario changes service for a query. Route, Matrix and Reach queries each return a Result.</desc>"
        + "".join(parts)
        + "</svg><figcaption>Build a City once, then ask it many questions.</figcaption></figure>"
    )


def build(config):
    output = ROOT / config["output"]
    version = read_version(config["version_file"])
    versions = {
        key: read_version(path) for key, path in config.get("versions", {}).items()
    }
    pages = []
    for item in config["pages"]:
        heading, lines, origins, sources = compose(item)
        page = {
            **item,
            "title": item.get("title", heading),
            "heading": item.get("heading", item.get("title", heading)),
            "source_heading": heading,
            "sources": sources,
            "origins": origins,
            "lines": lines,
        }
        if item.get("children"):
            lines, origins, children = split_children(item, lines, origins)
            page["lines"], page["origins"] = lines, origins
            pages.append(page)
            for child in children:
                pages.append(
                    {
                        **child,
                        "heading": child["title"],
                        "lines": child.pop("body"),
                    }
                )
            continue
        pages.append(page)

    ids = [page["id"] for page in pages]
    assert len(ids) == len(set(ids)), "Page IDs must be unique"

    # Pass 1: render Markdown and record where each source heading landed.
    anchors = {}
    files = {}
    for page in pages:
        used = {}
        page["html"] = markdown("\n".join(page["lines"]), used, page["id"], prefix_headings=True)
        rendered = rendered_heading_ids(page["html"])
        heading_origins = [o for o in page["origins"] if o[0] == "heading"]
        assert len(rendered) == len(heading_origins), f"{page['id']}: heading mismatch"
        page_origin = next(o for o in page["origins"] if o[0] == "page")[1]
        anchors.setdefault(page_origin, page["id"])
        files.setdefault(page_origin[0], page["id"])
        for (_, origin), identifier in zip(heading_origins, rendered):
            anchors.setdefault(origin, identifier)

    aliases = {}
    for target, identifier in config.get("aliases", {}).items():
        path, _, fragment = target.partition("#")
        aliases[((ROOT / path).resolve(), fragment)] = identifier
    assets = {(ROOT / path).resolve() for path in config.get("assets", [])}

    def rewrite(match, source_path):
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
            mime = {"png": "image/png", "svg": "image/svg+xml", "jpg": "image/jpeg"}.get(
                path.suffix[1:]
            )
            if mime:
                return f'src="data:{mime};base64,' + base64.b64encode(path.read_bytes()).decode() + '"'
        if path == output.resolve():
            identifier = fragment or "overview"
            return f'{attribute}="#{identifier}"'
        identifier = (
            aliases.get((path, fragment))
            or anchors.get((path, fragment))
            or (aliases.get((path, "")) if fragment else None)
            or (files.get(path) if not fragment else None)
        )
        if not identifier and fragment and path in files:
            unresolved.append(f"{source_path.relative_to(ROOT)}: {target}")
            return match[0]
        if identifier:
            return f'{attribute}="#{identifier}"'
        if path in assets:
            relative = Path(os.path.relpath(path, output.parent)).as_posix()
            return f'{attribute}="{html.escape(relative, quote=True)}"'
        assert path.is_relative_to(ROOT) and path.exists(), f"Missing link target {target}"
        url = f"{REPOSITORY}/blob/main/{path.relative_to(ROOT).as_posix()}"
        if path.is_dir():
            url = url.replace("/blob/", "/tree/")
        return f'{attribute}="{html.escape(url + ("#" + split.fragment if split.fragment else ""), quote=True)}"'

    unresolved = []
    for page in pages:
        source_path = page["sources"][0][0]
        page["html"] = re.sub(
            r'(href|src)="([^"]+)"', lambda m: rewrite(m, source_path), page["html"]
        )

    assert not unresolved, "Unresolved links:\n" + "\n".join(sorted(set(unresolved)))

    groups = []
    for group in config["groups"]:
        groups.append({**group, "pages": [p for p in pages if p.get("group") == group["id"]]})
    known = {group["id"] for group in groups}
    assert all(page["group"] in known for page in pages), "Every page needs a known group"

    def nav_link(page, depth=0):
        children = [p for p in pages if p.get("parent") == page["id"] and p.get("nav", True)]
        label = html.escape(page.get("label", page["title"]))
        link = f'<a href="#{page["id"]}" data-nav="{page["id"]}">{label}</a>'
        if not children:
            return f"<li>{link}</li>"
        return (
            f'<li class="has-children" data-parent="{page["id"]}">{link}<ul class="nav-children">'
            + "".join(nav_link(child, depth + 1) for child in children)
            + "</ul></li>"
        )

    nav = "".join(
        f'<section class="nav-group" data-group="{group["id"]}"><h2>{html.escape(group["title"])}</h2><ul>'
        + "".join(
            nav_link(p)
            for p in group["pages"]
            if p.get("nav", True) and not p.get("parent")
        )
        + "</ul></section>"
        for group in groups
    )

    sequence = [p for group in groups for p in group["pages"] if not p.get("parent") or p.get("nav", True)]
    group_titles = {group["id"]: group["title"] for group in groups}
    by_id = {page["id"]: page for page in pages}
    articles = []
    for page in pages:
        rendered = page["html"]
        if page["id"] == "overview":
            articles.append(home(page, config, version, rendered))
            continue
        if page.get("tool") == "viewer":
            rendered += VIEWER
        if page.get("tool") == "console":
            rendered += CONSOLE
        sections = re.findall(r'<h([23]) id="([^"]+)">(.+?)</h\1>', rendered)
        outline = (
            '<aside class="page-outline" aria-label="On this page"><p>On this page</p><nav>'
            + "".join(
                f'<a href="#{key}" class="depth-{level}">{re.sub(r"<[^>]+>", "", title)}</a>'
                for level, key, title in sections
            )
            + "</nav></aside>"
            if len([s for s in sections if s[0] == "2"]) > 1
            else ""
        )
        pagination = []
        siblings = (
            [p for p in pages if p.get("parent") == page["parent"]]
            if page.get("parent") and not page.get("nav", True)
            else sequence
        )
        if page in siblings:
            position = siblings.index(page)
            for offset, label, rel, icon_name in [(-1, "Previous", "prev", "back"), (1, "Next", "next", "arrow")]:
                if 0 <= position + offset < len(siblings):
                    target = siblings[position + offset]
                    pagination.append(
                        f'<a class="{label.lower()}" href="#{target["id"]}" rel="{rel}"><span>{label}</span><strong>{html.escape(target.get("label", target["title"]))}</strong>{icon(icon_name)}</a>'
                    )
        crumbs = [f'<span>{html.escape(group_titles[page["group"]])}</span>']
        if page.get("parent"):
            parent = by_id[page["parent"]]
            crumbs.append(f'<a href="#{parent["id"]}">{html.escape(parent["title"])}</a>')
        badge = page.get("badge", "")
        if badge:
            badge = f'<span class="page-badge">{html.escape(badge.format(version=version, **versions))}</span>'
        source_path, section = page["sources"][0]
        source_url = f"{REPOSITORY}/blob/main/{source_path.relative_to(ROOT).as_posix()}" + (
            f"#{section}" if section else ""
        )
        words = len(re.sub(r"<[^>]+>", " ", rendered).split())
        minutes = max(1, round(words / 230))
        title = page.get("heading", page["title"])
        if page.get("parent") and by_id[page["parent"]].get("children"):
            title = re.sub(r"(?<=[a-z])(?=[A-Z])", "<wbr>", html.escape(title))
        else:
            title = html.escape(title)
        articles.append(
            f'<article class="doc-page" id="page-{page["id"]}" data-page="{page["id"]}" data-title="{html.escape(page["title"], quote=True)}" data-group="{html.escape(group_titles[page["group"]], quote=True)}" data-nav="{page.get("parent", page["id"]) if not page.get("nav", True) else page["id"]}"{(' data-parent="' + page["parent"] + '"') if page.get("parent") else ""} hidden>'
            f'<header class="page-header"><nav class="breadcrumb" aria-label="Breadcrumb">{SEPARATOR.join(crumbs)}</nav>'
            f'<h1 id="{page["id"]}" tabindex="-1">{title}</h1>'
            f'<div class="page-meta">{badge}<span>{minutes} min read</span>'
            f'<span class="page-actions"><button type="button" data-copy-link title="Copy a link to this page">{icon("link")}<span>Copy link</span></button>'
            f'<a href="{html.escape(source_url, quote=True)}" title="View the Markdown source on GitHub">{icon("source")}<span>Source</span></a>'
            f'<button type="button" data-print title="Print this page">{icon("print")}<span>Print</span></button></span></div></header>'
            f'{outline}<div class="page-body">{rendered}</div>'
            f'<footer class="page-footer"><nav class="pagination" aria-label="Page navigation">{"".join(pagination)}</nav></footer></article>'
        )

    css = (ROOT / "scripts/docs.css").read_text(encoding="utf-8")
    js = (ROOT / "scripts/docs.js").read_text(encoding="utf-8")
    js += "\n" + (ROOT / "scripts/docs-viewer.js").read_text(encoding="utf-8")
    links = "".join(
        f'<a href="{html.escape(link["href"], quote=True)}"'
        + (" download" if link.get("download") else "")
        + f">{ICONS['github'] if link.get('icon') == 'github' else ''}<span>{html.escape(link['label'])}</span></a>"
        for link in config["links"]
    )
    product = html.escape(config["product"])
    theme_boot = (
        "(function(){var d=document.documentElement,q=new URLSearchParams(location.search),t=q.get('theme'),s;"
        "if(q.get('embedded')==='1'){d.dataset.embedded='true';}"
        "if(t!=='light'&&t!=='dark'){try{s=localStorage.getItem('vigo-docs-theme')}catch(e){}"
        "t=s==='light'||s==='dark'?s:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');}"
        "d.dataset.theme=t;})();"
    )
    result = f'''<!doctype html>
<html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="description" content="{html.escape(config["description"].format(version=version), quote=True)}"><title>{product} {version} documentation</title><link rel="icon" href="{FAVICON}" media="(prefers-color-scheme: light)"><link rel="icon" href="{FAVICON_DARK}" media="(prefers-color-scheme: dark)"><script>{theme_boot}</script><style>{css}</style></head>
<body data-product="{product}" data-version="{version}" data-source-root="{REPOSITORY}/blob/main/">{sprite()}<a class="skip" href="#content">Skip to content</a>
<header class="site-header"><button class="icon-button menu-button" type="button" aria-controls="sidebar" aria-expanded="false" aria-label="Open navigation">{ICONS["menu"]}</button><a class="brand" href="#overview" aria-label="{product} documentation home">{LOGO}<span class="brand-section">Docs</span></a><span class="version-pill" title="Documentation for {product} {version}">v{version}</span>
<button class="search-trigger" type="button" data-search-open aria-haspopup="dialog">{ICONS["search"]}<span>Search the docs</span><kbd>/</kbd></button>
<nav class="header-links" aria-label="Project">{links}</nav><button id="theme-toggle" class="icon-button" type="button" aria-label="Switch to dark theme">{ICONS["sun"]}{ICONS["moon"]}</button></header>
<div class="layout"><aside class="sidebar" id="sidebar" aria-label="Documentation"><div class="sidebar-search"><button class="search-trigger" type="button" data-search-open aria-haspopup="dialog">{ICONS["search"]}<span>Search</span><kbd>/</kbd></button></div><nav id="chapters" aria-label="Chapters">{nav}</nav><p class="sidebar-footer">{product} {version} · Apache-2.0</p></aside><div class="scrim" data-close-sidebar hidden></div>
<main id="content" tabindex="-1">{"".join(articles)}</main></div>
<div class="search-dialog" id="search-dialog" role="dialog" aria-modal="true" aria-label="Search documentation" hidden><div class="search-panel"><div class="search-field">{ICONS["search"]}<label class="sr-only" for="search">Search documentation</label><input id="search" type="search" placeholder="Search pages, fields, commands…" autocomplete="off" spellcheck="false" aria-controls="search-links" aria-describedby="search-status"><button class="search-close" type="button" data-search-close>Esc</button></div><p id="search-status" role="status"></p><div id="search-links" role="listbox" aria-label="Results"></div><p class="search-hints"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>Esc</kbd> close</span></p></div></div>
<span id="copy-status" class="sr-only" role="status"></span><noscript><style>.doc-page[hidden],.tab-group [role="tabpanel"][hidden]{{display:block!important}}.pagination,.page-outline,.search-trigger,.page-actions,#theme-toggle,.menu-button{{display:none!important}}</style></noscript><script>{js}</script></body></html>\n'''
    return output, result, pages


def home(page, config, version, rendered):
    """Render the welcome page: hero, flow diagram, then the overview Markdown."""
    settings = config.get("home", {})
    lead = ""
    match = re.match(r"\s*<p>(.*?)</p>", rendered, re.S)
    if match:
        lead = match[1]
        rendered = rendered[match.end():]
    actions = "".join(
        f'<a class="button{" primary" if action.get("primary") else ""}" href="{html.escape(action["href"], quote=True)}">{html.escape(action["label"])}{ICONS["arrow"] if action.get("primary") else ""}</a>'
        for action in settings.get("actions", [])
    )
    facts = "".join(
        f"<li><strong>{html.escape(fact['value'].format(version=version))}</strong><span>{html.escape(fact['label'])}</span></li>"
        for fact in settings.get("facts", [])
    )
    return (
        f'<article class="doc-page home" id="page-overview" data-page="overview" data-title="{html.escape(page["title"], quote=True)}" data-group="{html.escape(config["groups"][0]["title"], quote=True)}" data-nav="overview">'
        f'<section class="hero"><p class="hero-eyebrow"><span class="pill">{config["product"]} {version}</span>{html.escape(settings.get("eyebrow", ""))}</p>'
        f'<h1 id="overview" tabindex="-1">{html.escape(page["source_heading"])}</h1><p class="hero-lead">{lead}</p>'
        f'<div class="hero-actions">{actions}</div>'
        + (f'<ul class="hero-facts">{facts}</ul>' if facts else "")
        + f"</section>{home_diagram()}"
        f'<div class="page-body">{rendered}</div></article>'
    )


VIEWER = (
    '<section class="tool result-tool" aria-labelledby="result-tool-title">'
    '<div class="tool-head"><h2 id="result-tool-title">Open a Result</h2><p>Files are read in this window and never uploaded. Up to 25 MiB.</p></div>'
    '<label class="dropzone" for="result-file" id="result-drop"><strong>Drop a Result JSON here</strong><span>or choose a file</span>'
    '<input id="result-file" type="file" accept=".json,application/json"></label>'
    '<div class="tool-actions"><button type="button" class="button" data-sample="route">Try a sample Route</button><button type="button" class="button" data-sample="matrix">Sample Matrix</button><button type="button" class="button" data-sample="reach">Sample Reach</button></div>'
    '<div id="result-answer" role="status" aria-live="polite">No Result open yet.</div>'
    '<div id="result-visual"></div>'
    '<details class="raw-json"><summary>Original JSON</summary><pre id="result-raw">No file selected.</pre></details>'
    "</section>"
)

CONSOLE = (
    '<section class="tool api-console" aria-labelledby="console-title" id="api-console">'
    '<div class="tool-head"><h2 id="console-title">Send a request</h2><p id="console-state" role="status">Checking for a VIGO service at this address…</p></div>'
    '<form id="console-form" class="console-form" hidden><div class="console-row">'
    '<label>Endpoint<select id="console-endpoint"><option value="POST /v1/route">POST /v1/route</option><option value="POST /v1/matrix">POST /v1/matrix</option>'
    '<option value="POST /v1/reach">POST /v1/reach</option><option value="POST /v1/compare">POST /v1/compare</option><option value="POST /v1/native">POST /v1/native</option>'
    '<option value="GET /v1/info">GET /v1/info</option><option value="GET /v1/capabilities">GET /v1/capabilities</option><option value="GET /readyz">GET /readyz</option></select></label>'
    '<label><span>Bearer token <span class="optional">(kept in this tab only)</span></span><input id="console-token" type="password" autocomplete="off" placeholder="Only if VIGO_API_TOKEN is set"></label></div>'
    '<label><span>Request body <span class="optional">(⌘/Ctrl + Enter sends)</span></span><textarea id="console-body" spellcheck="false" rows="12"></textarea></label>'
    '<div class="tool-actions"><button class="button primary" type="submit">Send request</button><button class="button" type="button" id="console-example">Reset example</button><span id="console-timing"></span></div></form>'
    '<div id="console-answer"></div><details class="raw-json" id="console-raw-wrap" hidden><summary>Response JSON</summary><pre id="console-raw"></pre></details>'
    "</section>"
)


def validate_sources():
    """Check Markdown links, anchors and executable Python examples."""
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
            if language.split(" ")[0] == "python":
                ast.parse(code, filename=path.relative_to(ROOT).as_posix())
                snippets += 1
        prose = re.sub(r"^```[^\n]*\n.*?^```", "", source, flags=re.MULTILINE | re.DOTALL)
        for target in re.findall(r"!?\[[^\]]*\]\(([^)]+)\)", prose):
            url = urlsplit(target)
            if url.scheme or url.netloc:
                continue
            destination = (path.parent / unquote(url.path)).resolve() if url.path else path
            assert destination.is_relative_to(ROOT), f"Link outside repository: {target}"
            assert destination.exists(), f"{path.name}: missing link {target}"
            if url.fragment and destination.suffix == ".md":
                ids = {entry[3] for entry in headings(destination.read_text(encoding="utf-8"))}
                assert unquote(url.fragment) in ids, f"{path.name}: missing anchor {target}"
            links += 1
    return {"links": links, "pythonExamples": snippets}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    config = json.loads((ROOT / "docs/navigation.json").read_text(encoding="utf-8"))
    output, result, pages = build(config)
    ids = re.findall(r'\bid="([^"]+)"', result)
    duplicates = sorted({i for i in ids if ids.count(i) > 1})
    assert not duplicates, f"Documentation has duplicate IDs: {duplicates[:10]}"
    known = set(ids)
    for target in re.findall(r'href="#([^"]+)"', result):
        assert unquote(target) in known, f"Broken generated anchor: {target}"
    assert not re.search(r'<(?:script|link)[^>]+(?:src|href)="https?:', result), "The guide must not fetch assets"
    if args.check:
        assert output.read_text(encoding="utf-8") == result, (
            "The guide is stale: run npm run docs:build"
        )
    else:
        output.write_text(result, encoding="utf-8")
    validation = validate_sources()
    print(
        json.dumps(
            {
                "status": "current" if args.check else "generated",
                "pages": len(pages),
                "bytes": len(result.encode("utf-8")),
                **validation,
                "output": config["output"],
            }
        )
    )


if __name__ == "__main__":
    main()
