import copy
import csv
import json
import runpy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from vigo import Result, model


class ResultTablesTest(unittest.TestCase):
    def result(self, kind, **payload):
        return Result(kind, {"resultSchemaVersion": 1, "status": "ready", **payload}, "city", "weekend")

    def test_route_preserves_units_and_independent_values(self):
        result = self.result("route", result={"durationMinutes": 12, "legs": [
            {"type": "walk", "durationMinutes": 2, "coordinates": [[0, 0], [1, 1]]},
            {"type": "ride", "durationMinutes": 8, "trip": {"id": "北"}},
        ]})
        summary = next(result.iter_journeys())
        self.assertEqual(summary["durationMinutes"], 12)
        self.assertEqual(summary["legCount"], 2)
        self.assertNotIn("legs", summary)
        legs = list(result.iter_legs())
        self.assertNotIn("coordinates", legs[0])
        self.assertEqual(legs[1]["legIndex"], 1)
        self.assertEqual(legs[1]["scenario"], "weekend")
        legs[1]["trip"]["id"] = "changed"
        geometry = next(result.iter_legs(include_geometry=True))
        geometry["coordinates"][0][0] = 99
        self.assertEqual(result.legs[0]["coordinates"][0][0], 0)
        self.assertEqual(result.legs[1]["trip"]["id"], "北")

    def test_matrix_keeps_blocked_missing_and_empty_journeys(self):
        result = self.result("matrix", rows=[
            {"originId": "a", "destinationId": "b", "status": "blocked", "durationMinutes": None},
            {"originId": "a", "destinationId": "b", "status": "ready", "durationMinutes": 4},
            {"originId": "c", "destinationId": "c", "status": "ready", "journey": {"legs": []}},
            {"originId": "a", "destinationId": "d", "status": "ready", "journey": {
                "legs": [{"type": "ride", "durationMinutes": 3}]}},
        ])
        summaries = list(result.iter_journeys())
        self.assertEqual([r["hasJourney"] for r in summaries], [False, False, True, True])
        self.assertEqual([r["legCount"] for r in summaries], [None, None, 0, 1])
        self.assertEqual(summaries[0]["status"], "blocked")
        self.assertIsNone(summaries[0]["durationMinutes"])
        leg = next(result.iter_legs())
        self.assertEqual((leg["journeyIndex"], leg["originId"], leg["destinationId"]), (3, "a", "d"))

    def test_blocked_route_and_unsupported_kinds(self):
        result = Result("route", {"resultSchemaVersion": 1, "status": "blocked", "result": None}, "city")
        self.assertEqual(next(result.iter_journeys())["status"], "blocked")
        self.assertEqual(list(result.iter_legs()), [])
        for kind in ("reach", "compare"):
            with self.assertRaises(TypeError):
                list(self.result(kind).iter_journeys())
            with self.assertRaises(TypeError):
                list(self.result(kind).iter_legs())

    def test_blocked_plan_retains_explanation_without_claiming_a_journey(self):
        plan = {"status": "blocked", "title": "No journey", "detail": "No service in the window",
                "diagnostics": {"failureCode": "no_service"}, "legs": []}
        results = [
            Result("route", {"resultSchemaVersion": 1, "status": "blocked", "result": plan}, "city"),
            self.result("matrix", rows=[{"status": "blocked", "journey": plan}]),
        ]
        for result in results:
            with self.subTest(kind=result.kind):
                summary = next(result.iter_journeys())
                self.assertFalse(summary["hasJourney"])
                self.assertIsNone(summary["legCount"])
                self.assertEqual(summary["detail"], plan["detail"])
                self.assertEqual(summary["diagnostics"]["failureCode"], "no_service")
                self.assertEqual(list(result.iter_legs()), [])
                with tempfile.TemporaryDirectory() as directory:
                    target = result.export_tables(directory)
                    with (target / "journeys.csv").open(newline="") as stream:
                        row = next(csv.DictReader(stream))
                    self.assertEqual(row["hasJourney"], "False")
                    self.assertEqual(row["legCount"], "")

    def test_geometry_is_excluded_before_copying(self):
        result = self.result("route", result={"legs": [{"type": "walk", "coordinates": object()}]})
        self.assertEqual(next(result.iter_legs())["type"], "walk")

    def test_csv_example_preserves_nested_fields_and_provenance(self):
        export = runpy.run_path(str(Path(__file__).parents[1] / "examples/decompose_result.py"))["export_tables"]
        result = self.result("route", result={"legs": [{"type": "ride", "trip": {"id": "北"}}]})
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            export(result, root)
            with (root / "legs.csv").open(encoding="utf-8", newline="") as source:
                leg = next(csv.DictReader(source))
            self.assertEqual(json.loads(leg["trip"]), {"id": "北"})
            self.assertEqual(leg["scenario"], "weekend")
            self.assertEqual(json.loads((root / "record.json").read_text())["cityRevisionId"], "city")

    def test_export_tables_keeps_empty_headers_and_skips_geometry(self):
        result = self.result("matrix", rows=[{"status": "blocked", "originId": "a", "destinationId": "b"}])
        with tempfile.TemporaryDirectory() as directory:
            target = result.export_tables(directory)
            with (target / "legs.csv").open(newline="") as source:
                reader = csv.DictReader(source)
                self.assertIn("journeyIndex", reader.fieldnames)
                self.assertEqual(list(reader), [])
            result = self.result("route", result={"legs": [{"type": "walk", "geometry": object()}]})
            result.export_tables(directory)
            self.assertNotIn("geometry", (target / "legs.csv").read_text())

    def test_export_memory_does_not_duplicate_the_table(self):
        import tracemalloc
        result = self.result("matrix", rows=[{"status": "ready", "originId": str(i),
            "journey": {"legs": [{"type": "ride", "durationMinutes": i}]}} for i in range(10000)])
        with tempfile.TemporaryDirectory() as directory:
            tracemalloc.start()
            try:
                result.export_tables(directory)
                peak = tracemalloc.get_traced_memory()[1]
            finally:
                tracemalloc.stop()
        self.assertLess(peak, 2 * 1024 * 1024)

    def test_export_borrows_nested_values_without_mutating_results(self):
        geometry = [[0, 0], [1, 1]]
        result = self.result("route", result={"legs": [
            {"type": "walk", "coordinates": geometry, "evidence": {"source": "street"}},
        ]})
        before = copy.deepcopy(result._payload)
        copy_json = model.copy_json

        def copy_metadata_only(value):
            if isinstance(value, dict) and "journeyIndex" in value:
                self.fail("CSV export must not copy journey or leg records")
            return copy_json(value)

        with tempfile.TemporaryDirectory() as directory, patch("vigo.model.copy_json", copy_metadata_only):
            root = result.export_tables(directory, include_geometry=True)
            with (root / "legs.csv").open(newline="") as source:
                leg = next(csv.DictReader(source))
            self.assertEqual(json.loads(leg["coordinates"]), geometry)
            self.assertEqual(json.loads(leg["evidence"]), {"source": "street"})
        self.assertEqual(result._payload, before)

    def test_failed_serialization_preserves_existing_export(self):
        original = self.result("route", result={"durationMinutes": 3, "legs": []})
        invalid = self.result("route", result={"durationMinutes": 4, "legs": [
            {"type": "walk", "geometry": {"invalid": object()}},
        ]})
        with tempfile.TemporaryDirectory() as directory:
            target = original.export_tables(directory)
            before = {p.name: p.read_bytes() for p in target.iterdir()}
            with self.assertRaises(TypeError):
                invalid.export_tables(directory, include_geometry=True)
            self.assertEqual({p.name: p.read_bytes() for p in target.iterdir()}, before)
            original.export_tables(directory)
            self.assertEqual({p.name: p.read_bytes() for p in target.iterdir()}, before)

    def test_empty_matrix_tables_have_distinct_headers(self):
        with tempfile.TemporaryDirectory() as directory:
            target = self.result("matrix", rows=[]).export_tables(directory)
            with (target / "journeys.csv").open(newline="") as source:
                columns = csv.DictReader(source).fieldnames
            self.assertIn("hasJourney", columns)
            self.assertNotIn("legIndex", columns)
            with (target / "legs.csv").open(newline="") as source:
                self.assertIn("legIndex", csv.DictReader(source).fieldnames)
