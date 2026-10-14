from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Each example notebook must keep covering the steps its README promises.
NOTEBOOKS = {
    "walkthrough.ipynb": (
        "vigo.resolve_runtime(", "vigo.open(", "vigo.build(", "city.route(", "arrive_by=",
        "alternatives=", "city.supports(", "city.matrix(", "export_tables(", "iter_legs(",
        "vigo.Reach(", "city.scenario(", ".compare(", "iter_run(", "except vigo.VigoError",
        ".record", "city.close()",
    ),
}


def source(cell: dict[str, object]) -> str:
    value = cell.get("source", "")
    return "".join(value) if isinstance(value, list) else str(value)


def main() -> None:
    root = ROOT / "examples"
    discovered = {path.name for path in root.glob("*.ipynb")}
    if discovered != NOTEBOOKS.keys():
        raise SystemExit(f"notebook set differs: {sorted(discovered)}")
    code_cells = 0
    for name, markers in NOTEBOOKS.items():
        notebook = json.loads((root / name).read_text(encoding="utf-8"))
        if notebook.get("nbformat") != 4:
            raise SystemExit(f"{name}: expected notebook format 4")
        identifiers = [cell.get("id") for cell in notebook.get("cells", [])]
        if notebook.get("nbformat_minor", 0) >= 5 and (None in identifiers or len(set(identifiers)) != len(identifiers)):
            raise SystemExit(f"{name}: every cell needs a unique id")
        combined = []
        for index, cell in enumerate(notebook.get("cells", [])):
            if cell.get("cell_type") != "code":
                continue
            code_cells += 1
            if cell.get("execution_count") is not None or cell.get("outputs") != []:
                raise SystemExit(f"{name} cell {index}: stored output")
            cell_source = source(cell)
            compile(cell_source, f"{name}:{index}", "exec")
            combined.append(cell_source)
        text = "\n".join(combined)
        missing = [marker for marker in markers if marker not in text]
        if missing:
            raise SystemExit(f"{name}: missing {missing}")
    print(f"Validated {len(NOTEBOOKS)} notebook with {code_cells} code cells.")


if __name__ == "__main__":
    main()
