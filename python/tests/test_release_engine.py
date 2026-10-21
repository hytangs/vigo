"""A compatible development engine is not necessarily the intended release engine."""
import runpy
from pathlib import Path

import pytest

validate = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/check-release-engine.py"))["validate"]


def test_exact_release_pin() -> None:
    validate("a" * 40, "a" * 40, "1.0.0-rc.1", "1.0.0rc1", "python-v1.0.0rc1")


@pytest.mark.parametrize("pin,actual,engine,tag", [
    ("main", "a" * 40, "1.0.0-rc.1", "python-v1.0.0rc1"),
    ("a" * 40, "b" * 40, "1.0.0-rc.1", "python-v1.0.0rc1"),
    ("a" * 40, "a" * 40, "2.0.0", "python-v1.0.0rc1"),
    ("a" * 40, "a" * 40, "1.0.0-rc.1", "python-v0.5.0"),
])
def test_rejects_unintended_release_engine(pin: str, actual: str, engine: str, tag: str) -> None:
    with pytest.raises(ValueError):
        validate(pin, actual, engine, "1.0.0rc1", tag)


def test_python_patch_version_is_independent() -> None:
    validate("a" * 40, "a" * 40, "1.0.1", "1.0.0rc1", "python-v1.0.0rc1")


def test_engine_tag_cannot_publish_python() -> None:
    with pytest.raises(ValueError):
        validate("a" * 40, "a" * 40, "1.0.0-rc.1", "1.0.0rc1", "v1.0.0rc1")
