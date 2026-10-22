#!/usr/bin/env python3
"""Exercise publication completeness, tamper detection and immutable destinations."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("release_assets", ROOT / "scripts/prepare-release-assets.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    source = root / "input"
    source.mkdir()
    names = [f"VIGO-CLI-1.0.0-rc.1-{host}.zip" for host in ("darwin-arm64", "linux-arm64", "linux-x64", "win32-x64")]
    names += [f"VIGO-Python-1.0.0-rc.1-{host}.zip" for host in ("darwin-arm64", "linux-arm64", "linux-x64", "win32-x64")]
    names += [f"VIGO-Rust-1.0.0-rc.1-{host}.tar.gz" for host in ("aarch64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu", "x86_64-pc-windows-msvc")]
    names += [f"VIGO-Studio-1.0.0-rc.1-{host}{ext}" for host, ext in (("mac-arm64", ".zip"), ("linux-arm64", ".tar.gz"), ("linux-x64", ".tar.gz"), ("windows-x64", ".zip"))]
    for name in names:
        data = name.encode()
        (source / name).write_bytes(data)
        (source / (name + ".sha256")).write_text(hashlib.sha256(data).hexdigest() + "  " + name)
    for name in ("guide.html", "standalone-openapi.json"):
        (source / name).write_text("fixture")
    commit = "a" * 40
    manifest = module.stage(source, root / "ready", "1.0.0-rc.1", commit)
    assert len(manifest["files"]) == 18
    for name, entry in manifest["files"].items():
        assert "build-aaaaaaaaaaaa" in name
        assert hashlib.sha256((root / "ready" / name).read_bytes()).hexdigest() == entry["sha256"]
    try:
        module.stage(source, root / "ready", "1.0.0-rc.1", commit)
        raise AssertionError("Overwrote existing staging destination")
    except FileExistsError:
        pass
    archive = source / names[0]
    archive.write_text("tampered")
    try:
        module.stage(source, root / "bad", "1.0.0-rc.1", commit)
        raise AssertionError("Accepted a changed archive")
    except ValueError:
        assert not (root / "bad").exists()
    archive.unlink()
    try:
        module.stage(source, root / "missing", "1.0.0-rc.1", commit)
        raise AssertionError("Accepted a missing platform")
    except ValueError:
        assert not (root / "missing").exists()
print("Release staging passed: complete platform set, byte integrity, tamper rejection and no overwrite.")
