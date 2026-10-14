"""Exercise license collection with Cargo's real platform dependency resolver."""
from __future__ import annotations

import json
import platform
import runpy
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

PREPARE = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/prepare-runtime.py"))
CARGO = shutil.which("cargo") or str(
    Path.home() / ".cargo/bin" / ("cargo.exe" if platform.system() == "Windows" else "cargo")
)


@unittest.skipUnless(Path(CARGO).is_file(), "Cargo is required to check target license resolution")
class RuntimeLicenseTests(unittest.TestCase):
    def test_notices_follow_target_and_retain_transitive_dependencies(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            engine = Path(temporary)
            kernel = engine / "native/vigo-routing-kernel"
            kernel.mkdir(parents=True)

            def crate(name: str, dependencies: str = "") -> None:
                root = kernel if name == "vigo-routing-kernel" else kernel / name
                (root / "src").mkdir(parents=True)
                (root / "src/lib.rs").write_text("")
                (root / "Cargo.toml").write_text(
                    f'[package]\nname = "{name}"\nversion = "1.0.0"\n'
                    f'edition = "2021"\nlicense = "MIT"\n{dependencies}'
                )
                (root / "LICENSE").write_text(f"License text for {name}\n")

            crate("vigo-routing-kernel", '\n[dependencies]\nshared = { path = "shared" }\n'
                  '\n[target.\'cfg(windows)\'.dependencies]\nwindows-only = { path = "windows-only" }\n'
                  '\n[target.\'cfg(unix)\'.dependencies]\nunix-only = { path = "unix-only" }\n')
            crate("shared", '\n[dependencies]\ntransitive = { path = "../transitive" }\n')
            for name in ("transitive", "windows-only", "unix-only"):
                crate(name)
            for name in ("jszip", "papaparse", "pbf", "js-transitive"):
                root = engine / "node_modules" / name
                root.mkdir(parents=True)
                (root / "package.json").write_text(json.dumps({
                    "name": name, "version": "1.0.0", "license": "MIT",
                    "dependencies": {"js-transitive": "1.0.0"} if name == "jszip" else {},
                }))
                (root / "LICENSE").write_text(f"License text for {name}\n")
            subprocess.run([CARGO, "generate-lockfile", "--offline"], cwd=kernel,
                           check=True, capture_output=True, timeout=60)
            lock = (kernel / "Cargo.lock").read_bytes()
            for target, included, excluded in (
                ("x86_64-pc-windows-msvc", "windows-only", "unix-only"),
                ("x86_64-unknown-linux-gnu", "unix-only", "windows-only"),
                ("aarch64-apple-darwin", "unix-only", "windows-only"),
                ("x86_64-apple-darwin", "unix-only", "windows-only"),
                ("aarch64-unknown-linux-gnu", "unix-only", "windows-only"),
            ):
                with self.subTest(target=target):
                    notices = PREPARE["third_party_notices"](engine, target)
                    for name in ("shared", "transitive", included, "jszip", "papaparse", "pbf", "js-transitive"):
                        self.assertIn(f"{name} 1.0.0 (MIT)", notices)
                        self.assertIn(f"License text for {name}\n", notices)
                    self.assertNotIn(excluded, notices)
                    self.assertEqual(notices.count("License text for js-transitive\n"), 1)
                    self.assertEqual((kernel / "Cargo.lock").read_bytes(), lock)


if __name__ == "__main__":
    unittest.main()
