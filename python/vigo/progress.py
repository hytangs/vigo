"""Optional build progress; imported only when the caller requests it."""
from __future__ import annotations

import os
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Mapping, Sequence


class _Lines:
    """Plain-text progress when tqdm is absent: each new stage, with elapsed
    time, and a reminder during long stages so a quiet build never looks hung."""

    def __init__(self, *, desc: str, **_: object) -> None:
        self._started = time.monotonic()
        self._last = 0.0
        self.set_description_str(desc)

    def __enter__(self) -> _Lines:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def _elapsed(self) -> str:
        seconds = int(time.monotonic() - self._started)
        return f"{seconds // 60:d}:{seconds % 60:02d}"

    def _say(self, text: str) -> None:
        line = f"[{self._elapsed()}] {text}"
        try:
            print(line, file=sys.stderr, flush=True)
        except UnicodeEncodeError:
            # Redirected Windows streams often use a legacy code page.
            encoding = getattr(sys.stderr, "encoding", None) or "ascii"
            print(line.encode(encoding, "replace").decode(encoding), file=sys.stderr, flush=True)
        self._last = time.monotonic()

    def set_description_str(self, text: str) -> None:
        self._say(text)

    def refresh(self) -> None:
        if time.monotonic() - self._last >= 60:
            self._say("still building...")


def run_with_progress(
    command: Sequence[str], *, timeout: float, environment: Mapping[str, str]
) -> subprocess.CompletedProcess[str]:
    try:
        from tqdm.auto import tqdm  # type: ignore[import-untyped]
    except ImportError:
        tqdm = _Lines

    events: queue.Queue[str | None] = queue.Queue()
    stderr: list[str] = []
    with tqdm(total=None, desc="Building City", bar_format="{desc} | elapsed {elapsed}",
              dynamic_ncols=True) as display, tempfile.TemporaryFile(
        mode="w+t", encoding="utf-8"
    ) as output:
        process = subprocess.Popen(
            list(command), stdout=output, stderr=subprocess.PIPE, text=True,
            encoding="utf-8", env=environment,
            start_new_session=os.name != "nt",
            creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
        )
        assert process.stderr is not None
        error_stream = process.stderr

        def read_events() -> None:
            try:
                for line in error_stream:
                    events.put(line)
            finally:
                events.put(None)

        reader = threading.Thread(target=read_events, name="vigo-build-progress", daemon=True)
        reader.start()
        deadline = time.monotonic() + timeout
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(command, timeout)
                try:
                    event = events.get(timeout=min(0.2, remaining))
                except queue.Empty:
                    display.refresh()
                    continue
                if event is None:
                    break
                stderr.append(event)
                if event.startswith(("[gtfs]", "[osm]", "[transfers]", "[city]")):
                    display.set_description_str(event.strip()[:180])
            process.wait(timeout=max(0, deadline - time.monotonic()))
            display.set_description_str("City built" if process.returncode == 0 else "City build failed")
            output.seek(0)
            return subprocess.CompletedProcess(list(command), process.returncode, output.read(), "".join(stderr))
        except BaseException:
            display.set_description_str("City build stopped")
            # The CLI owns compiler children. Stop the build group before closing
            # its pipes so cancellation cannot leave an importer running.
            if sys.platform == "win32":
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            else:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if process.poll() is None:
                process.kill()
            process.wait()
            raise
        finally:
            reader.join()
            error_stream.close()
