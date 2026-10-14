"""Export a saved Route or Matrix Result as journey and leg CSV tables.

Install vigo first, then run:
    python examples/decompose_result.py result.json --kind matrix --output tables
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from vigo import Result


def export_tables(result: Result, directory: Path) -> None:
    result.export_tables(directory)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("result", type=Path)
    parser.add_argument("--kind", choices=("route", "matrix"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--city-revision")
    parser.add_argument("--scenario")
    args = parser.parse_args()
    payload = json.loads(args.result.read_text(encoding="utf-8"))
    result = Result(args.kind, payload,
                    args.city_revision or payload.get("cityRevisionId"),
                    args.scenario or payload.get("scenario"))
    export_tables(result, args.output)


if __name__ == "__main__":
    main()
