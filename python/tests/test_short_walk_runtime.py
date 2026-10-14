"""Short-coordinate routing against the public miniature City fixture."""
import os
import tempfile
import unittest
from pathlib import Path

import vigo


@unittest.skipUnless(os.environ.get("VIGO_TEST_INPUTS"), "set VIGO_TEST_INPUTS for runtime tests")
class ShortWalkRuntimeTest(unittest.TestCase):
    def test_default_walk_and_explicit_boarding(self):
        inputs = Path(os.environ["VIGO_TEST_INPUTS"])
        with (
            tempfile.TemporaryDirectory(prefix="vigo-short-walk-") as temporary,
            vigo.build(Path(temporary) / "city", gtfs=inputs / "fixture.zip",
                       osm=inputs / "fixture.osm.pbf") as city,
        ):
            origin, destination = [-77.05, 38.9], [-77.04998, 38.90001]
            for direction in ("depart_at", "arrive_by"):
                options = {direction: "08:30", "service_date": "2026-07-15", "max_walk_km": 0.2}
                route = city.route(origin, destination, **options)
                walk = city.route(origin, destination, mode="walk", **options)
                self.assertEqual(route.status, "ready")
                self.assertEqual(route.value["travelMode"], "walk")
                self.assertLess(route.duration_minutes, 1)
                self.assertAlmostEqual(route.duration_minutes, walk.duration_minutes, delta=0.001)
                self.assertFalse(any(leg["type"] == "ride" for leg in route.legs))
                matrix = city.matrix([origin], [destination], include_journeys=True, **options)
                self.assertAlmostEqual(matrix.rows[0]["durationMinutes"], route.duration_minutes, delta=0.001)
                self.assertEqual(matrix.rows[0]["journey"]["legs"][0]["type"], "walk")
                detailed = city.matrix([origin, origin], [destination, destination],
                                       include_journeys=True, include_geometry=True, **options)
                rows = detailed.rows
                self.assertEqual(len(rows), 4)
                for row in rows:
                    leg = row["journey"]["legs"][0]
                    self.assertEqual(leg["coordinates"], rows[0]["journey"]["legs"][0]["coordinates"])
                    self.assertEqual(leg["fromName"], f"Origin {row['originId']}")
                    self.assertEqual(leg["toName"], f"Destination {row['destinationId']}")
                    self.assertAlmostEqual(row["durationMinutes"], route.duration_minutes, delta=0.001)
                self.assertTrue(rows[0]["journey"]["legs"][0]["coordinates"])
                rows[0]["journey"]["legs"][0]["coordinates"][0][0] = 99
                self.assertNotEqual(rows[1]["journey"]["legs"][0]["coordinates"][0][0], 99)
                transit = city.route(origin, destination, require_transit_ride=True, **options)
                if transit.status == "ready":
                    self.assertTrue(any(leg["type"] == "ride" for leg in transit.legs))
