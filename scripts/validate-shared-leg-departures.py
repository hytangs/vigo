#!/usr/bin/env python3
"""Check a prepared City's shared segment against its source GTFS, without modifying inputs.

Requires a single-feed City and explicit stop IDs on one shared segment. The independent CSV oracle
checks calendars, ordered calls, pickup/drop-off flags and exact departure seconds.
Source feeds and machine-specific results remain outside version control.
"""
import argparse
import collections
import csv
import datetime as dt
import hashlib
import io
import json
import pathlib
import statistics
import subprocess
import tempfile
import time
import zipfile


def seconds(clock):
    h, m, s = map(int, clock.split(":"))
    return h * 3600 + m * 60 + s


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["gtfs", "city", "origin", "destination", "date", "output"]:
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--time", default="08:00")
    parser.add_argument("--routes", required=True, help="Comma-separated source route IDs expected on this segment")
    parser.add_argument("--samples", type=int, default=50)
    parser.add_argument("--binary", default="native/vigo-routing-kernel/target/release/vigo")
    parser.add_argument("--node", default="node")
    args = parser.parse_args()
    if args.samples < 1:
        parser.error("--samples must be positive")
    expected_routes = set(args.routes.split(","))
    with zipfile.ZipFile(args.gtfs) as archive:
        def rows(table):
            name = table + ".txt"
            if name not in archive.namelist():
                return []
            return list(csv.DictReader(io.TextIOWrapper(archive.open(name), encoding="utf-8-sig")))
        trips = {r["trip_id"]: r for r in rows("trips")}
        calendar, exceptions = rows("calendar"), rows("calendar_dates")
        calls = collections.defaultdict(list)
        for row in rows("stop_times"):
            calls[row["trip_id"]].append(row)
        for trip_calls in calls.values():
            trip_calls.sort(key=lambda r: int(r["stop_sequence"]))
    query = {"kind": "route", "origin": {"stopId": args.origin},
             "destination": {"stopId": args.destination}, "time": args.time,
             "serviceDate": args.date, "maxWalkKm": 0, "requireTransitRide": True,
             "sharedLegs": True}
    source_hash = hashlib.sha256(pathlib.Path(args.gtfs).read_bytes()).hexdigest()
    manifest = json.loads((pathlib.Path(args.city) / "network.json").read_text())
    assert source_hash in [s.get("sha256") for s in manifest["sources"]["gtfs"]], "City does not contain this source GTFS"
    children, handles = [], []

    def resident(command):
        errors = tempfile.TemporaryFile(mode="w+")
        handles.append(errors)
        child = subprocess.Popen(command + ["stream", "--city", args.city], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=errors, text=True)
        children.append(child)
        def run(request):
            started = time.perf_counter()
            child.stdin.write(json.dumps(request) + "\n")
            child.stdin.flush()
            line = child.stdout.readline()
            assert line, "Stream ended before a response"
            result = json.loads(line)
            assert result.get("status") == "ok", result
            return result, (time.perf_counter() - started) * 1000
        return run

    try:
        native = resident([str(pathlib.Path(args.binary).resolve())])
        node = resident([args.node, "public/vigo.mjs"])
        primary, cold_ms = native(query)
        journey = primary["journey"]
        rides = [(i, leg) for i, leg in enumerate(journey["legs"]) if leg["type"] == "transit"]
        assert len(rides) == 1, "Choose endpoints on one shared segment"
        index, ride = rides[0]
        primary_trip = ride["trip"]["id"]
        source_calls = calls[primary_trip]
        first = next(i for i, r in enumerate(source_calls) if r["stop_id"] == args.origin)
        last = next(i for i, r in enumerate(source_calls) if i > first and r["stop_id"] == args.destination)
        def pattern(span):
            return [(r["stop_id"], r.get("pickup_type") or "0", r.get("drop_off_type") or "0") for r in span]
        selected_pattern = pattern(source_calls[first:last + 1])
        bundle = journey["sharedLegAlternatives"]
        frequency = next(f for f in bundle["frequencies"] if f["legIndex"] == index)
        assert frequency["status"] == "complete"
        start, end = frequency["windowStartSeconds"], frequency["windowEndSeconds"]
        assert start == seconds(ride["departureTime"]), "The observation window must retain exact timetable seconds"
        date = dt.date.fromisoformat(journey["clockDate"])
        departures = []
        for offset in [-1, 0, 1]:
            service_date = date + dt.timedelta(days=offset)
            compact = service_date.strftime("%Y%m%d")
            weekday = service_date.strftime("%A").lower()
            active = {r["service_id"] for r in calendar if r[weekday] == "1" and r["start_date"] <= compact <= r["end_date"]}
            for r in exceptions:
                if r["date"] == compact:
                    if r["exception_type"] == "1":
                        active.add(r["service_id"])
                    else:
                        active.discard(r["service_id"])
            for trip_id, trip in trips.items():
                if trip["service_id"] not in active:
                    continue
                for i, call in enumerate(calls[trip_id]):
                    if call["stop_id"] != args.origin:
                        continue
                    span = calls[trip_id][i:i + len(selected_pattern)]
                    if pattern(span) != selected_pattern:
                        continue
                    departure = seconds(call["departure_time"]) + offset * 86400
                    if start <= departure < end:
                        assert trip["route_id"] in expected_routes, "Unexpected same-pattern route; inspect its source path before extending this check"
                        departures.append({"trip": trip_id, "route": trip["route_id"], "departure": departure,
                                           "arrival": seconds(span[-1]["arrival_time"]) + offset * 86400})
        times = sorted({d["departure"] for d in departures})
        assert {d["route"] for d in departures} == expected_routes
        assert frequency["departureCount"] == len(departures)
        assert frequency["departureSeconds"] == times
        assert frequency["uniqueDepartureCount"] == len(times)
        gaps = [b - a for a, b in zip(times, times[1:])]
        for key, expected in [("meanHeadwaySeconds", statistics.mean(gaps) if gaps else None),
                              ("minHeadwaySeconds", min(gaps) if gaps else None),
                              ("maxHeadwaySeconds", max(gaps) if gaps else None),
                              ("departuresPerHour", len(departures) * 3600 / (end - start))]:
            assert frequency[key] == expected, (key, frequency[key], expected)
        def check_ride(actual):
            witnesses = [d for d in departures if d["trip"] == actual["trip"]["id"]
                         and d["departure"] == seconds(actual["departureTime"])]
            assert len(witnesses) == 1, "Replacement must retain its actual active trip and departure"
            assert witnesses[0]["arrival"] == seconds(actual["arrivalTime"])
            assert witnesses[0]["route"] == actual["route"]["id"]["id"]
        check_ride(ride)
        route_ids = {ride["route"]["id"]["id"]}
        for option in bundle["options"]:
            assert option["legIndex"] == index
            alternate = option["journey"]["legs"][index]
            check_ride(alternate)
            route_ids.add(alternate["route"]["id"]["id"])
            assert alternate["from"]["stop"] == ride["from"]["stop"]
            assert alternate["to"]["stop"] == ride["to"]["stop"]
            assert alternate["geometry"] == ride["geometry"], "The Loops corridor must have the same directed shape"
            assert alternate["trip"]["id"] in {d["trip"] for d in departures}
        assert route_ids == expected_routes, (route_ids, expected_routes)
        js, node_cold_ms = node(query)
        assert js["journey"] == journey, "Node and Rust must publish identical journeys, alternatives and frequencies"
        samples = {}
        for name, run in [("rust", native), ("node", node)]:
            baseline_ms, enriched_ms = [], []
            for _ in range(args.samples):
                baseline, elapsed = run({**query, "sharedLegs": False})
                baseline_ms.append(elapsed)
                enriched, elapsed = run(query)
                enriched_ms.append(elapsed)
                assert baseline["journey"]["legs"] == enriched["journey"]["legs"]
                assert enriched["journey"]["sharedLegAlternatives"]["frequencies"] == bundle["frequencies"]
            def timing(values):
                return {"medianMs": statistics.median(values), "p95Ms": sorted(values)[max(0, int(len(values) * .95) - 1)]}
            samples[name] = {"baseline": timing(baseline_ms), "sharedLegs": timing(enriched_ms)}
        report = {"passed": True, "sourceSha256": source_hash, "source": str(pathlib.Path(args.gtfs).resolve()),
                  "city": str(pathlib.Path(args.city).resolve()), "query": query, "recommendedRoute": ride["route"]["id"]["id"],
                  "routes": sorted(route_ids), "frequency": frequency, "sourceDepartures": departures,
                  "coldProcessOpenAndQueryMs": {"rust": cold_ms, "node": node_cold_ms},
                  "warmStreamRoundTrip": samples, "samplesPerSetting": args.samples,
                  "timingScope": "Serial JSON stream round trip, including pipe transport, full geometry and decoding; same City, date and OD; no comparison with other versions.",
                  "journey": journey}
        pathlib.Path(args.output).write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({k: v for k, v in report.items() if k not in ["journey", "sourceDepartures"]}, indent=2))
    finally:
        for child in children:
            child.stdin.close()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.terminate()
                child.wait(timeout=5)
        for handle in handles:
            handle.close()


if __name__ == "__main__":
    main()
