"""A failed package replacement must preserve the last complete package."""
import importlib.util
from pathlib import Path
import tempfile
import sys
import subprocess
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("package_standalone", Path(__file__).resolve().parents[1] / "scripts/package-standalone.py")
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)

# The Node binding is published through a sibling temporary file. Concurrent
# native packaging must ignore that generated file, while still detecting
# changed or newly added compiler inputs and embedded documentation.
with tempfile.TemporaryDirectory() as folder:
    root = Path(folder)
    (root / ".gitignore").write_bytes((package.ROOT / ".gitignore").read_bytes())
    crate = root / "native/vigo-routing-kernel"
    crate.mkdir(parents=True)
    source = crate / "lib.rs"
    source.write_text("original source")
    docs = root / "docs/standalone.html"
    docs.parent.mkdir()
    docs.write_text("original embedded documentation")
    run = lambda command, **kw: subprocess.run(command, cwd=root, check=True, **kw)
    run(["git", "init", "--quiet"])
    with patch.object(package, "ROOT", root):
        baseline = package.source_fingerprint(run)
        staged_binding = crate / "vigo-routing-kernel.node.123.tmp"
        staged_binding.write_bytes(b"generated binding")
        assert package.source_fingerprint(run) == baseline
        staged_binding.unlink()
        assert package.source_fingerprint(run) == baseline
        source.write_text("changed source")
        assert package.source_fingerprint(run) != baseline
        source.write_text("original source")
        docs.write_text("changed embedded documentation")
        assert package.source_fingerprint(run) != baseline
        docs.write_text("original embedded documentation")
        (crate / "new.rs").write_text("new compiler input")
        assert package.source_fingerprint(run) != baseline
print("Package identity excludes temporary bindings and detects changed or new source inputs.")

for failure in (None, 1, 2, 3, 4, 5, 6):
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        replacements = []
        for name in ("runtime", "archive", "checksum"):
            source, destination = root / f"new-{name}", root / name
            if name == "runtime":
                source.mkdir(); destination.mkdir()
                (source / "vigo").write_text("new")
                (destination / "vigo").write_text("old")
            else:
                source.write_text("new"); destination.write_text("old")
            replacements.append((source, destination))
        original = Path.replace
        count = 0
        def replace(source, destination):
            global count
            count += 1
            if count == failure:
                raise OSError("injected publication failure")
            return original(source, destination)
        try:
            with patch.object(Path, "replace", replace):
                package.publish_artifacts(replacements, root / "previous")
            assert failure is None
        except OSError:
            assert failure is not None
        for _, destination in replacements:
            file = destination / "vigo" if destination.is_dir() else destination
            assert file.read_text() == ("new" if failure is None else "old")
        assert not (root / "previous").exists()
print("Package publication: success and all six interrupted replacement steps preserve a complete package.")
