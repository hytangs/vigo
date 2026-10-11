"""Verify that a tagged Python release bundles its explicitly pinned engine."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from pathlib import Path


def validate(pin: str, actual: str, engine_version: str, wrapper_version: str, tag: str) -> None:
    if not re.fullmatch(r"[0-9a-fA-F]{40}", pin):
        raise ValueError("Set VIGO_ENGINE_REF to the full, verified engine commit before tagging.")
    if pin.lower() != actual.lower():
        raise ValueError("Checked-out engine differs from VIGO_ENGINE_REF.")
    if tag != f"v{wrapper_version}":
        raise ValueError("Release tag differs from the Python package version.")
    if engine_version != wrapper_version:
        raise ValueError("Tagged Python wheels must bundle the matching engine release version.")


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
    print(f"Release engine verified: {engine_version} at {actual}")


if __name__ == "__main__":
    main()
