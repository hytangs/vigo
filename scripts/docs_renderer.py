"""Small, offline Markdown renderer for the VIGO documentation sources."""

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


def code_block(source, language):
    if language in ("json", "ndjson"):
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
        body = "".join(pieces)
    else:
        body = html.escape(source)
    return (
        '<div class="code-block"><button class="copy" type="button" aria-label="Copy code">Copy</button><pre tabindex="0"><code>'
        + body
        + "</code></pre></div>"
    )


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
            platform = re.match(r"^```(\w+) platform=(unix|windows)$", line)
            if platform:
                alternatives = []
                while i < len(lines):
                    match = re.match(r"^```(\w+) platform=(unix|windows)$", lines[i])
                    if not match:
                        break
                    body = []
                    i += 1
                    while i < len(lines) and not lines[i].startswith("```"):
                        body.append(lines[i])
                        i += 1
                    alternatives.append((match[2], match[1], "\n".join(body)))
                    i += 1
                    while i < len(lines) and not lines[i].strip():
                        i += 1
                number = used.get("_platform_groups", 0) + 1
                used["_platform_groups"] = number
                prefix = (
                    f"{page_key}--platform-{number}"
                    if prefix_headings
                    else f"platform-{number}"
                )
                buttons = []
                panels = []
                for n, (system, language, body) in enumerate(alternatives):
                    label = "macOS / Linux" if system == "unix" else "Windows"
                    identifier = f"{prefix}-{system}"
                    buttons.append(
                        f'<button type="button" role="tab" id="{identifier}" aria-controls="{identifier}-panel" aria-selected="{str(n == 0).lower()}" tabindex="{0 if n == 0 else -1}">{label}</button>'
                    )
                    panels.append(
                        f'<div role="tabpanel" id="{identifier}-panel" aria-labelledby="{identifier}"'
                        + (" hidden" if n else "")
                        + ">"
                        + code_block(body, language)
                        + "</div>"
                    )
                output.append(
                    '<div class="platform-group"><div class="platform-tabs" role="tablist" aria-label="Operating system">'
                    + "".join(buttons)
                    + "</div>"
                    + "".join(panels)
                    + "</div>"
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
                cells = "".join(
                    '<td data-column="'
                    + html.escape(
                        html.unescape(re.sub(r"<[^>]+>", "", rows[0][n])), quote=True
                    )
                    + '">'
                    + cell
                    + "</td>"
                    for n, cell in enumerate(row)
                )
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
                items.append("<li>" + inline(" ".join(item)) + "</li>")
            tag = "ol" if ordered else "ul"
            output.append("<" + tag + ">" + "".join(items) + "</" + tag + ">")
            continue
        if line.startswith("> "):
            quote = []
            while i < len(lines) and lines[i].startswith("> "):
                quote.append(lines[i][2:])
                i += 1
            output.append("<blockquote>" + inline(" ".join(quote)) + "</blockquote>")
            continue
        paragraph = [line]
        i += 1
        while (
            i < len(lines)
            and lines[i].strip()
            and not re.match(r"^(#|```|\||- |[0-9]+\. |> |<!--)", lines[i])
        ):
            paragraph.append(lines[i])
            i += 1
        output.append("<p>" + inline(" ".join(paragraph)) + "</p>")
    return "\n".join(output)
