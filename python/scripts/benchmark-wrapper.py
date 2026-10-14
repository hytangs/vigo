"""Reproduce Python copy/decoding costs; this does not benchmark routing."""

from __future__ import annotations

import argparse
import copy
import json
import platform
import statistics
import sys
import timeit
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vigo import Result
from vigo._json import loads


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=int, default=1024)
    parser.add_argument("--iterations", type=int, default=50)
    parser.add_argument("--repeats", type=int, default=7)
    args = parser.parse_args()
    if min(args.rows, args.iterations, args.repeats) < 1:
        parser.error("rows, iterations, and repeats must be positive")

    payload = {"resultSchemaVersion": 1, "kind": "matrix", "status": "ready", "rows": [
        {"originId": f"origin_{index}", "destinationId": "hub", "originIndex": index,
         "destinationIndex": 0, "status": "ready" if index % 5 else "blocked",
         "durationMinutes": 12.3456789012345 if index % 5 else None,
         "departMinutes": 480, "arriveMinutes": 492.3456789012345 if index % 5 else None}
        for index in range(args.rows)
    ]}
    result = Result("matrix", payload, "synthetic")
    encoded = json.dumps({"trace": payload}, ensure_ascii=False, separators=(",", ":"))
    assert result.rows == tuple(copy.deepcopy(row) for row in payload["rows"])
    assert loads(encoded) == json.loads(encoded)

    functions = {
        "deepcopy_rows": lambda: tuple(copy.deepcopy(row) for row in payload["rows"]),
        "result_rows": lambda: result.rows,
        "first_row_only": lambda: next(result.iter_rows()),
        "stdlib_decode": lambda: json.loads(encoded),
        "selected_decode": lambda: loads(encoded),
    }
    timings = {
        name: statistics.median(timeit.repeat(function, number=args.iterations, repeat=args.repeats))
        * 1000 / args.iterations
        for name, function in functions.items()
    }
    print(json.dumps({
        "scope": "synthetic Python result access and JSON decoding; excludes Engine and IPC",
        "python": platform.python_version(), "platform": platform.system(),
        "decoder": loads.__module__, "rows": args.rows, "iterations": args.iterations,
        "repeats": args.repeats, "median_ms": timings,
        "row_copy_speedup": timings["deepcopy_rows"] / timings["result_rows"],
        "decode_speedup": timings["stdlib_decode"] / timings["selected_decode"],
    }, indent=2))


if __name__ == "__main__":
    main()
