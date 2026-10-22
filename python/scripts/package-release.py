"""Archive a verified platform wheel without changing its pip-compatible filename."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import zipfile
from email.parser import BytesParser
from pathlib import Path

HOSTS = {
    "macosx_14_0_arm64": "darwin-arm64",
    "manylinux_2_39_aarch64": "linux-arm64",
    "manylinux_2_39_x86_64": "linux-x64",
    "win_amd64": "win32-x64",
}


def validate_wheel(wheel: Path, commit: str, engine_version: str, python_version: str) -> dict:
    if not re.fullmatch(r"1\.0\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", engine_version):
        raise ValueError("Python 1.0 releases require an Engine 1.0 runtime")
    with zipfile.ZipFile(wheel) as archive:
        manifest = json.loads(archive.read("vigo/_runtime/manifest.json"))
        if (manifest.get("sourceCommit") != commit or manifest.get("sourceDirty") is not False
                or manifest.get("productVersion") != engine_version):
            raise ValueError("Wheel must bundle the clean release commit and exact Engine version")
        platform = manifest["wheelPlatform"]
        if platform not in HOSTS:
            raise ValueError("Unsupported release wheel platform")
        if wheel.name != f"vigo-{python_version}-py3-none-{platform}.whl":
            raise ValueError("Wheel filename differs from the Python release version or platform")
        metadata = BytesParser().parsebytes(
            archive.read(f"vigo-{python_version}.dist-info/METADATA"), headersonly=True)
        if metadata.get_all("Version") != [python_version]:
            raise ValueError("Wheel metadata differs from the Python release version")
        for name, digest in manifest["files"].items():
            if hashlib.sha256(archive.read("vigo/_runtime/" + name)).hexdigest() != digest:
                raise ValueError("Wheel runtime checksum mismatch: " + name)
        return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", type=Path, required=True)
    parser.add_argument("--wheels", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    version = re.search(r'^version = "([^"]+)"', (root / "pyproject.toml").read_text(), re.MULTILINE)
    assert version is not None
    engine_version = json.loads((args.engine / "package.json").read_text())["version"]
    commit = subprocess.check_output(["git", "-C", str(args.engine), "rev-parse", "HEAD"], text=True).strip()
    wheel, = args.wheels.glob("vigo-*.whl")
    manifest = validate_wheel(wheel, commit, engine_version, version[1])
    args.output.mkdir(parents=True, exist_ok=True)
    output = args.output / f"VIGO-Python-{engine_version}-{HOSTS[manifest['wheelPlatform']]}.zip"
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_STORED) as archive:
        archive.write(wheel, wheel.name)
        archive.writestr("runtime-manifest.json", json.dumps(manifest, indent=2) + "\n")
        archive.writestr("INSTALL.txt", f"VIGO Python {version[1]}, Engine {engine_version}\n"
                         f"Source: {commit}\n\npython -m pip install ./{wheel.name}\n")
    output.with_suffix(".zip.sha256").write_text(
        f"{hashlib.sha256(output.read_bytes()).hexdigest()}  {output.name}\n")
    print(output)


if __name__ == "__main__":
    main()
