#!/usr/bin/env python3
"""Build and package the Rust executable. Python is a build tool, never a runtime dependency."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
CRATE = ROOT / "native/vigo-routing-kernel"


def source_fingerprint(run):
    digest = hashlib.sha256()
    inputs = run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--",
                  "native/vigo-routing-kernel", "rust-toolchain.toml", "docs/standalone.html", "docs/standalone-openapi.json"], capture_output=True).stdout
    for relative in sorted(set(inputs.split(b"\0")) - {b""}):
        file = ROOT / os.fsdecode(relative)
        if file.is_file():
            digest.update(relative + b"\0" + hashlib.sha256(file.read_bytes()).digest())
    return digest.hexdigest()


def publish_artifacts(replacements, backup):
    """Replace a complete package; restore every old artifact if publication fails."""
    backup.mkdir()
    saved, published = [], []
    try:
        for _, destination in replacements:
            if destination.exists():
                previous = backup / destination.name
                destination.replace(previous)
                saved.append((previous, destination))
        for source, destination in replacements:
            source.replace(destination)
            published.append(destination)
    except BaseException:
        for destination in reversed(published):
            if destination.is_dir():
                shutil.rmtree(destination)
            else:
                destination.unlink()
        for previous, destination in reversed(saved):
            previous.replace(destination)
        backup.rmdir()
        raise
    shutil.rmtree(backup)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", help="Rust target triple; defaults to the build host")
    parser.add_argument("--notices-only", type=Path, help="Write dependency notices for an already built target")
    args = parser.parse_args()
    cargo = os.environ.get("VIGO_CARGO") or shutil.which("cargo") or str(Path.home() / ".cargo/bin/cargo")
    rustc = str(Path(cargo).with_name("rustc"))
    run = lambda command, **kw: subprocess.run(command, cwd=ROOT, check=True, **kw)
    target = args.target or next(line.removeprefix("host: ") for line in run([rustc, "-vV"], capture_output=True, encoding="utf-8").stdout.splitlines() if line.startswith("host: "))
    if target == "x86_64-apple-darwin":
        raise RuntimeError("Intel macOS is not a supported VIGO target; use Apple Silicon.")
    manifest = str(CRATE / "Cargo.toml")
    common = ["--manifest-path", manifest, "--locked", "--no-default-features", "--features", "standalone"]
    env = os.environ.copy()
    flags = env.get("CARGO_ENCODED_RUSTFLAGS", "").split("\x1f") if env.get("CARGO_ENCODED_RUSTFLAGS") else shlex.split(env.get("RUSTFLAGS", ""))
    for original, replacement in [(str(Path.home()), "/vigo-home"), (str(ROOT), "/vigo-source")]:
        flags += ["--remap-path-prefix", f"{original}={replacement}"]
    env["CARGO_ENCODED_RUSTFLAGS"] = "\x1f".join(flags)
    if "windows" not in target:
        env["CFLAGS"] = " ".join([env.get("CFLAGS", ""), shlex.quote(f"-ffile-prefix-map={Path.home()}=/vigo-home"), shlex.quote(f"-ffile-prefix-map={ROOT}=/vigo-source")])
        env["CC_SHELL_ESCAPED_FLAGS"] = "1"
    if not args.notices_only:
        run([os.environ.get("VIGO_PYTHON") or os.sys.executable, str(ROOT / "scripts/build-standalone-docs.py"), "--check"], stdout=subprocess.DEVNULL)
        source_hash = source_fingerprint(run)
        run([cargo, "build", *common, "--release", "--bin", "vigo", "--target", target], env=env)
    metadata = json.loads(run([cargo, "metadata", *common, "--offline", "--filter-platform", target, "--format-version", "1"], capture_output=True, encoding="utf-8").stdout)
    packages = {p["id"]: p for p in metadata["packages"]}
    graph = {n["id"]: n for n in metadata["resolve"]["nodes"]}
    root = metadata["resolve"]["root"]
    selected, pending = set(), [root]
    while pending:
        item = pending.pop()
        if item in selected:
            continue
        selected.add(item)
        pending.extend(d["pkg"] for d in graph[item]["deps"] if any(k["kind"] != "dev" for k in d["dep_kinds"]))
    if any(packages[p]["name"] in ("napi", "napi-derive") for p in selected):
        raise RuntimeError("Standalone dependency graph unexpectedly includes Node-API")
    version = packages[root]["version"]
    notices = ["VIGO Rust standalone dependency licenses\n"]
    for package in sorted((packages[p] for p in selected if p != root), key=lambda p: (p["name"], p["version"])):
        notices.append(f"\n{package['name']} {package['version']} ({package.get('license') or 'see source'})\n")
        for file in sorted(Path(package["manifest_path"]).parent.iterdir()):
            if file.is_file() and re.match(r"(?i)^(license|licence|copying|notice)", file.name):
                notices.append(file.read_text(encoding="utf-8", errors="replace"))
    if args.notices_only:
        args.notices_only.write_text("\n".join(notices), encoding="utf-8")
        return
    name = f"VIGO-Rust-{version}-{target}"
    release = Path(os.environ.get("VIGO_STANDALONE_RELEASE_DIR", ROOT / "release/rust")).resolve()
    destination = release / name
    release.mkdir(parents=True, exist_ok=True)
    executable = "vigo.exe" if "windows" in target else "vigo"
    binary = Path(metadata["target_directory"]) / target / "release" / executable
    archive = release / f"{name}.tar.gz"
    embedded_docs = {name: (ROOT / "docs" / name).read_bytes()
                     for name in ("standalone.html", "standalone-openapi.json")}
    image = binary.read_bytes()
    for name, contents in embedded_docs.items():
        if contents not in image:
            raise RuntimeError(f"{name} changed during compilation or the executable is stale. Rebuild before packaging.")
    if source_hash != source_fingerprint(run):
        raise RuntimeError("Native sources changed during compilation. Rebuild before packaging.")
    record = {"schemaVersion": "vigo.standalone.package.v1", "version": version, "target": target, "runtime": "rust", "externalRuntimeRequired": False, "cityDataIncluded": False, "sourceCommit": run(["git", "rev-parse", "HEAD"], capture_output=True, encoding="utf-8").stdout.strip(), "dirty": bool(run(["git", "status", "--porcelain"], capture_output=True, encoding="utf-8").stdout.strip()), "sourceTreeSha256": source_hash, "binaryBytes": len(image), "binarySha256": hashlib.sha256(image).hexdigest()}
    # Assemble a fresh allowlisted payload. Never archive an old output folder,
    # which may contain user files, datasets, or stale dependencies.
    temporary = tempfile.mkdtemp(prefix=".package-", dir=release)
    backup = Path(temporary) / "previous"
    try:
        stage = Path(temporary) / name
        stage.mkdir()
        (stage / executable).write_bytes(image)
        (stage / executable).chmod(binary.stat().st_mode & 0o777)
        del image
        for file in ("LICENSE", "NOTICE"):
            shutil.copy2(ROOT / file, stage / file)
        guide = (ROOT / "docs/guides/rust-standalone.md").read_text(encoding="utf-8")
        (stage / "README.md").write_text(guide.replace("../reference/rust-standalone-audit.md", "AUDIT.md").replace("../reference/rust-standalone-native.md", "NATIVE.md").replace("../reference/walking-evidence.md", "standalone.html#walking-evidence").replace("../standalone.html", "standalone.html").replace("../standalone-openapi.json", "standalone-openapi.json"), encoding="utf-8")
        shutil.copy2(ROOT / "docs/reference/rust-standalone-audit.md", stage / "AUDIT.md")
        native = (ROOT / "docs/reference/rust-standalone-native.md").read_text(encoding="utf-8")
        (stage / "NATIVE.md").write_text(native.replace("../guides/rust-standalone.md", "README.md"), encoding="utf-8")
        for file, contents in embedded_docs.items():
            (stage / file).write_bytes(contents)
        (stage / "THIRD-PARTY-NOTICES.txt").write_text("\n".join(notices), encoding="utf-8")
        record["files"] = {file.name: {"bytes": file.stat().st_size, "sha256": hashlib.sha256(file.read_bytes()).hexdigest()}
                           for file in sorted(stage.iterdir())}
        (stage / "manifest.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        staged_archive = Path(temporary) / archive.name
        with tarfile.open(staged_archive, "w:gz") as output:
            output.add(stage, arcname=name)
        with staged_archive.open("rb") as source:
            hasher = hashlib.sha256()
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                hasher.update(chunk)
            digest = hasher.hexdigest()
        checksum = Path(temporary) / f"{archive.name}.sha256"
        checksum.write_text(f"{digest}  {archive.name}\n", encoding="utf-8")
        # All new artifacts are complete before any old path is replaced.
        # Backups exist only during publication, not once per build forever.
        publish_artifacts([(stage, destination), (staged_archive, archive),
                           (checksum, release / checksum.name)], backup)
    finally:
        if backup.exists():
            print(f"Publication recovery incomplete; preserved artifacts at {temporary}", file=os.sys.stderr)
        else:
            shutil.rmtree(temporary)
    print(json.dumps({**record, "archive": str(archive), "archiveBytes": archive.stat().st_size, "binary": str(destination / executable)}, indent=2))


if __name__ == "__main__":
    main()
