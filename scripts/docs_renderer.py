"""Small, offline Markdown renderer for the VIGO documentation sources.

It supports the subset the sources use: headings, paragraphs, flat lists,
tables, fenced code, block quotes and GitHub alert callouts. Two conventions
add structure without leaving plain Markdown: a list whose every item starts
with a bold link becomes a card grid, and consecutive fenced blocks carrying
``tab="Label"`` (or ``platform=unix|windows``) become one tabbed example.
"""

import html
import re


def slug(title):
    return re.sub(r"[^\w\-\s]", "", re.sub(r"<[^>]*>", "", title.lower())).replace(
        " ", "-"
    )


def inline(source):
    tokens = []

    def keep(value):
        tokens.append(value)
        return f"\x00{len(tokens) - 1}\x00"

    def code(match):
        value = html.escape(match[1])
        if re.fullmatch(r"[A-Za-z][A-Za-z0-9_.<>,]*", match[1]):
            pieces = re.split(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[._<>,])", match[1])
            value = "<wbr>".join(html.escape(piece) for piece in pieces)
        return keep("<code>" + value + "</code>")

    source = re.sub(
        r"!\[([^\]]*)\]\(([^)]+)\)",
        lambda m: keep(
            '<img alt="'
            + html.escape(m[1], quote=True)
            + '" src="'
            + html.escape(m[2], quote=True)
            + '" loading="lazy">'
        ),
        source,
    )
    source = re.sub(r"`([^`]+)`", code, source)
    source = html.escape(source)
    source = re.sub(
        r"\[([^\]]+)\]\(([^)]+)\)",
        lambda m: '<a href="' + m[2] + '">' + m[1] + "</a>",
        source,
    )
    source = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", source)
    source = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", source)
    return re.sub(r"\x00(\d+)\x00", lambda m: tokens[int(m[1])], source)


def _tokens(source, pattern, kinds):
    """Escape source while wrapping regex groups in syntax spans."""
    pieces = []
    offset = 0
    for match in re.finditer(pattern, source, re.MULTILINE):
        kind = next(
            (kinds[name] for name, value in match.groupdict().items() if value),
            None,
        )
        pieces.append(html.escape(source[offset : match.start()]))
        token = html.escape(match[0])
        pieces.append(f'<span class="syntax-{kind}">{token}</span>' if kind else token)
        offset = match.end()
    pieces.append(html.escape(source[offset:]))
    return "".join(pieces)


def _json(source):
    pieces = []
    offset = 0
    for match in re.finditer(
        r'"(?:\\.|[^"\\])*"|(?<![\w.])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b',
        source,
    ):
        pieces.append(html.escape(source[offset : match.start()]))
        token = match[0]
        kind = (
            "key"
            if token.startswith('"') and re.match(r"\s*:", source[match.end() :])
            else "string"
            if token.startswith('"')
            else "literal"
        )
        pieces.append(f'<span class="syntax-{kind}">{html.escape(token)}</span>')
        offset = match.end()
    pieces.append(html.escape(source[offset:]))
    return "".join(pieces)


SHELL = (
    r"(?P<comment>(?:^|(?<=\s))#[^\n]*)"
    r"|(?P<string>'[^'\n]*'|\"(?:\\.|[^\"\\\n])*\")"
    r"|(?P<variable>\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)"
    r"|(?P<flag>(?<![\w/.-])--?[A-Za-z][\w-]*)"
)
PYTHON = (
    r"(?P<comment>#[^\n]*)"
    r"|(?P<string>\"\"\"[\s\S]*?\"\"\"|'''[\s\S]*?'''|[rbf]?\"(?:\\.|[^\"\\\n])*\"|[rbf]?'(?:\\.|[^'\\\n])*')"
    r"|(?P<keyword>\b(?:import|from|as|with|def|return|if|elif|else|for|in|while|try|except|raise|class|None|True|False|and|or|not|is|lambda|yield|async|await|print)\b)"
    r"|(?P<literal>\b\d+(?:\.\d+)?\b)"
)
SCRIPT = (
    r"(?P<comment>//[^\n]*|/\*[\s\S]*?\*/)"
    r"|(?P<string>'(?:\\.|[^'\\\n])*'|\"(?:\\.|[^\"\\\n])*\"|`(?:\\.|[^`\\])*`)"
    r"|(?P<keyword>\b(?:const|let|var|function|return|if|else|for|of|in|new|throw|await|async|import|export|from|null|undefined|true|false|typeof)\b)"
    r"|(?P<literal>\b\d+(?:\.\d+)?\b)"
)
INI = r"(?P<comment>^[;#][^\n]*)|(?P<key>^\[[^\]\n]+\])|(?P<flag>^[A-Za-z][\w.]*(?==))"
LANGUAGES = {
    "json": "JSON",
    "jsonl": "NDJSON",
    "ndjson": "NDJSON",
    "sh": "Shell",
    "bash": "Shell",
    "powershell": "PowerShell",
    "python": "Python",
    "js": "JavaScript",
    "javascript": "JavaScript",
    "ini": "INI",
    "text": "",
}


