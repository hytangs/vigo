"""A failed package replacement must preserve the last complete package."""
import importlib.util
from pathlib import Path
import tempfile
import sys
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("package_standalone", Path(__file__).resolve().parents[1] / "scripts/package-standalone.py")
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)

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
