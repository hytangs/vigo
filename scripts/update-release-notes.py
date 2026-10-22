#!/usr/bin/env python3
"""Prepend download links for the newly published immutable runtime revision."""
import argparse
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("tag")
parser.add_argument("directory", type=Path)
args = parser.parse_args()
manifest_path, = args.directory.glob("release-manifest-*.json")
manifest = json.loads(manifest_path.read_text())
assert args.tag == "v" + manifest["version"]
release = json.loads(subprocess.check_output(["gh", "release", "view", args.tag, "--json", "body,url"], text=True))
marker = f"<!-- vigo-release:{manifest['sourceCommit']} -->"
if marker not in release["body"]:
    base = release["url"].replace("/tag/", "/download/") + "/"
    lines = [marker, f"## Latest {manifest['version']} build: {manifest['build']}", "",
             f"VIGO **{manifest['version']}**, source `{manifest['sourceCommit']}`. "
             "Updated Studio, CLI, native runtimes and bundled Python wheels include the integrated offline documentation, "
             "device-aware native parallelism and memory budgets. Original downloads and tags are preserved.", "",
             "Every platform archive passed the release verification workflow before publication. "
             "Checksums and GitHub build attestations identify the exact files.", ""]
    for name in manifest["files"]:
        if name.endswith((".zip", ".tar.gz")):
            lines.append(f"- [{name}]({base}{name})")
    lines += ["", f"[Build manifest]({base}{manifest_path.name}) · "
              + " · ".join(f"[{entry['originalFilename']}]({base}{name})" for name, entry in manifest["files"].items() if entry['originalFilename'] in ('guide.html', 'standalone-openapi.json')),
              "", "---", "", release["body"]]
    notes = args.directory / "publication-notes.md"
    notes.write_text("\n".join(lines) + "\n")
    subprocess.run(["gh", "release", "edit", args.tag, "--notes-file", str(notes)], check=True)
