from __future__ import annotations

import hashlib
import json
import os
import runpy
import subprocess
import sys
import tempfile
import venv
import zipfile
from pathlib import Path

# Accept a concrete wheel or a directory containing exactly one wheel.
source = Path(sys.argv[1]).resolve()
if source.is_file():
    wheel = source
else:
    wheel, = source.glob("vigo-*.whl")
root_source = Path(__file__).resolve().parents[1]
patterns = runpy.run_path(str(root_source / "scripts/check-public-release.py"))["PRIVATE_PATTERNS"]
with zipfile.ZipFile(wheel) as archive:
    names = archive.namelist()
    manifest_name = "vigo/_runtime/manifest.json"
    bundled = manifest_name in names
    if "--require-bundled" in sys.argv and not bundled:
        raise SystemExit("Expected a self-contained platform wheel")
    if bundled:
        manifest = json.loads(archive.read(manifest_name))
        expected = {"vigo/_runtime/" + name for name in manifest["files"]} | {manifest_name}
        if {name for name in names if name.startswith("vigo/_runtime/")} != expected:
            raise SystemExit("Bundled payload differs from manifest")
        for name, digest in manifest["files"].items():
            if hashlib.sha256(archive.read("vigo/_runtime/" + name)).hexdigest() != digest:
                raise SystemExit("Bundled checksum mismatch: " + name)
    for name in names:
        # Upstream Node contains its own build metadata; its pinned archive is
        # checked during staging. Audit all VIGO bytes, including the native library.
        if name in {"vigo/_runtime/node", "vigo/_runtime/node.exe"}:
            continue
        data = archive.read(name)
        if str(Path.home()).encode() in data or any(pattern.search(data.decode("utf-8", errors="replace")) for pattern in patterns):
            raise SystemExit("Private value in wheel member: " + name)

with tempfile.TemporaryDirectory(prefix="vigo-wheel-") as directory:
    root = Path(directory)
    venv.EnvBuilder(with_pip=True).create(root / "environment")
    executable = root / "environment" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    subprocess.run([str(executable), "-m", "pip", "install", "--no-index", "--no-deps", str(wheel)], check=True)
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(("VIGO_", "PYTHON"))}
    environment.update(PATH="", NODE_OPTIONS="--invalid-host-option", VIGO_NATIVE_ROUTING_KERNEL="missing-host-kernel")
    code = "import importlib.metadata, vigo; assert importlib.metadata.version('vigo') == vigo.__version__; "
    if bundled:
        code += "runtime = vigo.resolve_runtime(); assert runtime.source == 'bundled'; print('Bundled runtime:', runtime.product_version); "
    code += "assert all(callable(getattr(vigo, name)) for name in ('open', 'build', 'compare')); print('Installed wheel import passed.')"
    subprocess.run([str(executable), "-I", "-c", code], cwd=root, env=environment, check=True)
    if bundled and os.environ.get("VIGO_TEST_INPUTS"):
        environment["VIGO_TEST_INPUTS"] = str(Path(os.environ["VIGO_TEST_INPUTS"]).resolve())
        # unittest is in the standard library, so the clean venv needs no test packages.
        # Only the progress-display test needs the optional tqdm dependency.
        code = (
            "import runpy, unittest; "
            f"module = runpy.run_path({str(root_source / 'tests/test_live_runtime.py')!r}); "
            "import vigo; original = vigo.build; "
            "vigo.build = lambda *a, **k: original(*a, **{**k, 'progress': False}); "
            "case = module['LiveRuntimeTest']; "
            "names = [n for n in unittest.defaultTestLoader.getTestCaseNames(case) if n != 'test_build_reports_actual_phases']; "
            "result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(case(n) for n in names)); "
            "raise SystemExit(not result.wasSuccessful())"
        )
        subprocess.run([str(executable), "-I", "-c", code], cwd=root, env=environment, check=True)
