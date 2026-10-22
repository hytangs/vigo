"""Public synthetic integration fixture; enable with VIGO_TEST_INPUTS and VIGO_RUNTIME."""

from __future__ import annotations

import contextlib
import datetime as dt
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import vigo


def _one_shot(runtime, city, kind, request, arguments, timeout):
    """Independent CLI reference; production queries use only resident streams."""
    from vigo.runtime import _command_environment

    response = subprocess.run(
        [*runtime.command, kind, f"--city={city}", "--request=-", "--diagnostics=trace", *arguments],
        input=json.dumps(request, allow_nan=False), text=True, encoding="utf-8",
        capture_output=True, check=True, timeout=timeout,
        env=_command_environment(runtime.command),
    )
    return json.loads(response.stdout)["trace"]


@unittest.skipUnless(
    os.environ.get("VIGO_TEST_INPUTS"),
    "set VIGO_TEST_INPUTS to the public CLI fixture directory",
)
class LiveRuntimeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary = tempfile.TemporaryDirectory(prefix="vigo-python-integration-")
        inputs = Path(os.environ["VIGO_TEST_INPUTS"])
        cls.build_progress = io.StringIO()
        with contextlib.redirect_stderr(cls.build_progress):
            cls.city = vigo.build(
                Path(cls.temporary.name) / "city",
                gtfs=inputs / "fixture.zip",
                osm=inputs / "fixture.osm.pbf",
                progress=True,
            )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.city.close()
        cls.temporary.cleanup()

    def test_parallel_batch_preserves_order_dates_and_full_journeys(self) -> None:
        queries = [vigo.Matrix({"a": "A"}, {"b": "B"}, include_journeys=True,
                               include_geometry=True, depart_at=clock, service_date=date)
                   for date in ("2026-07-15", "2026-07-18", "2026-07-15")
                   for clock in ("07:55", "08:05")]
        expected = self.city.run(queries)
        actual = list(self.city.iter_run(iter(queries), workers=2))
        for before, after in zip(expected, actual):
            self.assertEqual(before.rows, after.rows)
            self.assertEqual(before.query, after.query)
        self.assertEqual(len(actual), len(queries))
        self.assertLessEqual(len(self.city._streams), self.city._stream_limit)

    def test_route_alternatives_match_engine_and_preserve_details(self) -> None:
        def journey(value):
            # Compare itinerary content; process timing/cache diagnostics differ.
            return {key: item for key, item in value.items() if key != "diagnostics"} if value else value
        for ranking in ("pareto", "ranked"):
            with self.subTest(ranking=ranking):
                result = self.city.route("A", "B", depart_at="07:55", service_date="2026-07-15",
                                         alternatives=3, alternative_ranking=ranking,
                                         alternative_slack_minutes=20, max_walk_km=0.2)
                expected = _one_shot(self.city.runtime, self.city.path, "route", {
                    "origin": {"stopId": "A"}, "destination": {"stopId": "B"},
                    "time": "07:55", "serviceDate": "2026-07-15", "maxWalkKm": 0.2,
                    "alternatives": 3, "alternativeRanking": ranking, "alternativeSlackMinutes": 20,
                }, [], 60)
                self.assertEqual(journey(result.value), journey(expected["result"]))
                self.assertEqual(tuple(map(journey, result.choices)), tuple(map(journey, expected.get("choices", []))))
                self.assertEqual(result.alternative_search, expected["alternativeSearch"])
                self.assertEqual(result.alternative_search["ranking"], ranking)
                self.assertEqual(result.query["alternativeRanking"], ranking)
                self.assertEqual(result.query["alternatives"], 3)
                self.assertLessEqual(len(result.choices), 3)
                if result.choices:
                    original = result.choices
                    changed = result.choices
                    changed[0]["legs"] = []
                    self.assertEqual(result.choices, original)
        for options in ({"arrive_by": "09:00"}, {"mode": "walk"},
                        {"waypoints": ["C"]}, {"departure_window_minutes": 5}):
            self.assertFalse(self.city.supports(vigo.Route("A", "B", alternatives=1, **options)).supported)

    def test_dates_reuse_one_idle_engine_process(self) -> None:
        if self.city.runtime.capabilities.get("output", {}).get("requestServiceDate") is not True:
            self.skipTest("runtime does not advertise per-request service dates")
        self.city.close()
        process_ids = set()
        for date in ("2026-07-15", "2026-07-18", "2026-07-19", "2026-07-15"):
            route = self.city.route("A", "B", depart_at="07:55", service_date=date)
            self.assertEqual(route.query["serviceDate"], date)
            with vigo.open(self.city.path, runtime=self.city.runtime) as fresh:
                expected = fresh.route("A", "B", depart_at="07:55", service_date=date)
            self.assertEqual(route.status, expected.status)
            self.assertEqual(route.duration_minutes, expected.duration_minutes)
            process_ids.update(stream._process.pid for stream in self.city._streams.values())
        self.assertEqual(len(process_ids), 1)
        self.assertEqual(len(self.city._streams), 1)

    def test_analysis_tables_match_engine_journeys(self) -> None:
        options = {"depart_at": "07:55", "service_date": "2026-07-15", "max_walk_km": 0.2}
        route = self.city.route("A", "B", **options)
        matrix = self.city.matrix(["A"], ["B"], include_journeys=True, **options)
        for result in (route, matrix):
            summaries = list(result.iter_journeys())
            self.assertEqual(len(summaries), 1)
            self.assertTrue(summaries[0]["hasJourney"])
            legs = list(result.iter_legs())
            self.assertEqual(len(legs), summaries[0]["legCount"])
            self.assertTrue(legs)
            self.assertTrue(all("coordinates" not in leg for leg in legs))
            self.assertTrue(all(leg["cityRevisionId"] == self.city.revision_id for leg in legs))
            original = result.value if result.kind == "route" else result.rows[0]["journey"]
            self.assertEqual([leg.get("durationMinutes") for leg in legs],
                             [leg.get("durationMinutes") for leg in original["legs"]])

    def test_repeated_matrix_pairs_preserve_rows_and_journeys(self) -> None:
        for geometry in (False, True):
            with self.subTest(geometry=geometry):
                options = {"depart_at": "07:55", "service_date": "2026-07-15",
                           "max_walk_km": 0.2, "include_journeys": True,
                           "include_geometry": geometry}
                expected = self.city.matrix(["A"], ["B"], **options).rows[0]
                result = self.city.matrix({"a1": "A", "a2": "A"},
                                          {"b1": "B", "b2": "B"}, **options)
                rows = result.rows
                self.assertEqual(len(rows), 4)
                self.assertEqual([(row["originId"], row["destinationId"]) for row in rows],
                                 [("a1", "b1"), ("a1", "b2"), ("a2", "b1"), ("a2", "b2")])
                for row in rows:
                    self.assertEqual(row["durationMinutes"], expected["durationMinutes"])
                    self.assertEqual(row["journey"]["legs"], expected["journey"]["legs"])
                rows[0]["journey"]["legs"][0]["durationMinutes"] = -100
                self.assertNotEqual(rows[1]["journey"]["legs"][0]["durationMinutes"], -100)

    def test_route_matrix_parity_for_each_mode(self) -> None:
        for mode in ("transit", "walk", "drive"):
            with self.subTest(mode=mode):
                route = self.city.route(
                    "A",
                    "B",
                    mode=mode,
                    depart_at="07:55",
                    service_date="2026-07-15",
                    max_walk_km=0.2,
                )
                matrix = self.city.matrix(
                    {"a": "A"},
                    {"b": "B"},
                    mode=mode,
                    depart_at="07:55",
                    service_date="2026-07-15",
                    max_walk_km=0.2,
                )
                self.assertEqual(route.status, "ready")
                self.assertEqual(matrix.rows[0]["status"], "ready")
                self.assertAlmostEqual(
                    route.duration_minutes,
                    matrix.rows[0]["durationMinutes"],
                    delta=0.001,
                )
                for field in ("openMs", "computeMs", "endToEndMs"):
                    self.assertGreaterEqual(route.timing[field], 0)
                self.assertEqual(route.query["serviceDate"], "2026-07-15")

    def test_walking_reach_and_public_stop_references(self) -> None:
        options = {"service_date": "2026-07-15", "depart_at": "07:55", "max_walk_km": 0.2}
        matrix = self.city.matrix({"stop": {"id": "A"}}, {"stop": {"id": "B"}}, **options)
        reference = self.city.matrix("A", "B", **options)
        self.assertEqual(matrix.rows, reference.rows)
        for sampling in ("street", "cell-center"):
            result = self.city.reach("A", mode="walk", surface_sampling=sampling,
                                    include_street_edges=True, raster_size=48, extent_radius_km=2, **options)
            self.assertEqual(result.status, "ready")
            self.assertEqual(result.query["mode"], "walk")
            self.assertEqual(result.query["surfaceSampling"], sampling)
            self.assertTrue(result.query["includeStreetEdges"])
            self.assertEqual(len(result.value["values"]), 48 * 48)

    def test_decoder_preserves_complete_live_responses(self) -> None:
        from vigo._json import loads

        decoded = []

        def checked_loads(line):
            value = loads(line)
            decoded.append(value == json.loads(line))
            return value

        options = {"service_date": "2026-07-15", "depart_at": "07:55", "max_walk_km": 0.2}
        with patch("vigo.model.loads", checked_loads):
            self.city.route("A", "B", **options)
            self.city.matrix(["A"] * 1024, ["B"], **options)
            self.city.reach("A", extent_radius_km=2, **options)
        self.assertEqual(len(decoded), 3)
        self.assertTrue(all(decoded), "selected decoder changed a live Engine response")

    def test_resident_queries_match_one_shot_and_reuse_process(self) -> None:
        options = {"depart_at": "07:55", "service_date": "2026-07-15", "max_walk_km": 0.2}
        stream = None
        for mode, waypoints in (("transit", []), ("walk", []), ("drive", []), ("walk", ["X"])):
            with self.subTest(mode=mode, waypoints=waypoints):
                resident = self.city.route("A", "B", mode=mode, waypoints=waypoints, **options)
                current = next(s for s in self.city._streams.values() if s._request_date == "2026-07-15")
                if stream is not None:
                    self.assertIs(current, stream)
                stream = current
                one_shot = _one_shot(self.city.runtime, self.city.path, "route", {
                    "origin": "A", "destination": "B", "mode": mode, "waypoints": waypoints,
                    "requireTransitRide": False,
                }, ["--service-date=2026-07-15", "--time=07:55", "--max-walk=0.2"], 30)
                self.assertEqual(resident.status, one_shot["status"])
                for field in ("durationMinutes", "departMinutes", "arriveMinutes"):
                    self.assertEqual(resident.value[field], one_shot["result"][field])
                repeated = self.city.route("A", "B", mode=mode, waypoints=waypoints, **options)
                self.assertEqual(repeated.timing["openMs"], 0)
        # The first Reach opens the resident native runtime; the next reuses it.
        self.city.reach("A", raster_size=48, extent_radius_km=2, **options)
        resident = self.city.reach("A", raster_size=48, extent_radius_km=2, **options)
        one_shot = _one_shot(self.city.runtime, self.city.path, "reach", {
            "origin": "A", "rasterSize": 48, "extentRadiusKm": 2,
        }, ["--service-date=2026-07-15", "--time=07:55", "--max-walk=0.2"], 30)
        for field in ("values", "width", "height", "bounds", "schemaVersion"):
            self.assertEqual(resident.value[field], one_shot["surface"][field])
        self.assertEqual(resident.to_geojson(), one_shot["contours"])
        self.assertIs(next(s for s in self.city._streams.values() if s._request_date == "2026-07-15"), stream)
        self.assertEqual(resident.timing["openMs"], 0)

    def test_traffic_changes_drive_route_and_matrix_without_leaking(self) -> None:
        options = {"mode": "drive", "service_date": "2026-07-15", "depart_at": "07:55"}
        baseline = self.city.route("A", "B", **options)
        traffic = self.city.scenario("delay", traffic={
            "source": "public-fixture", "observedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "ttlSeconds": 300, "observations": [{
                "fromCoordinate": [-77.05, 38.9], "toCoordinate": [-77.04, 38.905], "delayFactor": 10,
            }],
        })
        delayed = traffic.route("A", "B", **options)
        matrix = traffic.matrix({"a": "A"}, {"b": "B"}, **options)
        self.assertGreater(delayed.duration_minutes, baseline.duration_minutes)
        self.assertAlmostEqual(delayed.duration_minutes, matrix.rows[0]["durationMinutes"], delta=0.001)
        self.assertEqual(matrix.query["routingDataMode"], "realtime")
        self.assertEqual(self.city.route("A", "B", **options).duration_minutes, baseline.duration_minutes)
        for snapshot in ({}, {"observations": []}):
            invalid = self.city.scenario("invalid", traffic=snapshot)
            with self.assertRaises(vigo.VigoError):
                invalid.matrix({"a": "A"}, {"b": "B"}, **options)
            with self.assertRaises(vigo.VigoError):
                invalid.route("A", "B", **options)
        # A rejected request does not poison the resident process.
        self.assertEqual(self.city.route("A", "B", **options).duration_minutes, baseline.duration_minutes)

    def test_build_reports_actual_phases(self) -> None:
        output = self.build_progress.getvalue()
        for phase in ("[gtfs]", "[osm]", "Preparing street routing", "Preparing station access", "Saving City", "City built"):
            self.assertIn(phase, output)
        self.assertNotIn("100%", output)

    def test_waypoints_arrive_by_and_exports(self) -> None:
        route = self.city.route(
            "A",
            "B",
            waypoints=["X"],
            mode="walk",
            arrive_by="08:30",
            service_date="2026-07-15",
        )
        self.assertEqual(route.status, "ready")
        self.assertEqual(len(route.value["waypoints"]), 1)
        arrival = dt.datetime.fromisoformat(route.value.get("clockDate") or route.value.get("diagnostics", {}).get("clockDate") or route.query["serviceDate"]) + dt.timedelta(minutes=route.value["arriveMinutes"])
        self.assertEqual(arrival, dt.datetime(2026, 7, 15, 8, 30))
        exported = route.export(Path(self.temporary.name) / "route.geojson")
        self.assertGreater(len(json.loads(exported.read_text())["features"]), 0)
        matrix = self.city.matrix({"a": "A"}, {"b": "B"}, service_date="2026-07-15")
        self.assertIn(
            "durationMinutes",
            matrix.export(Path(self.temporary.name) / "matrix.csv").read_text(),
        )

    def test_transit_cache_control_is_forwarded_and_preserves_results(self) -> None:
        options = {"depart_at": "07:55", "service_date": "2026-07-15", "max_walk_km": 0.2}
        cached = self.city.route("A", "B", **options)
        uncached = self.city.route("A", "B", disable_cache=True, **options)
        self.assertEqual(cached.duration_minutes, uncached.duration_minutes)
        self.assertTrue(uncached.query["disableCache"])
        matrix = self.city.matrix({"a": "A"}, {"b": "B"}, disable_cache=True,
                                  include_journeys=True, include_geometry=True, **options)
        self.assertAlmostEqual(matrix.rows[0]["durationMinutes"], uncached.duration_minutes, delta=0.000501)

    def test_arrive_by_large_many_to_one_matrix(self) -> None:
        result = self.city.matrix(
            {f"point_{i}": "A" for i in range(1024)}, {"hub": "B"},
            arrive_by="08:30", service_date="2026-07-15", max_walk_km=0.2,
        )
        stream = next(s for s in self.city._streams.values() if s._request_date == "2026-07-15")
        point = self.city.route("A", "B", arrive_by="08:30", service_date="2026-07-15", max_walk_km=0.2)
        repeated = self.city.matrix({"a": "A"}, {"b": "B"}, depart_at="07:55", service_date="2026-07-15", max_walk_km=0.2)
        self.assertIs(next(s for s in self.city._streams.values() if s._request_date == "2026-07-15"), stream)
        self.assertEqual(repeated.timing["openMs"], 0)
        self.assertEqual(result.query["timePreference"], "arrive")
        self.assertEqual(len(result.rows), 1024)
        for row in result.rows:
            self.assertEqual(row["status"], "ready")
            self.assertAlmostEqual(row["departMinutes"], point.value["departMinutes"], delta=0.000501)
            self.assertEqual(row["arriveMinutes"], point.value["arriveMinutes"])
            arrival = dt.datetime.fromisoformat(point.value.get("clockDate") or point.value.get("diagnostics", {}).get("clockDate") or point.query["serviceDate"]) + dt.timedelta(minutes=row["arriveMinutes"])
            self.assertEqual(arrival, dt.datetime(2026, 7, 15, 8, 30))

    def test_transfer_caps_use_the_resident_runtime_in_both_directions(self) -> None:
        for time in ({"depart_at": "07:55"}, {"arrive_by": "08:30"}):
            for cap in (0, 1, None):
                options = {**time, "service_date": "2026-07-15", "max_walk_km": 0.2, "max_transfers": cap}
                route = self.city.route("A", "B", **options)
                matrix = self.city.matrix({"a": "A"}, {"b": "B"}, **options)
                self.assertEqual(route.status, matrix.rows[0]["status"])
                if route.status == "ready":
                    self.assertLessEqual(route.value["transfers"], cap if cap is not None else 31)
                    field = "departMinutes" if "arrive_by" in time else "arriveMinutes"
                    self.assertAlmostEqual(route.value[field], matrix.rows[0][field], delta=0.001)
                detailed = self.city.matrix({"a": "A"}, {"b": "B"}, include_journeys=True, **options)
                self.assertEqual(matrix.rows[0]["status"], detailed.rows[0]["status"])
                if route.status == "ready":
                    journey = detailed.rows[0]["journey"]
                    for field in ("departMinutes", "arriveMinutes", "walkMinutes", "transfers"):
                        self.assertAlmostEqual(route.value[field], journey[field], delta=0.003)
                    self.assertTrue(journey["legs"])

    def test_arrive_by_reach_gathers_toward_a_destination(self) -> None:
        options = {"service_date": "2026-07-15", "max_walk_km": 0.2, "raster_size": 48,
                   "extent_radius_km": 2, "cutoffs_minutes": (15, 30, 45)}
        query = vigo.Reach(destination="B", arrive_by="08:30", **options)
        support = self.city.supports(query)
        if not support.supported:
            self.assertEqual(support.reason, "arrive_by_reach")
            with self.assertRaises(vigo.UnsupportedQuery):
                self.city.run(query)
            self.skipTest("runtime does not advertise arrive-by Reach")
        for mode in ("transit", "walk"):
            with self.subTest(mode=mode):
                result = self.city.run(vigo.Reach(destination="B", arrive_by="08:30", mode=mode, **options))
                self.assertEqual(result.status, "ready")
                self.assertEqual(result.query["timePreference"], "arrive_by")
                self.assertNotIn("origin", result.query)
                self.assertEqual(len(result.value["values"]), 48 * 48)
                one_shot = _one_shot(self.city.runtime, self.city.path, "reach", {
                    "destination": "B", "timePreference": "arrive_by", "mode": mode,
                    "rasterSize": 48, "extentRadiusKm": 2, "cutoffsMinutes": [15, 30, 45],
                }, ["--service-date=2026-07-15", "--time=08:30", "--max-walk=0.2"], 30)
                for field in ("values", "width", "height", "bounds"):
                    self.assertEqual(result.value[field], one_shot["surface"][field])
        with self.assertRaises(vigo.InvalidQuery):
            self.city.reach("A", arrive_by="08:30", **options)

    def test_reach_replacement_and_compare(self) -> None:
        options = {
            "depart_at": "07:55",
            "service_date": "2026-07-15",
            "max_walk_km": 0.2,
            "raster_size": 48,
            "extent_radius_km": 2,
        }
        baseline = self.city.reach("A", **options)
        repeated = self.city.reach("A", **options)
        difference = vigo.compare(baseline, repeated)
        self.assertEqual(difference.value["meanChangeMinutes"], 0)
        self.assertGreater(difference.value["comparableCells"], 0)
        replacement = self.city.scenario(
            "Replace R1",
            services=[
                {
                    "operation": "replace",
                    # This fixture replaces the whole route with a frequency
                    # service; preserving source trips requires branch scope.
                    "scheduleMode": "frequency",
                    "sourceRouteId": "R1",
                    "stops": [
                        {"coordinate": [-77.05, 38.9]},
                        {"coordinate": [-77.03, 38.91]},
                    ],
                }
            ],
        ).reach("A", **options)
        self.assertTrue(
            any(
                route.endswith("R1")
                for route in replacement.query["scenario"]["excludedRouteIds"]
            )
        )
        self.assertEqual(replacement.to_geojson()["type"], "FeatureCollection")


if __name__ == "__main__":
    unittest.main()
