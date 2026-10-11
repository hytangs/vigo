"""Incremental table serialization; stage complete output before replacing files."""
from __future__ import annotations

import csv
import json
import os
import tempfile
from collections.abc import Callable, Iterator, Mapping
from pathlib import Path
from typing import Any

Rows = Callable[[], Iterator[dict[str, Any]]]


def _write_csv(path: Path, rows: Rows, empty_fields: list[str]) -> None:
    fields = list(dict.fromkeys(key for row in rows() for key in row)) or empty_fields
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for row in rows():
            writer.writerow({
                key: json.dumps(value, ensure_ascii=False, allow_nan=False)
                if isinstance(value, (dict, list)) else value
                for key, value in row.items()
            })


def write_result_tables(
    destination: Path, journeys: Rows, legs: Rows, record: Mapping[str, Any],
) -> Path:
    destination.mkdir(parents=True, exist_ok=True)
    # All serialization must succeed before any existing table is replaced.
    # Each rename is atomic; readers requiring a consistent multi-file snapshot
    # should use a separate output directory for each Result.
    with tempfile.TemporaryDirectory(prefix=".vigo-tables-", dir=destination) as temporary:
        stage = Path(temporary)
        identity = ["journeyIndex", "cityRevisionId", "scenario", "status"]
        _write_csv(stage / "journeys.csv", journeys,
                   identity + ["hasJourney", "legCount"])
        _write_csv(stage / "legs.csv", legs, identity + ["legIndex"])
        (stage / "record.json").write_text(
            json.dumps(dict(record), indent=2, ensure_ascii=False, allow_nan=False) + "\n",
            encoding="utf-8",
        )
        for name in ("journeys.csv", "legs.csv", "record.json"):
            os.replace(stage / name, destination / name)
    return destination
