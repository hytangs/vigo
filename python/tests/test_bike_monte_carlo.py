from __future__ import annotations

import copy
import csv
from dataclasses import replace
from types import MappingProxyType

import pytest

import vigo
from vigo.model import City, Result
from vigo.runtime import RuntimeInfo

WINDOW = {"startMinutes": 480, "endMinutes": 483, "draws": 6, "seed": 42, "percentiles": [0, 50, 100]}


@pytest.fixture
def city(tmp_path):
    capabilities = {"queries": [
        {"id": kind, "resident": True, "bike": {"profiles": ["fast", "balanced", "quiet"]},
         "monteCarlo": {"schema": "vigo.distribution.v1"}, "journeys": True,
         "modes": {"available": ["transit", "walk", "drive", "bike"]},
         "time": {"available": ["depart_at", "arrive_by"]}}
        for kind in ("route", "matrix", "reach")
    ]}
    runtime = RuntimeInfo("1.0.0-rc.4", "1.0", "test", "unused", (), capabilities)
    with City(tmp_path, runtime, {"revisionId": "fixture"}) as value:
        yield value


@pytest.mark.parametrize("query", [vigo.Route("A", "B"), vigo.Matrix(["A"], ["B"]), vigo.Reach("A")])
def test_features_require_explicit_capabilities(city, query):
    assert city.supports(replace(query, mode="bike")).supported
    assert city.supports(replace(query, monte_carlo=WINDOW)).supported
    for entry in city.runtime.capabilities["queries"]:
        entry.pop("bike")
        entry.pop("monteCarlo")
    for requested in (replace(query, mode="bike"), replace(query, monte_carlo=WINDOW)):
        assert not city.supports(requested).supported
        with pytest.raises(vigo.UnsupportedQuery):
            city.run(requested)
    assert not city._streams


@pytest.mark.parametrize("bike", [[], {"speed_kph": 16}, {"profile": "racing"}, {"profile": []}, {"speedKph": True},
                                 {"speedKph": float("nan")}, {"speedKph": 41}, {"maxLts": 0}, {"maxLts": 1.5}])
def test_invalid_bike_options(city, bike):
    with pytest.raises(vigo.InvalidQuery):
        city.supports(vigo.Route("A", "B", mode="bike", bike=bike))


def test_bike_options_do_not_apply_to_transit(city):
    with pytest.raises(vigo.InvalidQuery):
        city.supports(vigo.Route("A", "B", bike={}))
    assert not city.supports(vigo.Reach("A", mode="bike", include_street_edges=True)).supported


def test_bike_build_fails_before_writing_with_an_older_runtime(city, tmp_path):
    gtfs, osm = tmp_path / "feed.zip", tmp_path / "streets.osm.pbf"
    gtfs.touch()
    osm.touch()
    destination = tmp_path / "built"
    with pytest.raises(vigo.VigoError, match="Bike Cities"):
        vigo.build(destination, gtfs=gtfs, osm=osm, street_modes="walk,bike", runtime=city.runtime)
    assert not destination.exists()


@pytest.mark.parametrize("options", [{}, {"startMinutes": True}, {"endMinutes": 480}, {"endMinutes": 1441},
                                     {"draws": 0}, {"draws": 10001}, {"seed": -1}, {"seed": 2**32},
                                     {"percentiles": []}, {"percentiles": [50, 50]}, {"percentiles": [100, 0]},
                                     {"percentiles": [True]}, {"percentiles": [101]}, {"percentiles": "50"},
                                     {"accessibility": []}, {"unknown": 1}])
def test_invalid_windows(city, options):
    window = {**WINDOW, **options} if options else {}
    with pytest.raises(vigo.InvalidQuery):
        city.supports(vigo.Route("A", "B", monte_carlo=window))
    assert not city._streams


@pytest.mark.parametrize("query", [
    vigo.Route("A", "B", mode="bike"), vigo.Route("A", "B", depart_at="08:00"),
    vigo.Route("A", "B", arrive_by="09:00"), vigo.Route("A", "B", waypoints=["C"]),
    vigo.Route("A", "B", alternatives=1), vigo.Route("A", "B", departure_window_minutes=10),
    vigo.Route("A", "B", flex={}), vigo.Matrix(["A"], ["B"], include_journeys=True),
    vigo.Matrix(["A"], ["B"], max_distance_km=5), vigo.Reach("A", include_street_edges=True),
])
def test_unsupported_simulation_combinations_fail_before_stream(city, query):
    with pytest.raises(vigo.UnsupportedQuery):
        city.run(replace(query, monte_carlo=WINDOW))
    assert not city._streams


def test_window_requires_date_and_scheduled_state(city):
    query = vigo.Route("A", "B", monte_carlo=WINDOW)
    with pytest.raises(vigo.InvalidQuery, match="service_date"):
        city.run(query)
    assert not city.scenario("live", live={}).supports(query).supported
    assert not city.scenario("traffic", traffic={}).supports(query).supported
    assert city.scenario("planned", without_routes=["R1"]).supports(query).supported
    assert not city._streams


def distribution(kind="matrix", durations=None):
    payload = {"schema": "vigo.distribution.v1", "kind": kind, "status": "ok", "percentiles": [50, 95],
               "durationsSeconds": durations or [[0, None], [60, None]], "reachableSamples": [6, 0],
               "layout": {"rows": 1, "columns": 2, "origins": [{"id": "a"}], "destinations": [{"id": "b"}, {"id": "c"}]},
               "sampling": {"sampleCount": 6, "method": "frequency-phase-v1", "quantileMethod": "nearest-rank", "unreachable": "positive-infinity"},
               "query": {"monteCarlo": WINDOW}, "accessibility": {"layers": [{"id": "jobs"}]}}
    return Result(kind, MappingProxyType(copy.deepcopy(payload)), "fixture")


def test_distribution_copy_semantics_units_exports_and_comparison(tmp_path):
    result = distribution()
    assert result.status == "ready" and result.is_distribution
    assert result.duration_minutes is None
    snapshot = result.to_dict()
    for value in (result.value, result.distribution):
        value["durationsSeconds"][0][0] = -1
    result.sampling["sampleCount"] = -1
    result.accessibility["layers"].clear()
    row = next(result.iter_rows())
    assert row["durationSeconds"] == 0
    row["durationSeconds"] = -1
    assert result.to_dict() == snapshot
    assert result.rows[1]["durationSeconds"] is None
    output = result.export(tmp_path / "distribution.csv")
    with output.open(newline="") as stream:
        rows = list(csv.DictReader(stream))
    assert len(rows) == 4
    assert rows[0]["durationSeconds"] == "0" and rows[1]["durationSeconds"] == ""
    after = distribution(durations=[[60, 120], [0, None]])
    changes = result.compare(after).value["percentiles"]
    assert changes[0]["meanChangeMinutes"] == 1
    assert changes[0]["newlyReachableCells"] == 1
    assert changes[1]["meanChangeMinutes"] == -1
    with pytest.raises(TypeError, match="geometry"):
        result.to_geojson()
    with pytest.raises(TypeError, match="distributions"):
        list(result.iter_journeys())
    mismatched = distribution()
    mismatched._payload["layout"]["destinations"].reverse()
    with pytest.raises(ValueError, match="layout"):
        result.compare(mismatched)
    ordinary = Result("matrix", {"resultSchemaVersion": 1, "status": "ready", "rows": []}, "fixture")
    with pytest.raises(ValueError, match="single-time"):
        result.compare(ordinary)
