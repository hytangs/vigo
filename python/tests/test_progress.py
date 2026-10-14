from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import vigo
from vigo.runtime import _run, run_json


class ProgressTest(unittest.TestCase):
    def test_default_execution_does_not_require_tqdm(self) -> None:
        with patch.dict(sys.modules, {"tqdm": None, "tqdm.auto": None}):
            result = _run([sys.executable], "-c", "print('ready')")
        self.assertEqual(result.stdout.strip(), "ready")

    def test_requested_progress_explains_missing_dependency_before_starting(self) -> None:
        with patch.dict(sys.modules, {"tqdm": None, "tqdm.auto": None}), \
             patch("vigo.progress.subprocess.Popen") as spawn:
            with self.assertRaisesRegex(vigo.VigoError, "pip install tqdm"):
                _run([sys.executable], "-c", "print('ready')", progress=True)
            spawn.assert_not_called()

    @unittest.skipUnless(importlib.util.find_spec("tqdm"), "install the progress extra")
    def test_live_stages_preserve_large_stdout_and_unicode_errors(self) -> None:
        source = """
import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')
print('[gtfs] Reading stops', file=sys.stderr, flush=True)
print('x' * 200000)
print('[city] Preparing street routing', file=sys.stderr, flush=True)
print('Station 北', file=sys.stderr, flush=True)
"""
        display = io.StringIO()
        with contextlib.redirect_stderr(display):
            result = _run([sys.executable], "-c", source, progress=True)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, 'x' * 200000 + '\n')
        self.assertIn('Station 北', result.stderr)
        for label in ['Reading stops', 'Preparing street routing', 'City built', 'elapsed']:
            self.assertIn(label, display.getvalue())
        self.assertNotIn('100%', display.getvalue())

    @unittest.skipUnless(importlib.util.find_spec("tqdm"), "install the progress extra")
    def test_build_failure_keeps_engine_error(self) -> None:
        runtime = vigo.resolve_runtime([sys.executable], verify=False)
        display = io.StringIO()
        with contextlib.redirect_stderr(display), self.assertRaisesRegex(vigo.VigoError, 'Invalid GTFS'):
            run_json(runtime, ['-c', "import sys; print('Invalid GTFS', file=sys.stderr); sys.exit(3)"], timeout=5, progress=True)
        self.assertIn('City build failed', display.getvalue())
        self.assertNotIn('City built', display.getvalue())

    @unittest.skipUnless(importlib.util.find_spec("tqdm"), "install the progress extra")
    def test_timeout_stops_process_and_closes_display(self) -> None:
        processes = []
        original = subprocess.Popen

        def spawn(*args, **kwargs):
            process = original(*args, **kwargs)
            processes.append(process)
            return process

        display = io.StringIO()
        with contextlib.redirect_stderr(display), patch('vigo.progress.subprocess.Popen', side_effect=spawn), self.assertRaises(vigo.VigoTimeoutError):
            _run([sys.executable], '-c', 'import time; time.sleep(20)', timeout=0.5, progress=True)
        self.assertTrue(processes)
        self.assertTrue(all(p.poll() is not None for p in processes))
        self.assertIn('City build stopped', display.getvalue())

    @unittest.skipUnless(importlib.util.find_spec("tqdm"), "install the progress extra")
    def test_public_build_returns_same_city_with_progress(self) -> None:
        from tests.test_vigo import FAKE_VIGO

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = root / 'runtime.py'
            script.write_text(FAKE_VIGO, encoding='utf-8')
            with contextlib.redirect_stderr(io.StringIO()) as display, vigo.build(
                root / 'city', gtfs=root / 'feed.zip', osm=root / 'city.pbf',
                runtime=[sys.executable, str(script)], progress=True,
            ) as city:
                self.assertEqual(city.name, 'built-city')
                self.assertEqual(city.details, json.loads((city.path / 'network.json').read_text()))
            self.assertIn('City built', display.getvalue())


if __name__ == '__main__':
    unittest.main()
