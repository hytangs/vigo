from __future__ import annotations

import gc
import json
import sys
import tempfile
import textwrap
import threading
import time
import unittest
import weakref
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

import vigo
from vigo import model

FAKE_VIGO = r"""from __future__ import annotations
import json
import pathlib
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
args = sys.argv[1:]
if args == ["--version"]:
    print("0.5.0")
    raise SystemExit
if args == ["--help"]:
    print("vigo build\nvigo capabilities\nvigo inspect\nvigo route\nvigo matrix\nvigo reach\nvigo compare")
    raise SystemExit
if args == ["capabilities"]:
    print(json.dumps({
        "schemaVersion": "vigo.capabilities.v3",
        "output": {"diagnostics": ["none", "summary", "profile", "trace"]},
        "productVersion": "0.5.0",
        "apiVersion": "1.0",
        "cityFormatVersion": 1,
        "city": {"privateAccess": ["public", "endpoints"]},
        "resultSchemaVersion": 1,
        "publicCliCommands": ["build", "capabilities", "inspect", "route", "matrix", "reach", "stream", "compare"],
        "queries": [
            {"id": "reach", "resident": True, "modes": {"available": ["transit", "walk"]}},
            {"id": "route", "resident": True, "transitStreetCacheControl": True, "maxTransfers": {"min": 0, "max": 31, "default": None}},
            {"id": "matrix", "resident": True, "journeys": True,
             "transitStreetCacheControl": True,
             "maxTransfers": {"min": 0, "max": 31, "default": None},
             "time": {"available": ["depart_at", "arrive_by"]}},
        ],
    }))
    raise SystemExit

command = args[0]
options = dict(part[2:].split("=", 1) for part in args[1:] if part.startswith("--") and "=" in part)
if command == "build":
    city = pathlib.Path(options["output"])
    (city / "routing").mkdir(parents=True)
    (city / "osm").mkdir()
    (city / "routing" / "project.sqlite").touch()
    (city / "osm" / "street-index.sqlite").touch()
    manifest = {
        "schemaVersion": "vigo.city.v1",
        "cityFormatVersion": 1,
        "name": "built-city",
        "privateAccess": options.get("private-access", "public"),
        "streetModes": options.get("street-modes", "walk,drive"),
        "revisionId": "20260904T120000-001Z",
        "builtAt": "2026-09-04T12:00:00.000Z",
        "sources": {"gtfs": [{"name": "feed.zip"}], "osm": {"name": "region.osm.pbf"}},
    }
    (city / "network.json").write_text(json.dumps(manifest))
    print(json.dumps(manifest))
elif command == "stream":
    if options.get("diagnostics") != "trace":
        raise SystemExit("Python must request detailed Results explicitly")
    for line in sys.stdin:
        request = json.loads(line)
        kind = request["kind"]
        response = {
            "schemaVersion": f"vigo.result.{kind}.v1", "productVersion": "0.5.0",
            "apiVersion": "1.0", "resultSchemaVersion": 1, "id": request["id"],
            "kind": kind, "status": "ready", "query": {**request, "serviceDate": options["service-date"]}, "warnings": [],
            "timing": {"computeMs": 1.0},
        }
        if kind == "matrix":
            response["rows"] = [{
                "originIndex": i, "destinationIndex": j,
                "originId": origin["id"], "destinationId": destination["id"],
                "status": "ready", "durationMinutes": 10 + i + j,
            } for i, origin in enumerate(request["origins"]) for j, destination in enumerate(request["destinations"])]
        elif kind == "reach":
            size = request["rasterSize"]
            response["surface"] = {"width": size, "height": size, "values": [1] * (size * size)}
            response["contours"] = {"type": "FeatureCollection", "features": []}
        elif kind == "route":
            unexpected = set(request) - {
                "id", "kind", "origin", "destination", "mode", "time", "timePreference",
                "objective", "maxWalkKm", "maxTransfers", "departureWindowMinutes", "waypoints",
                "requireTransitRide", "horizonMinutes", "disableCache",
            }
            if unexpected:
                raise SystemExit(f"unexpected route fields: {sorted(unexpected)}")
            response["result"] = {"status": "ready", "durationMinutes": 8 if request.get("waypoints") else 12.5,
                "transfers": 0, "legs": [{"type": "ride", "coordinates": [[0, 0], [1, 1]]}]}
            if request["origin"] == "JSON":
                response["result"]["title"] = 'Station — 北 "A"'
        else:
            raise SystemExit("unknown query")
        print(json.dumps({"schema": f"vigo.{kind}.v1", "status": "ok", "id": request["id"], "trace": response}, ensure_ascii=False), flush=True)
else:
    raise SystemExit(2)
"""


class VigoPythonTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.cli = self.root / "fake_vigo.py"
        self.cli.write_text(textwrap.dedent(FAKE_VIGO), encoding="utf-8")
        self.command = (sys.executable, str(self.cli))
        self.city_path = self.root / "city"
        (self.city_path / "routing").mkdir(parents=True)
        (self.city_path / "osm").mkdir()
        (self.city_path / "routing" / "project.sqlite").touch()
        (self.city_path / "osm" / "street-index.sqlite").touch()
        (self.city_path / "network.json").write_text(
            json.dumps(
                {
                    "schemaVersion": "vigo.city.v1",
                    "cityFormatVersion": 1,
                    "name": "city",
                    "revisionId": "20260904T120000-001Z",
                    "builtAt": "2026-09-04T12:00:00.000Z",
                    "sources": {
                        "gtfs": [{"name": "feed.zip"}],
                        "osm": {"name": "region.osm.pbf"},
                    },
                }
            ),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_reach_options_and_structured_matrix_stops(self) -> None:
        with vigo.open(self.city_path, runtime=self.command) as city:
            result = city.reach("A", service_date="2026-07-15", mode="walk",
                                surface_sampling="cell-center", include_street_edges=True)
            self.assertEqual(result.query["mode"], "walk")
            self.assertEqual(result.query["surfaceSampling"], "cell-center")
            self.assertTrue(result.query["includeStreetEdges"])
            matrix = city.matrix({"stop": {"id": "A", "feed": "feed"}},
                                 {"stop": {"id": "B"}}, service_date="2026-07-15")
            self.assertEqual(len(matrix.rows), 1)
            self.assertEqual(matrix.query["origins"], [
                {"id": "origin", "point": {"stop": {"id": "A", "feed": "feed"}}}
            ])
            for options in ({"mode": "drive"}, {"surface_sampling": "coordinate"},
                            {"include_street_edges": "true"}):
                with self.assertRaises(vigo.InvalidQuery):
                    city.reach("A", service_date="2026-07-15", **options)
            with patch.dict(city.runtime.capabilities, {"queries": []}):
                self.assertFalse(city.supports(vigo.Reach("A", mode="walk")).supported)
            self.assertFalse(city.scenario("planned", without_routes=["R1"]).supports(
                vigo.Reach("A", mode="walk")).supported)

    def test_configured_runtime_fails_closed(self) -> None:
        with patch.dict("os.environ", {"VIGO_RUNTIME": str(self.root / "missing")}), self.assertRaises(vigo.VigoError):
            vigo.resolve_runtime()

    def test_bundled_runtime_is_relocatable_and_environment_isolated(self) -> None:
        from vigo.runtime import _command_environment
        bundle = self.root.resolve() / "headless"
        bundle.mkdir()
        import os
        executable = bundle / ("node.exe" if os.name == "nt" else "node")
        program, kernel = bundle / "vigo.mjs", bundle / "vigo-routing-kernel.node"
        for file in (executable, program, kernel):
            file.touch()
        with patch.dict("os.environ", {"NODE_OPTIONS": "--bad-option", "VIGO_NATIVE_ROUTING_KERNEL": "wrong",
                                      "PROVIDER_SECRET": "private", "PATH": "", "HOME": str(self.root)}, clear=True), \
             patch("vigo.runtime._BUNDLED_RUNTIME", bundle):
            runtime = vigo.resolve_runtime(verify=False)
            self.assertEqual(runtime.source, "bundled")
            self.assertEqual(runtime.command, (str(executable), str(program)))
            environment = _command_environment(runtime.command)
            self.assertNotIn("NODE_OPTIONS", environment)
            self.assertNotIn("PROVIDER_SECRET", environment)
            self.assertEqual(environment["VIGO_NATIVE_ROUTING_KERNEL"], str(kernel))
            self.assertEqual(environment["HOME"], str(self.root))

    def test_traffic_requires_an_advertised_runtime_capability(self) -> None:
        with vigo.open(self.city_path, runtime=self.command) as city:
            scenario = city.scenario("traffic", traffic={"observations": []})
            for query in (vigo.Route("A", "B", mode="drive"), vigo.Matrix({"a": "A"}, {"b": "B"}, mode="drive")):
                with self.assertRaises(vigo.UnsupportedQuery):
                    scenario.run(query)

    def test_studio_runtime_ignores_host_injection_settings(self) -> None:
        from vigo.runtime import _command_environment
        app = self.root.resolve() / "Relocated Studio.app"
        executable = app / "Contents/MacOS/VIGO Studio"
        program = app / "Contents/Resources/app/public/vigo.mjs"
        kernel = app / "Contents/Resources/app/server/vigo-routing-kernel.node"
        for file in (executable, program, kernel):
            file.parent.mkdir(parents=True, exist_ok=True)
            file.touch()
        with patch.dict("os.environ", {
            "NODE_OPTIONS": "--bad-option", "NODE_PATH": "unrelated-modules",
            "VIGO_NATIVE_ROUTING_KERNEL": "wrong", "ELECTRON_RUN_AS_NODE": "0",
            "DYLD_INSERT_LIBRARIES": "unrelated-library", "PROVIDER_SECRET": "private",
            "PATH": "", "HOME": str(self.root), "LANG": "en_US.UTF-8",
        }, clear=True):
            runtime = vigo.resolve_runtime(app, verify=False)
            self.assertEqual(runtime.command, (str(executable), str(program)))
            self.assertEqual(_command_environment(runtime.command), {
                "PATH": "", "HOME": str(self.root), "LANG": "en_US.UTF-8",
                "ELECTRON_RUN_AS_NODE": "1", "VIGO_NATIVE_ROUTING_KERNEL": str(kernel),
            })

    def test_runtime_output_is_utf8(self) -> None:
        from vigo.runtime import _run

        response = _run((sys.executable, "-c", "import sys; sys.stdout.buffer.write('北站'.encode('utf-8'))"))
        self.assertEqual(response.stdout, "北站")

    def test_runtime_handshake_reuses_only_unchanged_files(self) -> None:
        from vigo.runtime import _run

        with patch("vigo.runtime._run", wraps=_run) as run:
            first = vigo.resolve_runtime(self.command)
            first.capabilities["queries"].clear()
            second = vigo.resolve_runtime(self.command)
            self.assertTrue(second.capabilities["queries"])
            self.assertEqual(run.call_count, 1)
            self.cli.write_text(self.cli.read_text().replace('"0.5.0"', '"0.5.1"'))
            changed = vigo.resolve_runtime(self.command)
            self.assertEqual(changed.product_version, "0.5.1")
            self.assertEqual(run.call_count, 2)

    def test_old_runtime_requires_current_engine(self) -> None:
        self.cli.write_text(self.cli.read_text().replace('"0.5.0"', '"0.4.4"'))
        with self.assertRaisesRegex(vigo.VigoError, "VIGO 0.5 runtime"):
            vigo.resolve_runtime(self.command)

    def test_runtime_requires_current_api_schema_and_trace_output(self) -> None:
        source = self.cli.read_text()
        for old, new in (
            ('"apiVersion": "1.0"', '"apiVersion": "1.1"'),
            ('"vigo.capabilities.v3"', '"vigo.capabilities.v2"'),
            ('"summary", "profile", "trace"', '"summary", "profile"'),
        ):
            with self.subTest(replacement=new):
                self.cli.write_text(source.replace(old, new))
                with self.assertRaises(vigo.VigoError):
                    vigo.resolve_runtime(self.command)

    def test_point_mappings_require_current_engine_fields(self) -> None:
        with vigo.open(self.city_path, runtime=self.command) as city:
            for point in ({"stop_id": "A"}, {"lat": 38.9, "lon": -77.05}, {"lat": 38.9, "lng": -77.05}):
                with self.subTest(point=point), self.assertRaises(vigo.InvalidQuery):
                    city.route(point, "B", depart_at="08:00", service_date="2026-07-15")
            self.assertFalse(city._streams)

    def test_matrix_comparison_matches_ids_and_rejects_index_only_rows(self) -> None:
        def matrix(rows):
            return vigo.Result("matrix", {"resultSchemaVersion": 1, "status": "ready", "rows": rows}, "fixture")

        before = matrix([
            {"originId": "a", "destinationId": "hub", "durationMinutes": 10},
            {"originId": "b", "destinationId": "hub", "durationMinutes": 20},
        ])
        after = matrix([
            {"originId": "b", "destinationId": "hub", "durationMinutes": 19},
            {"originId": "a", "destinationId": "hub", "durationMinutes": 9},
        ])
        change = vigo.compare(before, after).value
        self.assertEqual(change["comparablePairs"], 2)
        self.assertEqual(change["meanChangeMinutes"], -1)
        obsolete = matrix([{"originIndex": 0, "destinationIndex": 0, "durationMinutes": 10}])
        for left, right in ((obsolete, before), (before, obsolete)):
            with self.assertRaisesRegex(TypeError, "originId and destinationId"):
                vigo.compare(left, right)

    def test_failed_runtime_handshake_is_not_cached(self) -> None:
        from vigo.runtime import _run

        with patch("vigo.runtime._run", side_effect=[vigo.VigoError("unavailable"),
                                                   _run(self.command, "capabilities")]) as run:
            with self.assertRaises(vigo.VigoError):
                vigo.resolve_runtime(self.command)
            self.assertEqual(vigo.resolve_runtime(self.command).product_version, "0.5.0")
            self.assertEqual(run.call_count, 2)

    def test_city_has_one_query_model(self) -> None:
        with vigo.open(self.city_path, runtime=self.command) as city:
            route = city.route("A", "B", depart_at="08:00", service_date="2026-09-04")
            route_via = city.route(
                "A",
                "B",
                waypoints=["C"],
                depart_at="08:00",
                service_date="2026-09-04",
            )
            matrix = city.matrix(
                {"a": "A", "b": "B"},
                {"c": "C", "d": "D"},
                depart_at="08:00",
                service_date="2026-09-04",
            )
            reach = city.reach(
                [0, 0],
                depart_at="08:00",
                service_date="2026-09-04",
                raster_size=48,
            )

        self.assertEqual(route.kind, "route")
        self.assertEqual(route.duration_minutes, 12.5)
        self.assertEqual(route_via.duration_minutes, 8)
        self.assertEqual(len(matrix.rows), 4)
        self.assertEqual(reach.to_geojson()["type"], "FeatureCollection")
        self.assertEqual(route.city_revision_id, "20260904T120000-001Z")

    def test_result_exports_do_not_mutate_retained_route(self) -> None:
        with vigo.open(self.city_path, runtime=self.command) as city:
            route = city.route("A", "B", depart_at="08:00", service_date="2026-09-04")
        expected = route.to_dict()
        value = route.value
        value["durationMinutes"] = -1
        value.setdefault("legs", []).append({"type": "invalid"})
        exported = route.to_dict()
        exported["result"] = None
        route.query["origin"] = "changed"
        route.timing["computeMs"] = -1
        route.to_geojson()["features"][0]["geometry"]["coordinates"][0][0] = 99
        self.assertEqual(route.to_dict(), expected)
        self.assertEqual(json.loads(route.to_json(indent=None)), expected)
        self.assertEqual(json.loads(route.export(self.root / "route.json").read_text()), expected)
        self.assertEqual(route.duration_minutes, 12.5)

    def test_route_json_preserves_unicode_and_independent_mutation(self) -> None:
        with vigo.open(self.city_path, runtime=self.command) as city:
            route = city.route("JSON", "B", depart_at="08:00", service_date="2026-09-04")
            second = city.route("A", "B", depart_at="08:00", service_date="2026-09-04")
        expected = route.to_dict()
        route.value["legs"][0]["coordinates"][0][0] = 99
        route.legs[0]["coordinates"].clear()
        route.to_dict()["result"]["title"] = "changed"
        self.assertEqual(json.loads(route.to_json(indent=None)), expected)
        self.assertEqual(json.loads(route.to_json()), expected)
        self.assertIn('Station — 北', json.loads(route.to_json(indent=None))['result']['title'])
        self.assertEqual(json.loads(second.to_json(indent=None)), second.to_dict())

    def test_direct_walking_is_the_default_across_query_types(self) -> None:
        self.assertFalse(vigo.Route("A", "B").require_transit_ride)
        self.assertFalse(vigo.Matrix(["A"], ["B"]).require_transit_ride)
        with vigo.open(self.city_path, runtime=self.command) as city:
            for required in (None, True):
                options = {} if required is None else {"require_transit_ride": required}
                route = city.route("A", "B", depart_at="08:00", service_date="2026-09-04", **options)
                matrix = city.matrix(["A"], ["B"], depart_at="08:00", service_date="2026-09-04", **options)
                self.assertEqual(route.query["requireTransitRide"], required is True)
                self.assertEqual(matrix.query["requireTransitRide"], required is True)

    def test_transit_policy_and_horizon_are_query_parameters(self) -> None:
        with vigo.open(self.city_path, runtime=self.command) as city:
            route = city.route("A", "B", depart_at="08:00", service_date="2026-09-04",
                               require_transit_ride=False, horizon_minutes=120, disable_cache=True)
            self.assertFalse(route.query["requireTransitRide"])
            self.assertEqual(route.query["horizonMinutes"], 120)
            self.assertTrue(route.query["disableCache"])
            matrix = city.matrix(["A"], ["B"], service_date="2026-09-04", disable_cache=True)
            self.assertTrue(matrix.query["disableCache"])
            with self.assertRaises(vigo.InvalidQuery):
                city.route("A", "B", disable_cache="true")
            with patch.dict(city.runtime.capabilities, {"queries": []}):
                self.assertFalse(city.supports(vigo.Route("A", "B", disable_cache=True)).supported)
            with self.assertRaises(vigo.InvalidQuery):
                city.route("A", "B", require_transit_ride="false")
            with self.assertRaises(vigo.InvalidQuery):
                city.route("A", "B", horizon_minutes=float("nan"))

    def test_scenario_is_tied_to_one_city_revision(self) -> None:
        with vigo.open(self.city_path, runtime=self.command) as city:
            proposal = city.scenario(
                "More service",
                services=[
                    {
                        "name": "Crosstown",
                        "stops": [
                            {"coordinate": [0, 0]},
                            {"coordinate": [1, 1]},
                        ],
                    }
                ],
            )
            result = proposal.reach(
                [0, 0],
                depart_at="08:00",
                service_date="2026-09-04",
                raster_size=48,
            )
            support = proposal.supports(
                vigo.Route("A", "B", depart_at="08:00", service_date="2026-09-04")
            )
            self.assertFalse(support.supported)
            self.assertEqual(support.reason, "planned_transit_route")
            with self.assertRaises(vigo.UnsupportedQuery):
                proposal.route("A", "B", depart_at="08:00", service_date="2026-09-04")

        self.assertEqual(result.scenario_name, "More service")
        self.assertIn("scenario", result.query)
        self.assertEqual(result.query["scenario"]["name"], "More service")

    def test_queries_can_be_reused_and_compared(self) -> None:
        with vigo.open(self.city_path, runtime=self.command) as city:
            query = vigo.Route("A", "B", depart_at="08:00", service_date="2026-09-04")
            before, after = city.run([query, query])
            difference = vigo.compare(before, after)

        self.assertEqual(difference.kind, "comparison")
        self.assertEqual(difference.value["durationChangeMinutes"], 0)

    def test_detailed_stream_is_negotiated_without_changing_result_fields(self) -> None:
        program = self.root / "detailed_runtime.py"
        program.write_text(FAKE_VIGO.replace(
            '"output": {"diagnostics":',
            '"output": {"streamFormats": ["public", "detailed"], "diagnostics":',
        ).replace('options.get("diagnostics") != "trace"',
                  'options.get("stream-output") != "detailed"'), encoding="utf-8")
        with vigo.open(self.city_path, runtime=(sys.executable, str(program))) as city:
            result = city.route("JSON", "B", depart_at="08:00", service_date="2026-09-04")
            self.assertEqual(result.value["title"], 'Station — 北 "A"')
            self.assertEqual(len(result.legs), 1)
            self.assertEqual(result.value["durationMinutes"], 12.5)

    def test_build_publishes_one_city_directory(self) -> None:
        gtfs = self.root / "feed.zip"
        osm = self.root / "region.osm.pbf"
        gtfs.touch()
        osm.touch()
        output = self.root / "built-city"
        with vigo.build(output, gtfs=gtfs, osm=osm, runtime=self.command) as city:
            self.assertEqual(city.revision_id, "20260904T120000-001Z")
            self.assertEqual(city.runtime.product_version, "0.5.0")
            self.assertEqual(city.runtime.api_version, "1.0")
            self.assertTrue((output / "routing" / "project.sqlite").is_file())
            self.assertTrue((output / "osm" / "street-index.sqlite").is_file())

        self.assertEqual(json.loads((output / "network.json").read_text())["streetModes"], "walk,drive")
        walking = self.root / "walking-city"
        with vigo.build(walking, gtfs=gtfs, osm=osm, street_modes="walk", runtime=self.command):
            self.assertEqual(json.loads((walking / "network.json").read_text())["streetModes"], "walk")
        with self.assertRaises(ValueError):
            vigo.build(self.root / "invalid-city", gtfs=gtfs, osm=osm, street_modes="drive", runtime=self.command)

        authorized = self.root / "authorized-city"
        with vigo.build(authorized, gtfs=gtfs, osm=osm, private_access="endpoints", runtime=self.command):
            self.assertEqual(json.loads((authorized / "network.json").read_text())["privateAccess"], "endpoints")
        with vigo.open(self.city_path, runtime=self.command) as city, patch.dict(city.runtime.capabilities, {"city": {}}):
            with self.assertRaisesRegex(vigo.VigoError, "private endpoint access"):
                vigo.build(self.root / "unsupported-city", gtfs=gtfs, osm=osm, private_access="endpoints", runtime=city.runtime)
            self.assertFalse((self.root / "unsupported-city").exists())

    def test_arrive_by_matrix_preserves_direction_time_and_large_origins(self) -> None:
        with vigo.open(self.city_path, runtime=self.command) as city:
            query = vigo.Matrix(
                {f"point_{i}": "A" for i in range(1024)},
                {"b": "B"},
                arrive_by="08:30",
                service_date="2026-09-04",
            )
            support = city.supports(query)
            self.assertTrue(support.supported)
            result = city.run(query)
            self.assertEqual(len(result.rows), 1024)
            self.assertEqual(result.query["timePreference"], "arrive")
            self.assertEqual(result.query["time"], "08:30")
            stream = city._streams["2026-09-04"]
            city.matrix({"b": "B"}, {"a": "A"}, depart_at="15:00", service_date="2026-09-04")
            city.route("A", "B", depart_at="08:00", service_date="2026-09-04")
            self.assertIs(city._streams["2026-09-04"], stream)

    def test_transfer_caps_preserve_zero_and_reject_invalid_values(self) -> None:
        with vigo.open(self.city_path, runtime=self.command) as city:
            result = city.matrix(["A"], ["B"], service_date="2026-09-04", include_journeys=True, include_geometry=True)
            self.assertTrue(result.query["includeJourneys"])
            self.assertTrue(result.query["includeGeometry"])
            self.assertFalse(city.supports(vigo.Matrix(["A"], ["B"], include_geometry=True)).supported)
            self.assertFalse(city.supports(vigo.Matrix(["A"], ["B"], mode="drive", include_journeys=True)).supported)
        with vigo.open(self.city_path, runtime=self.command) as city:
            for cap in (None, 0, 1, 31):
                for query in (
                    vigo.Route("A", "B", depart_at="08:00", service_date="2026-09-04", max_transfers=cap),
                    vigo.Matrix({"a": "A"}, {"b": "B"}, arrive_by="08:30", service_date="2026-09-04", max_transfers=cap),
                ):
                    self.assertTrue(city.supports(query).supported)
                    result = city.run(query)
                    if cap is None:
                        self.assertNotIn("maxTransfers", result.query)
                    else:
                        self.assertEqual(result.query["maxTransfers"], cap)
            for cap in (-1, 32, 0.5, True, "1"):
                for query in (vigo.Route("A", "B", max_transfers=cap), vigo.Matrix(["A"], ["B"], max_transfers=cap)):
                    self.assertEqual(city.supports(query).reason, "max_transfers")
                    with self.assertRaises(vigo.UnsupportedQuery):
                        city.run(query)
            self.assertFalse(city.supports(vigo.Route("A", "B", waypoints=["C"], max_transfers=1)).supported)

    def test_missing_capabilities_reject_unsupported_queries(self) -> None:
        with (
            vigo.open(self.city_path, runtime=self.command) as city,
            patch.dict(city.runtime.capabilities, {"queries": []}),
        ):
            for query in (
                vigo.Route("A", "B", max_transfers=0),
                vigo.Matrix(["A"], ["B"], max_transfers=1),
                vigo.Matrix(["A"], ["B"], arrive_by="08:30"),
                vigo.Matrix(["A"], ["B"], include_journeys=True),
            ):
                self.assertFalse(city.supports(query).supported)
                with self.assertRaises(vigo.UnsupportedQuery):
                    city.run(query)
            with self.assertRaises(vigo.UnsupportedQuery):
                city.matrix({"a": "A"}, {"b": "B"}, depart_at="09:15",
                            service_date="2026-09-04", max_walk_km=0.7)
            self.assertFalse(city._streams)

    def test_scenario_nested_values_are_immutable_and_serializable(self) -> None:
        stops = [{"coordinate": [0, 0]}, {"coordinate": [1, 1]}]
        with vigo.open(self.city_path, runtime=self.command) as city:
            scenario = city.scenario("Frozen", services=[{"stops": stops}])
            stops[0]["coordinate"][0] = 40
            with self.assertRaises(TypeError):
                scenario.services[0]["stops"][0]["coordinate"][0] = 50
            traffic = city.scenario(
                "Traffic", traffic={"observations": [{"delayFactor": 2}]}
            )
            with self.assertRaises(TypeError):
                traffic.traffic["observations"][0]["delayFactor"] = 3
            result = scenario.reach([0, 0], service_date="2026-09-04", raster_size=48)
            self.assertEqual(
                result.query["scenario"]["services"][0]["stops"][0]["coordinate"],
                [0, 0],
            )

    def test_job_admission_stays_bounded_across_queued_cancellation(self) -> None:
        entered, release = threading.Event(), threading.Event()
        with ThreadPoolExecutor(max_workers=1) as executor, patch.object(
            model, "_EXECUTOR", executor
        ), patch.object(model, "_JOB_SLOTS", threading.BoundedSemaphore(2)):
            def blocking():
                entered.set()
                release.wait(timeout=5)
                return 1
            first = model._submit_job(blocking)
            try:
                self.assertTrue(entered.wait(timeout=2))
                second = model._submit_job(lambda: self.fail("Canceled work ran"))
                self.assertTrue(second.cancel())
                for _ in range(20):
                    with self.assertRaisesRegex(vigo.VigoError, "capacity"):
                        model._submit_job(lambda: None)
            finally:
                release.set()
            self.assertEqual(first.wait(timeout=2), 1)
            executor.submit(lambda: None).result(timeout=2)
            self.assertEqual(model._submit_job(lambda: 3).wait(timeout=2), 3)
            executor.submit(lambda: None).result(timeout=2)

    def test_job_failure_and_executor_rejection_release_capacity(self) -> None:
        slots = threading.BoundedSemaphore(1)
        with ThreadPoolExecutor(max_workers=1) as executor, patch.object(model, "_EXECUTOR", executor), patch.object(model, "_JOB_SLOTS", slots):
            def fail():
                raise ValueError("expected failure")
            with self.assertRaisesRegex(ValueError, "expected failure"):
                model._submit_job(fail).wait(timeout=2)
            executor.submit(lambda: None).result(timeout=2)
            self.assertEqual(model._submit_job(lambda: 7).wait(timeout=2), 7)
            executor.submit(lambda: None).result(timeout=2)
        with patch.object(model, "_EXECUTOR", executor), patch.object(model, "_JOB_SLOTS", slots):
            with self.assertRaises(RuntimeError):
                model._submit_job(lambda: None)
            self.assertTrue(slots.acquire(blocking=False))
            slots.release()

    def test_oversized_request_does_not_poison_stream(self) -> None:
        with vigo.open(self.city_path, runtime=self.command) as city, city._stream("2026-09-04") as stream:
            with patch.object(model, "_MAX_REQUEST_BYTES", 1024), self.assertRaisesRegex(vigo.VigoError, "request exceeds"):
                stream.query({"kind": "route", "padding": "x" * 2048})
            # The same process is reusable after a rejected request.
            process = stream._process
            result = stream.query({"kind": "route", "origin": "A", "destination": "B"})
            self.assertEqual(result["status"], "ready")
            self.assertIs(stream._process, process)

    def test_pipe_backpressure_is_timed_out_and_all_threads_exit(self) -> None:
        self.cli.write_text(FAKE_VIGO.replace(
            'elif command == "stream":',
            'elif command == "stream":\n    import time\n    time.sleep(30)',
        ), encoding="utf-8")
        with vigo.open(self.city_path, runtime=self.command, timeout=0.1) as city, city._stream("2026-09-04") as stream:
            watchdog = threading.Timer(3, stream._process.kill)
            watchdog.start()
            started = time.monotonic()
            try:
                with self.assertRaises(vigo.VigoTimeoutError):
                    stream.query({"kind": "route", "padding": "x" * (2 * 1024 * 1024)})
            finally:
                watchdog.cancel()
            self.assertLess(time.monotonic() - started, 2)
            self.assertIsNotNone(stream._process.poll())
            for thread in (stream._writer, stream._reader, stream._error_reader):
                self.assertFalse(thread.is_alive())
            self.assertTrue(stream._responses.empty())
            self.assertTrue(stream._writes.empty())

    def test_oversized_response_stops_worker_and_releases_buffers(self) -> None:
        self.cli.write_text(FAKE_VIGO.replace(
            'elif command == "stream":',
            'elif command == "stream":\n    print("x" * 8192, flush=True)',
        ), encoding="utf-8")
        with vigo.open(self.city_path, runtime=self.command) as city, patch.object(
            model, "_MAX_RESPONSE_BYTES", 4096
        ), city._stream("2026-09-04") as stream:
            with self.assertRaisesRegex(vigo.VigoError, "response exceeds"):
                stream.query({"kind": "route"})
            self.assertIsNotNone(stream._process.poll())
            self.assertFalse(stream._reader.is_alive())
            self.assertTrue(stream._responses.empty())

    def test_idle_reader_does_not_retain_consumed_result(self) -> None:
        references = []
        class Response(dict):
            pass
        def decode(line):
            response = Response(json.loads(line))
            references.append(weakref.ref(response))
            return response
        with vigo.open(self.city_path, runtime=self.command) as city, patch.object(model, "loads", decode):
            result = city.route("A", "B", depart_at="08:00", service_date="2026-09-04")
            self.assertEqual(result.status, "ready")
            deadline = time.monotonic() + 2
            while references[0]() is not None and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertIsNone(references[0](), "Idle reader retained the consumed response")

    def test_route_stream_recovers_and_closes_all_pipes(self) -> None:
        city = vigo.open(self.city_path, runtime=self.command)
        options = {"depart_at": "08:00", "service_date": "2026-09-04"}
        city.route("A", "B", **options)
        old = city._streams["2026-09-04"]
        old._process.kill()
        old._process.wait()
        result = city.route("A", "B", **options)
        current = city._streams["2026-09-04"]
        self.assertEqual(result.status, "ready")
        self.assertIsNot(current, old)
        city.close()
        for stream in (old, current):
            self.assertIsNotNone(stream._process.poll())
            self.assertTrue(stream._process.stdin.closed)
            self.assertTrue(stream._process.stdout.closed)
            self.assertTrue(stream._process.stderr.closed)
            self.assertFalse(stream._reader.is_alive())
            self.assertFalse(stream._error_reader.is_alive())

    def test_discarded_city_releases_resident_process(self) -> None:
        city = vigo.open(self.city_path, runtime=self.command)
        city.route("A", "B", depart_at="08:00", service_date="2026-09-04")
        process = city._streams["2026-09-04"]._process
        del city
        gc.collect()
        self.assertIsNotNone(process.poll())

    def test_date_pool_reuses_recent_dates_and_closes_evicted_processes(self) -> None:
        with vigo.open(self.city_path, runtime=self.command) as city:
            city._stream_limit = 2

            def route(date):
                return city.route("A", "B", depart_at="08:00", service_date=date)

            route("2026-09-04")
            first = city._streams["2026-09-04"]
            route("2026-09-05")
            second = city._streams["2026-09-05"]
            route("2026-09-04")
            self.assertIs(city._streams["2026-09-04"], first)
            for day in range(6, 12):
                self.assertEqual(route(f"2026-09-{day:02d}").status, "ready")
                self.assertLessEqual(len(city._streams), 2)
            self.assertFalse(first.alive)
            self.assertFalse(second.alive)
            for stream in (first, second):
                self.assertTrue(stream._process.stdin.closed)
                self.assertTrue(stream._process.stdout.closed)
                self.assertTrue(stream._process.stderr.closed)

    def test_busy_date_pool_times_out_without_evicting_active_query(self) -> None:
        with (
            vigo.open(self.city_path, runtime=self.command) as city,
            ThreadPoolExecutor(max_workers=1) as executor,
        ):
            city._stream_limit = 1
            city.timeout = 0.1
            with city._stream("2026-09-04") as active:
                future = executor.submit(
                    city.route, "A", "B", depart_at="08:00", service_date="2026-09-05"
                )
                with self.assertRaisesRegex(
                    vigo.VigoTimeoutError, "available VIGO Query process"
                ):
                    future.result(timeout=5)
                self.assertTrue(active.alive)
                self.assertEqual(list(city._streams), ["2026-09-04"])
            city.timeout = 5
            self.assertEqual(
                city.route(
                    "A", "B", depart_at="08:00", service_date="2026-09-05"
                ).status,
                "ready",
            )
            self.assertFalse(active.alive)

    def test_city_close_waits_for_active_stream_and_query_failure_releases_it(
        self,
    ) -> None:
        city = vigo.open(self.city_path, runtime=self.command)
        entered = threading.Event()

        def close():
            entered.set()
            city.close()

        with ThreadPoolExecutor(max_workers=1) as executor:
            with city._stream("2026-09-04") as active:
                future = executor.submit(close)
                self.assertTrue(entered.wait(timeout=5))
                self.assertFalse(future.done())
                self.assertTrue(active.alive)
            future.result(timeout=5)
            self.assertFalse(active.alive)
        with (
            self.assertRaisesRegex(RuntimeError, "Query failed"),
            city._stream("2026-09-05"),
        ):
            raise RuntimeError("Query failed")
        self.assertFalse(city._stream_users)
        city.close()

    def test_different_dates_can_query_while_another_stream_is_busy(self) -> None:
        with (
            vigo.open(self.city_path, runtime=self.command) as city,
            ThreadPoolExecutor(max_workers=1) as executor,
        ):
            city._stream_limit = 2
            with city._stream("2026-09-04") as active:
                future = executor.submit(
                    city.route, "A", "B", depart_at="08:00", service_date="2026-09-05"
                )
                self.assertEqual(future.result(timeout=5).status, "ready")
                self.assertTrue(active.alive)
                self.assertEqual(len(city._streams), 2)

    def test_after_midnight_query_keeps_its_service_date(self) -> None:
        with vigo.open(self.city_path, runtime=self.command) as city:
            result = city.route("A", "B", depart_at="25:15", service_date="2026-09-04")
        self.assertEqual(result.query["time"], "25:15")
        self.assertEqual(result.query["serviceDate"], "2026-09-04")

    def test_comparison_preserves_unreachable_values_and_grid_identity(self) -> None:
        def result(kind, **payload):
            return vigo.Result(
                kind, {"resultSchemaVersion": 1, "status": "ready", **payload}, "city"
            )

        def reach(values, bounds=(0, 0, 1, 1), width=2, height=2):
            return result(
                "reach",
                surface={
                    "values": values,
                    "bounds": list(bounds),
                    "width": width,
                    "height": height,
                },
            )

        difference = vigo.compare(
            reach([None, 10, 0, None]), reach([20, None, 0, None])
        ).value
        self.assertEqual(difference["comparableCells"], 1)
        self.assertEqual(difference["meanChangeMinutes"], 0)
        self.assertEqual(difference["newlyReachableCells"], 1)
        self.assertEqual(difference["noLongerReachableCells"], 1)
        for other in (
            reach([1, 2, 3, 4], bounds=(1, 1, 2, 2)),
            reach([1, 2, 3, 4], width=1, height=4),
        ):
            with self.assertRaisesRegex(ValueError, "same grid"):
                vigo.compare(reach([1, 2, 3, 4]), other)
        before = result(
            "route",
            status="blocked",
            result={"durationMinutes": None, "transfers": None},
        )
        after = result("route", result={"durationMinutes": 10, "transfers": 1})
        self.assertIsNone(vigo.compare(before, after).value["transferChange"])
        self.assertIsNone(vigo.compare(before, after).value["durationChangeMinutes"])

    def test_studio_runtime_uses_the_packaged_electron_layout(self) -> None:
        from vigo.runtime import _command_environment

        for platform, executable_path, resources_path in (
            ("mac", "Contents/MacOS/VIGO Studio", "Contents/Resources"),
            ("windows", "VIGO Studio.exe", "resources"),
            ("linux", "VIGO Studio", "resources"),
        ):
            with self.subTest(platform=platform):
                app = self.root.resolve() / platform / "VIGO Studio.app"
                executable = app / executable_path
                program = app / resources_path / "app" / "public" / "vigo.mjs"
                kernel = program.parent.parent / "server" / "vigo-routing-kernel.node"
                for artifact in (executable, program, kernel):
                    artifact.parent.mkdir(parents=True, exist_ok=True)
                    artifact.touch()
                for selected in (app, executable):
                    runtime = vigo.resolve_runtime(selected, verify=False)
                    self.assertEqual(runtime.command, (str(executable), str(program)))
                    environment = _command_environment(runtime.command)
                    self.assertEqual(environment["ELECTRON_RUN_AS_NODE"], "1")
                    self.assertEqual(Path(environment["VIGO_NATIVE_ROUTING_KERNEL"]), kernel)
                kernel.unlink()
                for selected in (app, executable):
                    with self.assertRaises(vigo.VigoError):
                        vigo.resolve_runtime(selected, verify=False)


if __name__ == "__main__":
    unittest.main()