def highlight(source, language):
    if language in ("json", "ndjson", "jsonl"):
        return _json(source)
    kinds = {
        "comment": "comment",
        "string": "string",
        "variable": "literal",
        "flag": "key",
        "keyword": "keyword",
        "literal": "literal",
        "key": "key",
    }
    if language in ("sh", "bash", "powershell"):
        return _tokens(source, SHELL, kinds)
    if language == "python":
        return _tokens(source, PYTHON, kinds)
    if language in ("js", "javascript"):
        return _tokens(source, SCRIPT, kinds)
    if language == "ini":
        return _tokens(source, INI, kinds)
    return html.escape(source)


def code_block(source, language, label=True):
    name = LANGUAGES.get(language, language.upper() if language else "")
    head = (
        f'<span class="code-language">{html.escape(name)}</span>' if label and name else ""
    )
    return (
        f'<div class="code-block" data-language="{html.escape(language or "text", quote=True)}">{head}'
        '<button class="copy" type="button" aria-label="Copy code">Copy</button><pre tabindex="0"><code>'
        + highlight(source, language)
        + "</code></pre></div>"
    )


FENCE = re.compile(
    r"^```([\w-]*)(?:\s+(?:platform=(unix|windows)|tab=\"([^\"]+)\"))?[^\n]*$"
)
ALERTS = {
    "NOTE": "Note",
    "TIP": "Tip",
    "IMPORTANT": "Important",
    "WARNING": "Warning",
    "CAUTION": "Caution",
}


def _tab_group(alternatives, prefix, aria_label):
    buttons = []
    panels = []
    for n, (label, language, body) in enumerate(alternatives):
        identifier = f"{prefix}-{slug(label) or n}"
        buttons.append(
            f'<button type="button" role="tab" id="{identifier}" aria-controls="{identifier}-panel" aria-selected="{str(n == 0).lower()}" tabindex="{0 if n == 0 else -1}" data-tab="{html.escape(label, quote=True)}">{html.escape(label)}</button>'
        )
        panels.append(
            f'<div role="tabpanel" id="{identifier}-panel" aria-labelledby="{identifier}"'
            + (" hidden" if n else "")
            + ">"
            + code_block(body, language, label=False)
            + "</div>"
        )
    return (
        f'<div class="tab-group"><div class="tab-list" role="tablist" aria-label="{html.escape(aria_label, quote=True)}">'
        + "".join(buttons)
        + "</div>"
        + "".join(panels)
        + "</div>"
    )


def _cards(items):
    cards = []
    for item in items:
        match = re.match(r"^\*\*\[([^\]]+)\]\(([^)]+)\)\*\*\s*(.*)$", item)
        title, href, description = match[1], match[2], match[3]
        cards.append(
            f'<li><a class="card" href="{href}"><strong>{inline(title)}</strong>'
            + (f"<span>{inline(description)}</span>" if description else "")
            + "</a></li>"
        )
    return '<ul class="cards">' + "".join(cards) + "</ul>"


