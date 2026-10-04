#!/usr/bin/env python3
"""Verify the exact archive and exercise its extracted executable on public fixtures."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path, nargs="?")
    parser.add_argument("--node", default=os.environ.get("VIGO_STANDALONE_TEST_NODE") or shutil.which("node"))
    args = parser.parse_args()
    archives = [args.archive] if args.archive else list((ROOT / "release/rust").glob("*.tar.gz"))
    assert len(archives) == 1, "Specify exactly one archive to verify"
    archive = archives[0].resolve()
    expected = archive.with_name(archive.name + ".sha256").read_text().split()[0]
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == expected, "Archive digest mismatch"
    executable = "vigo.exe" if os.name == "nt" else "vigo"
    allowed = {executable, "LICENSE", "NOTICE", "README.md", "AUDIT.md", "NATIVE.md", "standalone.html", "standalone-openapi.json", "THIRD-PARTY-NOTICES.txt", "manifest.json"}
    with tempfile.TemporaryDirectory(prefix="vigo-extracted-") as directory:
        destination = Path(directory)
        with tarfile.open(archive) as tar:
            members = tar.getmembers()
            files = [member for member in members if member.isfile()]
            assert len(files) == len(allowed)
            assert {PurePosixPath(member.name).name for member in files} == allowed
            prefix = PurePosixPath(files[0].name).parts[0]
            assert len([m for m in members if m.isdir()]) == 1
            for member in members:
                parts = PurePosixPath(member.name).parts
                assert not member.name.startswith("/") and ".." not in parts
                assert parts[0] == prefix and len(parts) <= 2
                assert member.isfile() or member.isdir(), "Links and devices are not package payload"
                if member.isfile():
                    output = destination / parts[-1]
                    output.write_bytes(tar.extractfile(member).read())
                    output.chmod(member.mode & 0o777)
        manifest = json.loads((destination / "manifest.json").read_text())
        assert manifest["runtime"] == "rust" and manifest["externalRuntimeRequired"] is False
        assert manifest["cityDataIncluded"] is False
        assert set(manifest["files"]) == allowed - {"manifest.json"}
        for name, entry in manifest["files"].items():
            data = (destination / name).read_bytes()
            assert len(data) == entry["bytes"] and hashlib.sha256(data).hexdigest() == entry["sha256"], name
        binary = destination / executable
        assert manifest["binarySha256"] == hashlib.sha256(binary.read_bytes()).hexdigest()
        assert len(manifest["sourceTreeSha256"]) == 64
        env = {**os.environ, "PATH": "", "NODE_PATH": ""}
        capabilities = json.loads(subprocess.check_output([str(binary), "capabilities"], cwd=directory, env=env))
        assert capabilities["standalone"] is True
        assert args.node, "Node is required only for building test fixtures and running comparison checks"
        node = str(Path(args.node).resolve())
        for suite in ("check-standalone.mjs", "check-standalone-parity.mjs", "check-standalone-station-access.mjs", "check-standalone-http.mjs", "check-standalone-docs.mjs"):
            subprocess.run([node, str(ROOT / "test" / suite)], cwd=ROOT,
                           env={**os.environ, "VIGO_STANDALONE_PATH": str(binary)}, check=True)
    print(json.dumps({"archive": str(archive), "sha256": expected, "payloadFiles": len(allowed),
                      "extractedRuntimeChecks": "passed", "runtime": "rust"}, indent=2))


if __name__ == "__main__":
    main()
