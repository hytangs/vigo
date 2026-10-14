"""Result access must remain independent while avoiding whole-result copies."""

import copy
import csv
import importlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from vigo import Result
from vigo._json import copy_json


class ResultAccessTest(unittest.TestCase):
    def test_result_copy_rejects_non_json_objects(self):
        for value in (object(), {1, 2}, (1, 2)):
            with self.subTest(value=type(value).__name__), self.assertRaisesRegex(TypeError, "non-JSON"):
                copy_json({"nested": [value]})

    def test_json_copies_preserve_values_and_isolate_nested_mutation(self):
        payload = {"resultSchemaVersion": 1, "status": "ready", "rows": [
            {"originId": '北 "A"', "durationMinutes": 1.23456789012345,
             "journey": {"legs": [{"coordinates": [[-77.05, 38.9], [-77.04, 38.91]]}]}},
            {"originId": "B", "status": "blocked", "durationMinutes": None},
        ]}
        result = Result("matrix", payload, "fixture")
        expected = copy.deepcopy(payload)
        for rows in (result.rows, list(result.iter_rows()), result.value, result.to_dict()["rows"]):
            self.assertEqual(list(rows), expected["rows"])
            rows[0]["journey"]["legs"][0]["coordinates"][0][0] = 0
            rows[1]["durationMinutes"] = 0
        self.assertEqual(result.to_dict(), expected)
        self.assertEqual(json.loads(result.to_json(indent=None)), expected)

    def test_iteration_copies_only_consumed_rows(self):
        payload = {"resultSchemaVersion": 1, "status": "ready", "rows": [
            {"originId": str(index), "durationMinutes": index} for index in range(1024)
        ]}
        result = Result("matrix", payload, "fixture")
        with patch("vigo.model.copy_json", wraps=copy_json) as clone:
            rows = result.iter_rows()
            self.assertEqual(clone.call_count, 0)
            self.assertEqual(next(rows)["originId"], "0")
            self.assertEqual(clone.call_count, 1)

    def test_csv_exports_union_of_fields_without_copying_rows(self):
        result = Result("matrix", {"resultSchemaVersion": 1, "status": "ready", "rows": [
            {"originId": "北", "status": "blocked"},
            {"originId": "B", "status": "ready", "durationMinutes": 2},
        ]}, "fixture")
        with tempfile.TemporaryDirectory() as directory, patch(
            "vigo.model.copy_json", side_effect=AssertionError("CSV must not copy rows")
        ):
            path = result.export(Path(directory) / "matrix.csv")
            with path.open(encoding="utf-8", newline="") as source:
                rows = list(csv.DictReader(source))
        self.assertEqual(rows[0], {"originId": "北", "status": "blocked", "durationMinutes": ""})
        self.assertEqual(rows[1]["durationMinutes"], "2")

    def test_json_decoder_with_and_without_acceleration(self):
        import vigo._json as codec

        document = '{"id":"北", "ready":true,"values":[null,0,1.23456789012345]}'
        expected = json.loads(document)
        self.assertEqual(codec.loads(document), expected)
        with self.assertRaises(json.JSONDecodeError):
            codec.loads('{"truncated":')
        try:
            with patch("importlib.import_module", side_effect=ImportError):
                importlib.reload(codec)
            self.assertIs(codec.loads, json.loads)
            self.assertEqual(codec.loads(document), expected)
        finally:
            importlib.reload(codec)
