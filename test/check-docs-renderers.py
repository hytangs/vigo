"""Keep the shared Markdown subset consistent in independently shipped readers."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


engine = load("engine_docs", ROOT / "scripts/docs_renderer.py")
python = load("python_docs", ROOT / "python/scripts/docs_renderer.py")
for source in [
    "A < B & C > D",
    "**Bold** and *emphasis* with `City.open()`",
    '[Guide](guide.md#city) and ![A & B](mark.png)',
    "`<script>alert(1)</script>` & plain text",
]:
    assert engine.inline(source) == python.inline(source), source
for title in ["Route & Matrix", "A <b>City</b>", "Street-to-station", "Café"]:
    assert engine.slug(title) == python.slug(title), title
for source in ["# City\n\nBuild a **City**.", "- Route\n- Matrix\n- Reach"]:
    assert engine.markdown(source) == python.markdown(source), source
print("Independent documentation readers agree on their common Markdown subset.")