def markdown(source, used=None, page_key="", prefix_headings=False):
    used = used if used is not None else {}
    lines = source.splitlines()
    output = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip() or line.startswith("<!--"):
            i += 1
            continue
        if line.startswith("```"):
            first = FENCE.match(line)
            if first and (first[2] or first[3]):
                alternatives = []
                platform = bool(first[2])
                while i < len(lines):
                    match = FENCE.match(lines[i])
                    if not match or not (match[2] if platform else match[3]):
                        break
                    body = []
                    i += 1
                    while i < len(lines) and not lines[i].startswith("```"):
                        body.append(lines[i])
                        i += 1
                    label = (
                        ("macOS / Linux" if match[2] == "unix" else "Windows")
                        if platform
                        else match[3]
                    )
                    alternatives.append((label, match[1], "\n".join(body)))
                    i += 1
                    while i < len(lines) and not lines[i].strip():
                        i += 1
                number = used.get("_tab_groups", 0) + 1
                used["_tab_groups"] = number
                prefix = f"{page_key}--tabs-{number}" if prefix_headings else f"tabs-{number}"
                output.append(
                    _tab_group(
                        alternatives,
                        prefix,
                        "Operating system" if platform else "Example",
                    )
                )
                continue
            lang = line[3:].split(" ")[0]
            body = []
            i += 1
            while i < len(lines) and not lines[i].startswith("```"):
                body.append(lines[i])
                i += 1
            output.append(code_block("\n".join(body), lang))
            i += 1
            continue
        heading = re.match(r"^(#{1,6})\s+(.+)$", line)
        if heading:
            level = len(heading[1])
            title = heading[2]
            identifier = (
                page_key + "--" + slug(title) if prefix_headings else slug(title)
            )
            n = used.get(identifier, 0)
            used[identifier] = n + 1
            if n:
                identifier += "-" + str(n)
            output.append(f'<h{level} id="{identifier}">{inline(title)}</h{level}>')
            i += 1
            continue
        if line.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                cells = re.split(r"(?<!\\)\|", lines[i].strip().strip("|"))
                if not all(re.fullmatch(r"\s*:?-+:?\s*", c) for c in cells):
                    rows.append([inline(c.strip().replace("\\|", "|")) for c in cells])
                i += 1
            table_class = ""
            if (
                rows[0][:2] == ["JSON field", "Rust / JSON type"]
                and rows[0][-1] == "Meaning"
            ):
                # Keep each description with its field and omit empty notes.
                # The Markdown dictionary retains the original four columns.
                rows = [["JSON field", "Rust type", rows[0][2]]] + [
                    [
                        field
                        + (
                            '<p class="field-description">' + description + "</p>"
                            if description != "—"
                            else ""
                        ),
                        typ,
                        required,
                    ]
                    for field, typ, required, description in rows[1:]
                ]
                table_class = ' class="field-table"'
            head = "".join('<th scope="col">' + c + "</th>" for c in rows[0])
            body = []
            for row in rows[1:]:
                code = re.search(r"<code>(.*?)</code>", row[0])
                attributes = ""
                if code and page_key:
                    label = html.unescape(re.sub(r"<[^>]+>", "", code[1]))
                    identifier = page_key + "--" + slug(label)
                    n = used.get(identifier, 0)
                    used[identifier] = n + 1
                    if n:
                        identifier += "-" + str(n)
                    attributes = f' id="{identifier}" data-search-label="{html.escape(label, quote=True)}" tabindex="-1"'
                # Narrow screens label stacked cells from the header at runtime.
                cells = "".join("<td>" + cell + "</td>" for cell in row)
                body.append("<tr" + attributes + ">" + cells + "</tr>")
            body = "".join(body)
            output.append(
                '<div class="table-wrap"><table'
                + table_class
                + "><thead><tr>"
                + head
                + "</tr></thead><tbody>"
                + body
                + "</tbody></table></div>"
            )
            continue
        if re.match(r"^(?:- |[0-9]+\. )", line):
            ordered = bool(re.match(r"^[0-9]+\. ", line))
            items = []
            pattern = r"^[0-9]+\. " if ordered else r"^- "
            while i < len(lines) and re.match(pattern, lines[i]):
                item = [re.sub(pattern, "", lines[i])]
                i += 1
                while i < len(lines) and lines[i].startswith("  "):
                    item.append(lines[i].strip())
                    i += 1
                items.append(" ".join(item))
            if not ordered and all(
                re.match(r"^\*\*\[[^\]]+\]\([^)]+\)\*\*", item) for item in items
            ):
                output.append(_cards(items))
                continue
            tag = "ol" if ordered else "ul"
            output.append(
                "<"
                + tag
                + ">"
                + "".join("<li>" + inline(item) + "</li>" for item in items)
                + "</"
                + tag
                + ">"
            )
            continue
        if line.startswith(">"):
            quote = []
            while i < len(lines) and lines[i].startswith(">"):
                quote.append(lines[i][1:].strip())
                i += 1
            alert = re.fullmatch(r"\[!(\w+)\]", quote[0]) if quote else None
            if alert and alert[1] in ALERTS:
                kind = alert[1].lower()
                text = " ".join(part for part in quote[1:] if part)
                output.append(
                    f'<aside class="callout callout-{kind}"><p class="callout-title">{ALERTS[alert[1]]}</p><p>{inline(text)}</p></aside>'
                )
            else:
                output.append(
                    "<blockquote><p>" + inline(" ".join(quote)) + "</p></blockquote>"
                )
            continue
        paragraph = [line]
        i += 1
        while (
            i < len(lines)
            and lines[i].strip()
            and not re.match(r"^(#|```|\||- |[0-9]+\. |>|<!--)", lines[i])
        ):
            paragraph.append(lines[i])
            i += 1
        output.append("<p>" + inline(" ".join(paragraph)) + "</p>")
    return "\n".join(output)
