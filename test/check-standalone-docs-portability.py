"""Check the committed manual under Windows path and legacy encoding behavior."""
import contextlib
import importlib.util
import io
from pathlib import Path, PureWindowsPath
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    "standalone_docs", ROOT / "scripts/build-standalone-docs.py")
docs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(docs)


class DocumentationPortability(unittest.TestCase):
    def check_products(self):
        with patch.object(sys, "argv", ["build-standalone-docs.py", "--check"]):
            with contextlib.redirect_stdout(io.StringIO()):
                docs.main()

    def test_windows_source_paths_keep_committed_products(self):
        relative_to = Path.relative_to

        def windows_relative(path, *args, **kwargs):
            return PureWindowsPath(*relative_to(path, *args, **kwargs).parts)

        with patch.object(Path, "relative_to", windows_relative):
            self.check_products()

    def test_legacy_default_encoding_keeps_committed_products(self):
        open_file = io.open

        def legacy_open(file, mode="r", buffering=-1, encoding=None, errors=None,
                        newline=None, closefd=True, opener=None):
            if "b" not in mode and encoding in (None, "locale"):
                encoding = "cp1252"
            return open_file(file, mode, buffering, encoding, errors, newline,
                             closefd, opener)

        with patch.object(io, "open", legacy_open):
            self.check_products()


if __name__ == "__main__":
    unittest.main()
