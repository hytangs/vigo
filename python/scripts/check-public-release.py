from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEXT_SUFFIXES = {".md", ".py", ".sh", ".toml", ".yml", ".yaml", ".mjs", ".json", ".ipynb", ".html", ".css", ".js"}
PRIVATE_PATTERNS = (
    re.compile(r"/(?:Users|home)/[^/\s]+/"),
    re.compile(r"[A-Za-z]:\\Users\\[^\\\s]+\\"),
    re.compile(r"\bgh[opsu]_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"vigo-(?:bench|paper)|/private/var/folde[r]s/"),
    re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----"),
)


def files() -> list[Path]:
    completed = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    return [
        ROOT / item.decode()
        for item in completed.stdout.split(b"\0")
        if item and (ROOT / item.decode()).is_file()
    ]


def main() -> None:
    problems: list[str] = []
    public = files()
    for path in public:
        relative = path.relative_to(ROOT)
        if any(part in {"dist", "build", ".venv"} for part in relative.parts):
            problems.append(f"generated output is tracked: {relative}")
        if path.name.startswith(".env") or path.suffix.lower() in {".sqlite", ".db", ".pem", ".key", ".node", ".whl"}:
            problems.append(f"private or generated file: {relative}")
        if (
            path.suffix.lower() not in TEXT_SUFFIXES
            or path.name == "LICENSE"
            or path == Path(__file__)
        ):
            continue
        text = path.read_text(encoding="utf-8")
        for pattern in PRIVATE_PATTERNS:
            if pattern.search(text):
                problems.append(f"private value: {relative}")
    pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    runtime = (ROOT / "vigo" / "runtime.py").read_text(encoding="utf-8")
    version = re.search(r'^version = "([^"]+)"', pyproject, re.MULTILINE)
    runtime_version = re.search(r'^VERSION = "([^"]+)"', runtime, re.MULTILINE)
    if 'name = "vigo"' not in pyproject or not version or not runtime_version or version[1] != runtime_version[1]:
        problems.append("package name or version differs")
    if problems:
        raise SystemExit("\n".join(problems))
    print(
        json.dumps(
            {"status": "passed", "files": len(public), "version": version[1] if version else None}, indent=2
        )
    )


if __name__ == "__main__":
    main()
