import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from vigo import City, RuntimeInfo, VigoTimeoutError


class FakeStream:
    def __init__(self, city, date, timeout):
        self._request_date = date
        self.alive = True

    def close(self):
        self.alive = False


class SharedStreamsTest(unittest.TestCase):
    def test_serial_queries_prefer_recent_worker_after_a_batch(self):
        runtime = RuntimeInfo("1.0.0-rc.2", "1.0", "test", "unused", ("unused",),
                              {"output": {"requestServiceDate": True}})
        with tempfile.TemporaryDirectory() as directory, patch("vigo.model._QueryStream", FakeStream):
            city = City(Path(directory), runtime, {})
            city._stream_limit = 2
            with (city._stream("2026-07-15") as first,
                  city._stream("2026-07-15") as second):
                self.assertIsNot(first, second)
            for _ in range(3):
                with city._stream("2026-07-15") as preferred:
                    self.assertIs(preferred, second)
            city.close()

    def test_reuse_bounded_concurrency_failure_and_recovery(self):
        runtime = RuntimeInfo("0.5.1", "1.0", "test", "unused", ("unused",),
                              {"output": {"requestServiceDate": True}})
        with tempfile.TemporaryDirectory() as directory, patch("vigo.model._QueryStream", FakeStream):
            city = City(Path(directory), runtime, {}, timeout=0.01)
            city._stream_limit = 2
            with city._stream("2026-07-15") as first:
                with city._stream("2026-07-18") as second:
                    self.assertIsNot(first, second)
                    with self.assertRaises(VigoTimeoutError), city._stream("2026-07-19"):
                        self.fail("active processes must not be reassigned")
                with city._stream("2026-07-19") as reused:
                    self.assertIs(reused, second)
                    self.assertEqual(reused._request_date, "2026-07-19")
                    self.assertEqual(first._request_date, "2026-07-15")
                second.alive = False
                with city._stream("2026-07-19") as restarted:
                    self.assertIsNot(restarted, second)
                    self.assertTrue(restarted.alive)
            self.assertEqual(len(city._streams), 2)
            city.close()
            self.assertEqual(city._streams, {})
            self.assertFalse(first.alive)
            self.assertFalse(restarted.alive)
