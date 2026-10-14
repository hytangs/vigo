"""Stage a headless runtime for a platform wheel; never run during import/install."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

NODE_VERSION = "24.18.0"
# Official nodejs.org/dist/v24.18.0/SHASUMS256.txt. Verify before reading members.
TARGETS = {
    ("Darwin", "arm64"): (
        "darwin-arm64.tar.gz", "macosx_14_0_arm64",
        "e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1",
        "aarch64-apple-darwin",
    ),
    ("Darwin", "x86_64"): (
        "darwin-x64.tar.gz", "macosx_14_0_x86_64",
        "dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080",
        "x86_64-apple-darwin",
    ),
    ("Linux", "aarch64"): (
        "linux-arm64.tar.gz", "manylinux_2_39_aarch64",
        "6b4484c2190274175df9aa8f28e2d758a819cb1c1fe6ab481e2f95b463ab8508",
        "aarch64-unknown-linux-gnu",
    ),
    ("Linux", "x86_64"): (
        "linux-x64.tar.gz", "manylinux_2_39_x86_64",
        "783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8",
        "x86_64-unknown-linux-gnu",
    ),
    ("Windows", "AMD64"): (
        "win-x64.zip", "win_amd64",
        "0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821",
        "x86_64-pc-windows-msvc",
    ),
}


def third_party_notices(engine: Path, rust_target: str) -> str:
    """Retain licenses for the headless JS dependencies and the packaged Rust target."""
    sections = []
    seen = set()

    def collect(root: Path, name: str, version: str, license_name: str) -> None:
        sections.append(f"\n{name} {version} ({license_name})\n")
        for file in sorted(root.iterdir()):
            if file.is_file() and file.name.lower().startswith(("license", "licence", "copying", "notice")):
                sections.append(file.read_text(encoding="utf-8", errors="replace"))

    def npm(name: str, parent: Path) -> None:
        current = parent
        while not (current / "node_modules" / name / "package.json").is_file():
            if current == current.parent:
                raise SystemExit("Missing bundled dependency metadata: " + name)
            current = current.parent
        root = current / "node_modules" / name
        if root in seen:
            return
        seen.add(root)
        package = json.loads((root / "package.json").read_text())
        collect(root, name, package["version"], str(package.get("license", "see license text")))
        for dependency in package.get("dependencies", {}):
            npm(dependency, root)

    for name in ("jszip", "papaparse", "pbf"):
        npm(name, engine)
    cargo = shutil.which("cargo") or str(Path.home() / ".cargo/bin" / ("cargo.exe" if platform.system() == "Windows" else "cargo"))
    # A target build only fetches its own dependencies. Unfiltered metadata also
    # tries to read crates for other platforms, which breaks fresh offline builds.
    metadata = json.loads(subprocess.check_output(
        [cargo, "metadata", "--locked", "--offline", "--filter-platform", rust_target, "--format-version=1"],
        cwd=engine / "native/vigo-routing-kernel", text=True, timeout=60,
    ))
    for package in metadata["packages"]:
        if package["name"] != "vigo-routing-kernel":
            collect(Path(package["manifest_path"]).parent, package["name"], package["version"], str(package["license"]))
    return "Headless engine third-party license notices\n" + "\n".join(sections)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("build/headless"))
    args = parser.parse_args()
    engine, output = args.engine.resolve(), args.output.resolve()
    if output.exists():
        raise SystemExit("Runtime staging directory already exists; choose a new --output.")
    target = TARGETS.get((platform.system(), platform.machine()))
    if target is None:
        raise SystemExit("No bundled runtime target for this OS/CPU; use an external runtime.")
    archive_suffix, wheel_platform, digest, rust_target = target
    archive_name = f"node-v{NODE_VERSION}-{archive_suffix}"
    url = f"https://nodejs.org/dist/v{NODE_VERSION}/{archive_name}"
    with urllib.request.urlopen(url, timeout=120) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != digest:
        raise SystemExit("Node archive checksum mismatch")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="headless-", dir=output.parent) as temporary:
        staged = Path(temporary)
        executable = "node.exe" if platform.system() == "Windows" else "node"
        prefix = archive_name.removesuffix(".tar.gz").removesuffix(".zip")
        members = {executable: executable if executable.endswith(".exe") else "bin/node", "NODE-LICENSE": "LICENSE"}
        # Copy only named regular files: no archive paths or links are extracted.
        if archive_name.endswith(".zip"):
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                for name, member in members.items():
                    (staged / name).write_bytes(archive.read(f"{prefix}/{member}"))
        else:
            with tarfile.open(fileobj=io.BytesIO(data)) as archive:
                for name, member in members.items():
                    entry = archive.getmember(f"{prefix}/{member}")
                    if not entry.isfile():
                        raise SystemExit("Expected a regular Node archive member")
                    source = archive.extractfile(entry)
                    assert source is not None
                    with source:
                        (staged / name).write_bytes(source.read())
        (staged / executable).chmod(0o755)
        for source, name in (
            ("public/vigo.mjs", "vigo.mjs"),
            ("native/vigo-routing-kernel/vigo-routing-kernel.node", "vigo-routing-kernel.node"),
            ("LICENSE", "ENGINE-LICENSE"), ("NOTICE", "ENGINE-NOTICE"),
            ("native/vigo-routing-kernel/vendor/cch/LICENSE", "CCH-LICENSE"),
            ("native/vigo-routing-kernel/vendor/cch/NOTICE", "CCH-NOTICE"),
        ):
            shutil.copyfile(engine / source, staged / name)
        (staged / "THIRD-PARTY-NOTICES").write_text(third_party_notices(engine, rust_target), encoding="utf-8")
        # Execute the relocated payload, not the source checkout or system Node.
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from vigo.runtime import _command_environment
        command = (str(staged / executable), str(staged / "vigo.mjs"))
        caps = json.loads(subprocess.check_output(
            [*command, "capabilities"], cwd=staged,
            env=_command_environment(command), text=True, timeout=30,
        ))
        if not all(any(q["id"] == kind and q.get("resident") for q in caps["queries"])
                   for kind in ("route", "matrix", "reach")):
            raise SystemExit("Engine must advertise resident Route, Matrix, and Reach")
        manifest = {
            "schemaVersion": 1, "productVersion": caps["productVersion"],
            "nodeVersion": NODE_VERSION, "nodeArchiveSha256": digest,
            "wheelPlatform": wheel_platform, "rustTarget": rust_target,
            "files": {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                      for p in sorted(staged.iterdir()) if p.is_file()},
        }
        (staged / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        shutil.copytree(staged, output)
    print(json.dumps({"platform": wheel_platform, "engine": caps["productVersion"],
                      "bytes": sum(p.stat().st_size for p in output.iterdir())}))


if __name__ == "__main__":
    main()
