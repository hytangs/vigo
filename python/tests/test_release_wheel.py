"""Release artifacts must not silently mix wrapper and Engine revisions."""
import hashlib
import json
import runpy
import zipfile
from pathlib import Path

import pytest

validate = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/package-release.py"))["validate_wheel"]


def wheel_at(root, *, metadata="Name: vigo\nVersion: 1.0.0rc1\n", **overrides):
    manifest = {"sourceCommit": "a" * 40, "sourceDirty": False,
                "productVersion": "1.0.0-rc.1", "wheelPlatform": "macosx_14_0_arm64",
                "files": {"vigo": hashlib.sha256(b"engine").hexdigest()}, **overrides}
    wheel = root / "vigo-1.0.0rc1-py3-none-macosx_14_0_arm64.whl"
    with zipfile.ZipFile(wheel, "w") as archive:
        archive.writestr("vigo/_runtime/manifest.json", json.dumps(manifest))
        archive.writestr("vigo/_runtime/vigo", b"engine")
        archive.writestr("vigo-1.0.0rc1.dist-info/METADATA", metadata)
    return wheel


@pytest.mark.parametrize("newline", ["\n", "\r\n"])
def test_exact_release_bundle(tmp_path, newline):
    metadata = newline.join(["Name: vigo", "Version: 1.0.0rc1", "", "Wheel description"])
    validate(wheel_at(tmp_path, metadata=metadata), "a" * 40, "1.0.0-rc.1", "1.0.0rc1")


@pytest.mark.parametrize("metadata", [
    "Name: vigo\nVersion: 1.0.0rc2\n",
    "Name: vigo\nVersion: 1.0.0rc1\nVersion: 1.0.0rc1\n",
    "Name: vigo\n\nDescription with\nVersion: 1.0.0rc1\n",
])
def test_rejects_invalid_version_headers(tmp_path, metadata):
    with pytest.raises(ValueError, match="Wheel metadata differs"):
        validate(wheel_at(tmp_path, metadata=metadata), "a" * 40, "1.0.0-rc.1", "1.0.0rc1")


@pytest.mark.parametrize("changes", [
    {"sourceDirty": True}, {"sourceCommit": "b" * 40},
    {"productVersion": "0.5.2"}, {"wheelPlatform": "any"},
    {"files": {"vigo": "0" * 64}},
])
def test_rejects_unintended_bundle(tmp_path, changes):
    with pytest.raises(ValueError):
        validate(wheel_at(tmp_path, **changes), "a" * 40, "1.0.0-rc.1", "1.0.0rc1")


def test_rejects_wrong_python_version(tmp_path):
    with pytest.raises(ValueError):
        validate(wheel_at(tmp_path), "a" * 40, "1.0.0-rc.1", "1.0.1")
