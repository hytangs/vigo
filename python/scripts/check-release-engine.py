"""Verify that a tagged Python release bundles the engine from the same repository commit."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from pathlib import Path


def validate(pin: str, actual: str, engine_version: str, wrapper_version: str, tag: str) -> None:
    if not re.fullmatch(r"[0-9a-fA-F]{40}", pin):
        raise ValueError("ENGINE_REF must be the full tagged repository commit.")
    if pin.lower() != actual.lower():
        raise ValueError("Checked-out engine differs from the tagged repository commit.")
    if tag != f"python-v{wrapper_version}":
        raise ValueError("Release tag differs from the Python package version.")
    if not re.fullmatch(r"1\.0\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", engine_version):
        raise ValueError("Python 1.0 releases require an Engine 1.0 runtime.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", type=Path, required=True)
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    version = re.search(r'^version = "([^"]+)"', (project / "pyproject.toml").read_text(), re.MULTILINE)
    if version is None:
        raise SystemExit("Missing Python package version")
    engine_version = json.loads((args.engine / "package.json").read_text())["version"]
    actual = subprocess.check_output(["git", "-C", str(args.engine), "rev-parse", "HEAD"], text=True).strip()
    try:
        validate(os.environ.get("ENGINE_REF", ""), actual, engine_version, version[1], os.environ.get("RELEASE_TAG", ""))
    except ValueError as error:
        raise SystemExit(str(error)) from error
    if not (project / "docs/releases" / f"{version[1]}.md").is_file():
        raise SystemExit("Missing Python release notes")
    print(f"Release engine verified: {engine_version} at {actual}")


if __name__ == "__main__":
    main()
