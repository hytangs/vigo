#!/usr/bin/env python3
"""Stage verified CI artifacts under immutable revision names for publication."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess


def stage(source: Path, output: Path, version: str, commit: str) -> dict:
    if not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?", version) or not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Expected a release version and full source commit")
    revision = f"build-{commit[:12]}"
    files = sorted(source.iterdir())
    archives = [p for p in files if p.name.endswith((".zip", ".tar.gz"))]
    expected = set()
    for host in ("darwin-arm64", "linux-arm64", "linux-x64", "win32-x64"):
        expected.add(f"VIGO-CLI-{version}-{host}.zip")
    for target in ("aarch64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu", "x86_64-pc-windows-msvc"):
        expected.add(f"VIGO-Rust-{version}-{target}.tar.gz")
    for host, ext in (("mac-arm64", ".zip"), ("linux-arm64", ".tar.gz"), ("linux-x64", ".tar.gz"), ("windows-x64", ".zip")):
        expected.add(f"VIGO-Studio-{version}-{host}{ext}")
    if {p.name for p in archives} != expected:
        raise ValueError("Release must contain CLI, native and Studio archives for all four platforms")
    documents = {"guide.html", "standalone-openapi.json"}
    allowed = expected | {n + ".sha256" for n in expected} | documents
    if {p.name for p in files} != allowed or any(not p.is_file() or p.is_symlink() for p in files):
        raise ValueError("Unexpected or missing release artifacts")
    for archive in archives:
        checksum = archive.with_name(archive.name + ".sha256").read_text().split()[0]
        if hashlib.sha256(archive.read_bytes()).hexdigest() != checksum:
            raise ValueError(f"Archive checksum mismatch: {archive.name}")
    output.mkdir(parents=True, exist_ok=False)
    manifest = {"version": version, "build": revision, "sourceCommit": commit, "files": {}}
    for item in archives + [source / name for name in sorted(documents)]:
        extension = ".tar.gz" if item.name.endswith(".tar.gz") else item.suffix
        name = item.name.removesuffix(extension) + f"-{revision}" + extension
        target = output / name
        shutil.copyfile(item, target)
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        (output / (name + ".sha256")).write_text(f"{digest}  {name}\n")
        manifest["files"][name] = {"sha256": digest, "bytes": target.stat().st_size, "originalFilename": item.name}
    target = output / f"release-manifest-{revision}.json"
    target.write_text(json.dumps(manifest, indent=2) + "\n")
    target.with_name(target.name + ".sha256").write_text(f"{hashlib.sha256(target.read_bytes()).hexdigest()}  {target.name}\n")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--tag", required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    version = json.loads((root / "package.json").read_text())["version"]
    if args.tag != f"v{version}":
        raise SystemExit("Release tag must match package.json")
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    print(json.dumps(stage(args.source, args.output, version, commit), indent=2))
