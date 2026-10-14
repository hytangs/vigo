"""An explicitly staged runtime produces a platform wheel; source installs stay lean."""
import hashlib
import json
import os
import shutil
from pathlib import Path

from setuptools import Distribution, setup
from setuptools.command.bdist_wheel import bdist_wheel
from setuptools.command.build_py import build_py

bundle = Path(os.environ["VIGO_BUNDLE_RUNTIME"]).resolve() if os.environ.get("VIGO_BUNDLE_RUNTIME") else None


class RuntimeDistribution(Distribution):
    def has_ext_modules(self):
        return bundle is not None


class BuildPython(build_py):
    def run(self):
        super().run()
        target = Path(self.build_lib) / "vigo" / "_runtime"
        # Do not accidentally carry a prior platform's staged payload forward.
        if target.exists():
            shutil.rmtree(target)
        if bundle:
            manifest = json.loads((bundle / "manifest.json").read_text())
            expected = set(manifest["files"]) | {"manifest.json"}
            if {p.name for p in bundle.iterdir()} != expected:
                raise ValueError("Unexpected staged runtime files")
            for name, digest in manifest["files"].items():
                file = bundle / name
                if file.is_symlink() or not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest() != digest:
                    raise ValueError("Staged runtime checksum mismatch: " + name)
            shutil.copytree(bundle, target)


class Wheel(bdist_wheel):
    def finalize_options(self):
        super().finalize_options()
        if bundle:
            self.root_is_pure = False

    def get_tag(self):
        if bundle:
            manifest = json.loads((bundle / "manifest.json").read_text())
            return "py3", "none", manifest["wheelPlatform"]
        return super().get_tag()


setup(distclass=RuntimeDistribution, cmdclass={"build_py": BuildPython, "bdist_wheel": Wheel})
