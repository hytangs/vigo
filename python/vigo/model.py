from __future__ import annotations

import copy
import csv
import datetime as dt
import json
import math
import os
import queue
import re
import subprocess
import threading
import time
import weakref
from collections import deque
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType
from typing import Any, TypeGuard, TypeVar, overload

from ._json import copy_json, loads
from ._resources import worker_count as _job_worker_count
from ._tables import write_result_tables
from .runtime import (
    API_VERSION,
    CITY_FORMAT_VERSION,
    RESULT_SCHEMA_VERSION,
    VERSION,
    RuntimeInfo,
    VigoError,
    VigoTimeoutError,
    _command_environment,
    resolve_runtime,
    run_json,
)

Point = str | Sequence[float] | Mapping[str, Any]
PointSet = Point | Mapping[str, Point] | Sequence[Point]
_CityT = TypeVar("_CityT", bound="City")

_SERVICE_DAYS = {
    0: "weekday",
    1: "weekday",
    2: "weekday",
    3: "weekday",
    4: "weekday",
    5: "saturday",
    6: "sunday",
}



_EXECUTOR = ThreadPoolExecutor(
    max_workers=_job_worker_count(), thread_name_prefix="vigo"
)

_MAX_PENDING_JOBS = 32
_JOB_SLOTS = threading.BoundedSemaphore(_MAX_PENDING_JOBS)
_MAX_REQUEST_BYTES = 8 * 1024 * 1024
_MAX_RESPONSE_BYTES = 64 * 1024 * 1024


class InvalidQuery(VigoError, ValueError):
    """A Query is malformed or internally contradictory."""


@dataclass(frozen=True, slots=True)
class Support:
    supported: bool
    reason: str | None = None
    available: tuple[str, ...] = ()


class UnsupportedQuery(VigoError):
    """A valid Query cannot run in the selected VIGO context."""

    def __init__(self, support: Support) -> None:
        self.support = support
        super().__init__(support.reason or "unsupported query")


@dataclass(frozen=True, slots=True)
class Route:
    origin: Point
    destination: Point
    waypoints: Sequence[Point] = ()
    mode: str = "transit"
    depart_at: str | dt.time | dt.datetime | None = None
    arrive_by: str | dt.time | dt.datetime | None = None
    service_date: str | dt.date | None = None
    max_walk_km: float = 1.2
    departure_window_minutes: int = 0
    objective: str = "earliest_arrival"
    max_transfers: int | None = None
    require_transit_ride: bool = False
    horizon_minutes: float = 480
    disable_cache: bool = False
    alternatives: int = 0
    alternative_ranking: str | None = None
    alternative_slack_minutes: float | None = None


@dataclass(frozen=True, slots=True)
class Matrix:
    origins: PointSet
    destinations: PointSet
    mode: str = "transit"
    depart_at: str | dt.time | dt.datetime | None = None
    arrive_by: str | dt.time | dt.datetime | None = None
    service_date: str | dt.date | None = None
    max_walk_km: float = 1.2
    horizon_minutes: float = 480
    walk_speed_kph: float = 4.8
    max_distance_km: float | None = None
    objective: str = "earliest_arrival"
    max_transfers: int | None = None
    include_journeys: bool = False
    include_geometry: bool = False
    require_transit_ride: bool = False
    disable_cache: bool = False


@dataclass(frozen=True, slots=True)
class Reach:
    """Where an origin reaches by ``depart_at``, or where a ``destination``
    is reached from by the ``arrive_by`` deadline."""

    origin: Point | None = None
    depart_at: str | dt.time | dt.datetime | None = None
    service_date: str | dt.date | None = None
    cutoffs_minutes: Sequence[float] = (15, 30, 45, 60)
    max_walk_km: float = 1.2
    walk_speed_kph: float = 4.8
    extent_radius_km: float = 8
    raster_size: int = 96
    mode: str = "transit"
    surface_sampling: str = "street"
    include_street_edges: bool = False
    destination: Point | None = None
    arrive_by: str | dt.time | dt.datetime | None = None


Query = Route | Matrix | Reach


def _immutable(value: Mapping[str, Any]) -> Mapping[str, Any]:
    return MappingProxyType(copy.deepcopy(dict(value)))


def _freeze(value: Any) -> Any:
    if isinstance(value, Mapping):
        return MappingProxyType({key: _freeze(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(_freeze(item) for item in value)
    return copy.deepcopy(value)


def _thaw(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _thaw(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_thaw(item) for item in value]
    return copy.deepcopy(value)


def _date_text(value: str | dt.date | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, dt.datetime):
        value = value.date()
    if isinstance(value, dt.date):
        return value.isoformat()
    try:
        return dt.date.fromisoformat(str(value)).isoformat()
    except ValueError as error:
        raise InvalidQuery("service_date must be YYYY-MM-DD") from error


def _clock(
    value: str | dt.time | dt.datetime | None, service_date: str | dt.date | None
) -> tuple[str, str]:
    selected_date = _date_text(service_date)
    if isinstance(value, dt.datetime):
        selected_date = selected_date or value.date().isoformat()
        clock = value.strftime("%H:%M")
    elif isinstance(value, dt.time):
        clock = value.strftime("%H:%M")
    elif isinstance(value, str):
        match = re.fullmatch(r"([01]?\d|2\d):([0-5]\d)", value)
        if match is None:
            raise InvalidQuery("time must use HH:MM")
        clock = f"{int(match.group(1)):02d}:{match.group(2)}"
    else:
        raise InvalidQuery("a departure or arrival time is required")
    if selected_date is None:
        raise InvalidQuery("service_date is required unless time is a datetime")
    return clock, selected_date


def _service_day(service_date: str) -> str:
    return _SERVICE_DAYS[dt.date.fromisoformat(service_date).weekday()]


def _point_payload(value: Point) -> Any:
    if isinstance(value, str):
        if not value.strip():
            raise InvalidQuery("stop ids cannot be empty")
        return value.strip()
    if isinstance(value, Mapping):
        if not {"stop", "stopId", "coordinate"}.intersection(value):
            raise InvalidQuery("point mappings require stop, stopId, or coordinate")
        return copy.deepcopy(dict(value))
    if (
        isinstance(value, Sequence)
        and not isinstance(value, (str, bytes))
        and len(value) == 2
    ):
        longitude, latitude = float(value[0]), float(value[1])
        if not -180 <= longitude <= 180 or not -90 <= latitude <= 90:
            raise InvalidQuery("coordinates must be [longitude, latitude]")
        return {"coordinate": [longitude, latitude]}
    raise InvalidQuery("points must be stop ids, coordinate pairs, or point mappings")


def _point_rows(values: PointSet, label: str) -> list[dict[str, Any]]:
    point_keys = {"stop", "stopId", "coordinate"}
    if (
        isinstance(values, Mapping)
        and not (point_keys & values.keys())
    ):
        rows = [(str(key), point) for key, point in values.items()]
    elif isinstance(values, (str, Mapping)):
        rows = [(label, values)]
    elif isinstance(values, Sequence):
        if len(values) == 2 and all(isinstance(item, (int, float)) for item in values):
            rows = [(label, values)]
        else:
            rows = [
                (f"{label}_{index + 1}", point) for index, point in enumerate(values)
            ]
    else:
        rows = [(label, values)]
    if not rows:
        raise InvalidQuery(f"{label}s cannot be empty")
    return [{"id": row_id, "point": _point_payload(point)} for row_id, point in rows]


class _QueryStream:
    def __init__(self, city: City, service_date: str, timeout: float) -> None:
        self._timeout = timeout
        self._request_date = service_date
        self._per_request_date = city.runtime.capabilities.get("output", {}).get("requestServiceDate") is True
        self._lock = threading.Lock()
        self._sequence = 0
        self._closed = False
        self._responses: queue.Queue[dict[str, Any] | BaseException] = queue.Queue(maxsize=1)
        self._writes: queue.Queue[bytes | None] = queue.Queue(maxsize=1)
        self._errors: deque[str] = deque(maxlen=40)
        output_options = (
            ["--stream-output=detailed"]
            if "detailed" in city.runtime.capabilities.get("output", {}).get("streamFormats", [])
            else ["--diagnostics=trace"]
        )
        self._process = subprocess.Popen(
            [
                *city.runtime.command,
                "stream",
                *output_options,
                f"--city={city.path}",
                *([] if self._per_request_date else [
                    f"--service-date={service_date}",
                    f"--service-day={_service_day(service_date)}",
                ]),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=_command_environment(city.runtime.command),
        )
        self._reader = threading.Thread(
            target=self._read, name="vigo-query-reader", daemon=True
        )
        self._error_reader = threading.Thread(
            target=self._read_errors, name="vigo-query-errors", daemon=True
        )
        self._writer = threading.Thread(
            target=self._write, name="vigo-query-writer", daemon=True
        )
        self._reader.start()
        self._error_reader.start()
        self._writer.start()

    def _publish(self, value: dict[str, Any] | BaseException) -> bool:
        while not self._closed:
            try:
                self._responses.put(value, timeout=0.05)
                return True
            except queue.Full:
                pass
        return False

    def _write(self) -> None:
        assert self._process.stdin is not None
        while not self._closed:
            message = self._writes.get()
            if message is None or self._closed:
                return
            try:
                self._process.stdin.write(message)
                self._process.stdin.flush()
            except OSError:
                self._publish(VigoError("VIGO query process stopped while receiving a Query"))
                return
            finally:
                # An idle writer must not retain the previous large request.
                del message

    def _read_errors(self) -> None:
        assert self._process.stderr is not None
        while line := self._process.stderr.readline(4096):
            if text := line.decode("utf-8", errors="replace").strip():
                self._errors.append(text)

    def _read(self) -> None:
        assert self._process.stdout is not None
        try:
            while encoded := self._process.stdout.readline(_MAX_RESPONSE_BYTES + 1):
                if len(encoded) > _MAX_RESPONSE_BYTES:
                    self._publish(VigoError("VIGO response exceeds 64 MiB"))
                    return
                try:
                    if loads is json.loads:
                        # The stdlib needs text; release wire bytes before decoding.
                        line = encoded.decode("utf-8")
                        del encoded
                        value = loads(line)
                        del line
                    else:
                        # Accelerated decoders consume UTF-8 bytes directly.
                        value = loads(encoded)
                        del encoded
                    if not isinstance(value, dict):
                        raise TypeError("query stream returned a non-object")
                    if not self._publish(value):
                        return
                    # Do not keep a decoded Result alive in the idle reader.
                    del value
                except (ValueError, TypeError) as error:
                    self._publish(error)
                    return
        finally:
            detail = "\n".join(self._errors)
            self._publish(VigoError(detail or "VIGO query process stopped"))

    @property
    def alive(self) -> bool:
        return not self._closed and self._process.poll() is None

    def query(self, request: Mapping[str, Any]) -> dict[str, Any]:
        with self._lock:
            if not self.alive:
                raise VigoError("VIGO query process is not running")
            self._sequence += 1
            request_id = f"python_{self._sequence}"
            message = {**request, "id": request_id}
            if self._per_request_date:
                message["serviceDate"] = self._request_date
            assert self._process.stdin is not None
            encoded = (json.dumps(message, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
            if len(encoded) > _MAX_REQUEST_BYTES:
                raise VigoError("VIGO request exceeds 8 MiB")
            # The timeout covers both pipe backpressure and computation.
            try:
                self._writes.put_nowait(encoded)
                del encoded
                response = self._responses.get(timeout=self._timeout)
            except queue.Full as error:
                self._stop()
                raise VigoError("VIGO query writer is unavailable") from error
            except queue.Empty as error:
                self._stop()
                raise VigoTimeoutError(
                    f"VIGO Query exceeded {self._timeout:g} seconds"
                ) from error
            if isinstance(response, BaseException):
                self._stop()
                raise response
            if response.get("id") != request_id:
                self._stop()
                raise VigoError("VIGO returned a response for the wrong request")
            if response.get("status") == "error":
                raise VigoError(
                    str(response.get("error", {}).get("message", "Query failed"))
                )
            trace = response.get("trace")
            if not isinstance(trace, dict):
                raise VigoError("VIGO returned no detailed Result")
            return trace

    def close(self) -> None:
        with self._lock:
            self._stop()

    def _stop(self) -> None:
        if self._closed:
            return
        self._closed = True
        # Terminate before closing buffered stdin: close() can flush into a
        # full pipe and deadlock if the child is not reading.
        if self._process.poll() is None:
            self._process.terminate()
        try:
            self._process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            self._process.kill()
            self._process.wait()
        try:
            self._writes.put_nowait(None)
        except queue.Full:
            pass
        self._writer.join(timeout=1)
        self._reader.join(timeout=1)
        self._error_reader.join(timeout=1)
        for pipe in (self._process.stdin, self._process.stdout, self._process.stderr):
            if pipe is not None:
                try:
                    pipe.close()
                except OSError:
                    pass
        # Closed streams may remain in the City's date pool until reused.
        for pending in (self._writes, self._responses):
            while True:
                try:
                    pending.get_nowait()
                except queue.Empty:
                    break



def _close_query_streams(streams: dict[str, _QueryStream]) -> None:
    active = list(streams.values())
    streams.clear()
    for stream in active:
        stream.close()


@dataclass(frozen=True, slots=True)
class Result:
    kind: str
    _payload: Mapping[str, Any] = field(repr=False)
    city_revision_id: str | None
    scenario_name: str | None = None

    def __post_init__(self) -> None:
        if self._payload.get("resultSchemaVersion") != RESULT_SCHEMA_VERSION:
            raise VigoError("VIGO returned an unsupported Result schema")
        if self.status not in {"ready", "blocked"}:
            raise VigoError(f"VIGO returned an invalid Result status: {self.status}")

    @property
    def status(self) -> str:
        return str(self._payload.get("status"))

    @property
    def warnings(self) -> tuple[Any, ...]:
        value = self._payload.get("warnings", ())
        return tuple(copy_json(item) for item in value) if isinstance(value, Sequence) else ()

    @property
    def timing(self) -> dict[str, Any]:
        return copy_json(dict(self._payload.get("timing") or {}))

    @property
    def query(self) -> dict[str, Any]:
        return copy_json(dict(self._payload.get("query") or {}))

    @property
    def value(self) -> Any:
        if self.kind == "route":
            return copy_json(self._payload.get("result"))
        if self.kind == "matrix":
            return copy_json(self._payload.get("rows", []))
        if self.kind == "reach":
            return copy_json(self._payload.get("surface"))
        return copy_json(self._payload.get("change"))

    @property
    def choices(self) -> tuple[dict[str, Any], ...]:
        """Independent journey choices returned by opt-in Route alternatives."""
        return tuple(copy_json(choice) for choice in self._payload.get("choices", ()))

    @property
    def alternative_search(self) -> dict[str, Any]:
        """Coverage, ranking and completion status of alternative search."""
        return copy_json(dict(self._payload.get("alternativeSearch") or {}))

    @property
    def rows(self) -> tuple[dict[str, Any], ...]:
        return tuple(self.iter_rows())

    def iter_rows(self) -> Iterator[dict[str, Any]]:
        """Yield independent rows, copying only the rows the caller consumes.

        The complete Engine response is already resident in this Result.
        Iteration avoids allocating a second complete collection of rows.
        """
        for row in self._payload.get("rows", ()):
            yield copy_json(row)

    def _journey_items(self) -> Iterator[tuple[int, Mapping[str, Any], Mapping[str, Any] | None]]:
        if self.kind == "route":
            journey = self._payload.get("result")
            yield 0, {"status": self.status}, journey if isinstance(journey, Mapping) else None
        elif self.kind == "matrix":
            for index, row in enumerate(self._payload.get("rows", ())):
                journey = row.get("journey")
                yield index, row, journey if isinstance(journey, Mapping) else None
        else:
            raise TypeError("journey and leg tables require a Route or Matrix Result")

    def _journey_identity(self, index: int) -> dict[str, Any]:
        return {"journeyIndex": index, "cityRevisionId": self.city_revision_id,
                "scenario": self.scenario_name, "resultStatus": self.status}

    def iter_journeys(self) -> Iterator[dict[str, Any]]:
        """Yield one summary per Route or Matrix row, including blocked outcomes.

        Excludes legs and geometry. ``hasJourney`` distinguishes a missing
        itinerary from an itinerary with zero legs. Engine field units are
        unchanged; ``journeyIndex`` is local to this Result.
        """
        for record in self._journey_records():
            yield copy_json(record)

    def _journey_records(self) -> Iterator[dict[str, Any]]:
        # Internal export views borrow nested values; public iterators copy them.
        for index, row, journey in self._journey_items():
            summary = {key: value for key, value in (journey or {}).items()
                       if key not in {"legs", "coordinates", "geometry"}}
            summary.update({key: value for key, value in row.items()
                            if key not in {"journey", "legs", "coordinates", "geometry"}})
            summary.update(self._journey_identity(index))
            has_journey = (journey is not None and row.get("status") != "blocked"
                           and journey.get("status") != "blocked")
            summary["hasJourney"] = has_journey
            summary["legCount"] = len(journey.get("legs", ())) if has_journey and journey is not None else None
            yield summary

    def iter_legs(self, *, include_geometry: bool = False) -> Iterator[dict[str, Any]]:
        """Yield independently mutable leg records with journey provenance.

        Matrix requires ``include_journeys=True`` at query time to supply legs.
        Missing itineraries produce no leg records; inspect ``iter_journeys()``
        to retain those outcomes. Geometry is omitted before copying by default.
        """
        for record in self._leg_records(include_geometry=include_geometry):
            yield copy_json(record)

    def _leg_records(self, *, include_geometry: bool = False) -> Iterator[dict[str, Any]]:
        for index, row, journey in self._journey_items():
            if journey is None or row.get("status") == "blocked" or journey.get("status") == "blocked":
                continue
            identity = {key: row[key] for key in
                        ("originId", "destinationId", "originIndex", "destinationIndex") if key in row}
            identity.update(self._journey_identity(index))
            identity["status"] = row.get("status", journey.get("status"))
            for leg_index, leg in enumerate(journey.get("legs", ())):
                record = {key: value for key, value in leg.items()
                          if include_geometry or key not in {"coordinates", "geometry"}}
                record.update(identity)
                record["legIndex"] = leg_index
                yield record

    @property
    def duration_minutes(self) -> float | None:
        route = self._payload.get("result") if self.kind == "route" else None
        value = route.get("durationMinutes") if isinstance(route, Mapping) else None
        return None if value is None else float(value)

    @property
    def legs(self) -> tuple[dict[str, Any], ...]:
        route = self._payload.get("result") if self.kind == "route" else None
        return (
            tuple(copy_json(leg) for leg in route.get("legs", ()))
            if isinstance(route, Mapping)
            else ()
        )

    @property
    def record(self) -> dict[str, Any]:
        return {
            "cityRevisionId": self.city_revision_id,
            "scenario": self.scenario_name,
            "query": self.query,
            "status": self.status,
            "warnings": list(self.warnings),
            "timing": self.timing,
        }

    def to_dict(self) -> dict[str, Any]:
        return copy_json(dict(self._payload))

    def to_json(self, *, indent: int | None = 2) -> str:
        return json.dumps(dict(self._payload), indent=indent, allow_nan=False,
                          separators=(",", ":") if indent is None else None)

    def to_geojson(self) -> dict[str, Any]:
        if self.kind == "reach":
            return copy_json(
                self._payload.get("contours")
                or {"type": "FeatureCollection", "features": []}
            )
        if self.kind == "route":
            features = []
            route = self._payload.get("result") or {}
            for index, leg in enumerate(route.get("legs", ())):
                coordinates = leg.get("coordinates")
                if isinstance(coordinates, list) and len(coordinates) >= 2:
                    features.append(
                        {
                            "type": "Feature",
                            "properties": {"index": index, "type": leg.get("type")},
                            "geometry": {
                                "type": "LineString",
                                "coordinates": copy_json(coordinates),
                            },
                        }
                    )
            return {"type": "FeatureCollection", "features": features}
        raise TypeError("only Route and Reach Results have GeoJSON")

    def export(self, path: str | os.PathLike[str]) -> Path:
        destination = Path(path).expanduser().resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.suffix.lower() == ".json":
            destination.write_text(self.to_json() + "\n", encoding="utf-8")
        elif destination.suffix.lower() == ".geojson":
            destination.write_text(
                json.dumps(self.to_geojson(), indent=2, allow_nan=False) + "\n", encoding="utf-8"
            )
        elif destination.suffix.lower() == ".csv" and self.kind == "matrix":
            rows = self._payload.get("rows", ())
            fields = list(dict.fromkeys(key for row in rows for key in row))
            with destination.open("w", newline="", encoding="utf-8") as stream:
                writer = csv.DictWriter(stream, fieldnames=fields)
                writer.writeheader()
                writer.writerows(rows)
        else:
            raise ValueError("use .json, .geojson, or Matrix .csv")
        return destination

    def export_tables(self, directory: str | os.PathLike[str], *, include_geometry: bool = False) -> Path:
        """Write journey/leg CSVs and provenance with one record at a time.

        Two passes discover optional columns without retaining a second table.
        Nested fields are JSON encoded; absent values remain blank in CSV.
        The original Engine response is already resident in this Result.
        Serialization completes before existing files are replaced. Use a new
        directory per Result when readers need a consistent three-file snapshot.
        """
        if self.kind not in {"route", "matrix"}:
            raise TypeError("journey and leg tables require a Route or Matrix Result")
        return write_result_tables(
            Path(directory).expanduser().resolve(),
            self._journey_records,
            lambda: self._leg_records(include_geometry=include_geometry),
            self.record,
        )

    def compare(self, other: Result) -> Result:
        return compare(self, other)


class Job:
    def __init__(self, future: Future[Any]) -> None:
        self._future = future

    @property
    def status(self) -> str:
        if self._future.cancelled():
            return "cancelled"
        if self._future.running():
            return "running"
        if not self._future.done():
            return "queued"
        return "error" if self._future.exception() else "ready"

    def wait(self, timeout: float | None = None) -> Any:
        return self._future.result(timeout=timeout)

    def cancel(self) -> bool:
        return self._future.cancel()


def _submit_job(operation: Callable[[], Any]) -> Job:
    if not _JOB_SLOTS.acquire(blocking=False):
        raise VigoError("VIGO job capacity reached (32 pending/running jobs); retry after a job finishes")
    future: Future[Any] = Future()

    def run() -> None:
        try:
            if future.set_running_or_notify_cancel():
                try:
                    future.set_result(operation())
                except BaseException as error:  # noqa: BLE001 - Future must carry worker failures, including SystemExit.
                    future.set_exception(error)
        finally:
            # Cancellation keeps its slot until the executor dequeues it,
            # preventing repeated submit/cancel from growing tombstones.
            _JOB_SLOTS.release()

    try:
        _EXECUTOR.submit(run)
    except BaseException:
        _JOB_SLOTS.release()
        raise
    return Job(future)


def _validate_workers(workers: int) -> None:
    if type(workers) is not int or not 1 <= workers <= 4:
        raise ValueError("workers must be an integer from 1 to 4")


def _iter_results(
    queries: Iterable[Query], execute: Callable[[Query], Result], workers: int,
) -> Iterator[Result]:
    if workers == 1:
        for query in queries:
            yield execute(query)
        return
    source = iter(queries)
    pending: deque[Future[Result]] = deque()
    pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="vigo-batch")
    try:
        for _ in range(workers):
            try:
                query = next(source)
            except StopIteration:
                break
            pending.append(pool.submit(execute, query))
        while pending:
            # Observe failures in input order before scheduling more work.
            result = pending.popleft().result()
            yield result
            del result
            try:
                query = next(source)
            except StopIteration:
                continue
            pending.append(pool.submit(execute, query))
    finally:
        for future in pending:
            future.cancel()
        # Running queries retain their normal timeout and finish before return.
        pool.shutdown(wait=True, cancel_futures=True)


class City:
    """One immutable VIGO City revision opened for queries."""

    def __init__(
        self,
        path: Path,
        runtime: RuntimeInfo,
        manifest: Mapping[str, Any],
        *,
        timeout: float = 120.0,
    ) -> None:
        self.path = path
        self.runtime = runtime
        self._manifest = _immutable(manifest)
        self.timeout = float(timeout)
        if not math.isfinite(self.timeout) or self.timeout <= 0:
            raise ValueError("timeout must be finite and positive")
        self._streams: dict[str, _QueryStream] = {}
        self._stream_users: set[str] = set()
        self._stream_limit = _job_worker_count()
        self._closing_streams = False
        self._lock = threading.Condition()
        weakref.finalize(self, _close_query_streams, self._streams)

    @property
    def name(self) -> str:
        return str(self._manifest.get("name") or self.path.name)

    @property
    def revision_id(self) -> str | None:
        value = self._manifest.get("revisionId")
        return None if value is None else str(value)

    @property
    def built_at(self) -> str | None:
        value = self._manifest.get("builtAt")
        return None if value is None else str(value)

    @property
    def sources(self) -> dict[str, Any]:
        value = self._manifest.get("sources") or {}
        return copy.deepcopy(dict(value))

    @property
    def capabilities(self) -> dict[str, Any]:
        return copy.deepcopy(dict(self.runtime.capabilities))

    @property
    def details(self) -> dict[str, Any]:
        return copy.deepcopy(dict(self._manifest))

    def route(self, origin: Point, destination: Point, **options: Any) -> Result:
        return self.run(Route(origin, destination, **options))

    def matrix(
        self, origins: PointSet, destinations: PointSet, **options: Any
    ) -> Result:
        return self.run(Matrix(origins, destinations, **options))

    def reach(self, origin: Point | None = None, **options: Any) -> Result:
        return self.run(Reach(origin, **options))

    @overload
    def run(self, query: Query, *, workers: int = 1) -> Result: ...

    @overload
    def run(self, query: Sequence[Query], *, workers: int = 1) -> list[Result]: ...

    def run(self, query: Query | Sequence[Query], *, workers: int = 1) -> Result | list[Result]:
        _validate_workers(workers)
        if isinstance(query, Sequence) and not isinstance(query, (str, bytes)):
            return list(self.iter_run(query, workers=workers))
        if not isinstance(query, (Route, Matrix, Reach)):
            raise InvalidQuery("query must be Route, Matrix, or Reach")
        return self._execute(query, None)

    def iter_run(self, queries: Iterable[Query], *, workers: int = 1) -> Iterator[Result]:
        """Yield complete Results in input order with bounded query concurrency."""
        _validate_workers(workers)
        return _iter_results(queries, lambda query: self._execute(query, None),
                             min(workers, self._stream_limit))

    def supports(self, query: Query) -> Support:
        return self._support(query, None)

    def _query_capability(self, kind: str) -> Mapping[str, Any]:
        return next(
            (entry for entry in self.runtime.capabilities.get("queries", ())
             if entry.get("id") == kind),
            {},
        )

    def _support(self, query: Query, scenario: Scenario | None) -> Support:
        if not isinstance(query, (Route, Matrix, Reach)):
            raise InvalidQuery("query must be Route, Matrix, or Reach")
        if isinstance(query, Reach):
            if query.mode not in {"transit", "walk"}:
                raise InvalidQuery("Reach mode must be transit or walk")
            if query.surface_sampling not in {"street", "cell-center"}:
                raise InvalidQuery("surface_sampling must be street or cell-center")
            if type(query.include_street_edges) is not bool:
                raise InvalidQuery("include_street_edges must be boolean")
            # Depart-at Reach spreads from an origin; arrive-by Reach gathers
            # toward a destination, as in the Engine's request contract.
            if query.depart_at is not None and query.arrive_by is not None:
                raise InvalidQuery("choose depart_at or arrive_by, not both")
            if query.arrive_by is not None:
                if query.origin is not None:
                    raise InvalidQuery("Arrive-by Reach takes a destination, not an origin")
                if query.destination is None:
                    raise InvalidQuery("Arrive-by Reach requires a destination")
            elif query.destination is not None:
                raise InvalidQuery("Reach with a destination requires arrive_by")
            elif query.origin is None:
                raise InvalidQuery("Reach requires an origin, or a destination with arrive_by")
            capability = self._query_capability("reach")
            modes = capability.get("modes", {}).get("available", ())
            if query.mode == "walk" and "walk" not in modes:
                return Support(False, "walk_reach", ("runtime with walking Reach support",))
            if (
                query.arrive_by is not None
                and "arrive_by" not in capability.get("time", {}).get("available", ())
            ):
                return Support(False, "arrive_by_reach", ("depart_at",))
        if isinstance(query, (Route, Matrix)):
            if type(query.disable_cache) is not bool:
                raise InvalidQuery("disable_cache must be boolean")
            if type(query.require_transit_ride) is not bool:
                raise InvalidQuery("require_transit_ride must be boolean")
            if not _finite(query.horizon_minutes) or not 1 <= query.horizon_minutes <= 2880:
                raise InvalidQuery("horizon_minutes must be finite and between 1 and 2880")
            if query.mode not in {"transit", "walk", "drive"}:
                raise InvalidQuery("mode must be transit, walk, or drive")
            if query.max_transfers is not None and (
                type(query.max_transfers) is not int or not 0 <= query.max_transfers <= 31
            ):
                return Support(False, "max_transfers", ("integers from 0 to 31",))
            if isinstance(query, Route) and query.mode == "transit" and query.waypoints and query.max_transfers is not None:
                return Support(False, "max_transfers_with_waypoints", ("Route without waypoints",))
            if query.objective != "earliest_arrival":
                return Support(False, "objective", ("earliest_arrival",))
            capability = self._query_capability("matrix" if isinstance(query, Matrix) else "route")
            if query.disable_cache and (query.mode != "transit" or not capability.get("transitStreetCacheControl")):
                return Support(False, "disable_cache", ("transit runtime with street cache control",))
            if isinstance(query, Route):
                if type(query.alternatives) is not int or not 0 <= query.alternatives <= 9:
                    raise InvalidQuery("alternatives must be an integer from 0 to 9")
                if query.alternative_ranking not in (None, "pareto", "ranked"):
                    raise InvalidQuery("alternative_ranking must be pareto or ranked")
                if query.alternative_slack_minutes is not None and (
                    not _finite(query.alternative_slack_minutes)
                    or not 0 <= query.alternative_slack_minutes <= 120
                ):
                    raise InvalidQuery("alternative_slack_minutes must be finite and between 0 and 120")
                if not query.alternatives and (
                    query.alternative_ranking is not None or query.alternative_slack_minutes is not None
                ):
                    raise InvalidQuery("alternative settings require alternatives > 0")
                if query.alternatives:
                    if capability.get("alternatives", {}).get("detailedChoices") is not True:
                        return Support(False, "alternatives", ("runtime with canonical detailed Route alternatives",))
                    if query.mode != "transit" or query.arrive_by is not None or query.waypoints or query.departure_window_minutes:
                        return Support(False, "alternatives_combination", ("depart-at transit without waypoints or a window",))
            if isinstance(query, Matrix):
                if not capability.get("resident"):
                    return Support(False, "resident_matrix", ("runtime with resident Matrix support",))
                if type(query.include_journeys) is not bool or type(query.include_geometry) is not bool:
                    return Support(False, "include_journeys", ("boolean",))
                if query.include_geometry and not query.include_journeys:
                    return Support(False, "include_geometry", ("include_journeys=True",))
                if query.include_journeys and (query.mode != "transit" or not capability.get("journeys")):
                    return Support(False, "matrix_journeys", ("transit runtime with journey support",))
            if query.max_transfers is not None and not capability.get("maxTransfers"):
                return Support(False, "max_transfers_runtime", ("runtime with maxTransfers support",))
            if (
                isinstance(query, Matrix) and query.arrive_by is not None
                and "arrive_by" not in capability.get("time", {}).get("available", ())
            ):
                return Support(False, "arrive_by_matrix", ("depart_at",))
        if (
            isinstance(query, Route)
            and query.depart_at is not None
            and query.arrive_by is not None
        ):
            raise InvalidQuery("choose depart_at or arrive_by, not both")
        if (
            isinstance(query, Matrix)
            and query.depart_at is not None
            and query.arrive_by is not None
        ):
            raise InvalidQuery("choose depart_at or arrive_by, not both")
        if scenario is None:
            return Support(True)

        planned = bool(scenario.services or scenario.without_routes)
        live = scenario.live is not None
        traffic = scenario.traffic is not None
        if sum((planned, live, traffic)) > 1:
            return Support(False, "scenario_state_combination")
        if planned:
            if isinstance(query, Reach) and query.mode == "walk":
                return Support(False, "planned_transit_walk_reach", ("transit Reach",))
            return (
                Support(True)
                if isinstance(query, Reach)
                else Support(
                    False,
                    "planned_transit_route"
                    if isinstance(query, Route)
                    else "planned_transit_matrix",
                    ("reach",),
                )
            )
        if live:
            return Support(False, "live_transit_python", ("studio",))
        if traffic:
            if isinstance(query, (Route, Matrix)) and query.mode == "drive":
                kind = "route" if isinstance(query, Route) else "matrix"
                if self._query_capability(kind).get("suppliedTraffic"):
                    return Support(True)
                return Support(False, "runtime_supplied_traffic", ("runtime with supplied traffic support",))
            return Support(False, "traffic_context", ("drive_route", "drive_matrix"))
        return Support(True)

    def submit(self, query: Query | Sequence[Query]) -> Job:
        return _submit_job(lambda: self.run(query))

    def scenario(
        self,
        name: str,
        *,
        services: Sequence[Mapping[str, Any]] = (),
        without_routes: Sequence[str] = (),
        live: Mapping[str, Any] | None = None,
        traffic: Mapping[str, Any] | None = None,
        expires_at: dt.datetime | None = None,
    ) -> Scenario:
        return Scenario(
            self,
            name,
            services=services,
            without_routes=without_routes,
            live=live,
            traffic=traffic,
            expires_at=expires_at,
        )

    @contextmanager
    def _stream(self, service_date: str) -> Iterator[_QueryStream]:
        if self.runtime.capabilities.get("output", {}).get("requestServiceDate") is True:
            with self._shared_stream(service_date) as shared:
                yield shared
            return
        deadline = time.monotonic() + self.timeout
        with self._lock:
            while True:
                if not self._closing_streams and service_date not in self._stream_users:
                    stream = self._streams.get(service_date)
                    if stream is None and len(self._streams) >= self._stream_limit:
                        idle = next(
                            (
                                date
                                for date in self._streams
                                if date not in self._stream_users
                            ),
                            None,
                        )
                        if idle is not None:
                            self._streams.pop(idle).close()
                    if stream is not None or len(self._streams) < self._stream_limit:
                        if stream is None or not stream.alive:
                            if stream is not None:
                                stream.close()
                            stream = _QueryStream(self, service_date, self.timeout)
                        # Dictionary order records use; only idle dates may be evicted.
                        self._streams.pop(service_date, None)
                        self._streams[service_date] = stream
                        self._stream_users.add(service_date)
                        break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise VigoTimeoutError(
                        "Timed out waiting for an available VIGO Query process"
                    )
                self._lock.wait(timeout=remaining)
        try:
            yield stream
        finally:
            with self._lock:
                self._stream_users.remove(service_date)
                self._lock.notify_all()

    @contextmanager
    def _shared_stream(self, service_date: str) -> Iterator[_QueryStream]:
        """Lease an idle Engine process; grow only for overlapping queries."""
        deadline = time.monotonic() + self.timeout
        with self._lock:
            while True:
                if not self._closing_streams:
                    idle = [key for key in self._streams if key not in self._stream_users]
                    # Prefer the most recently used matching worker so serial calls
                    # after a parallel batch retain its prepared modes and caches.
                    key = next((key for key in reversed(idle) if self._streams[key]._request_date == service_date),
                               idle[-1] if idle else None)
                    if key is None and len(self._streams) < self._stream_limit:
                        key = f"resident-{len(self._streams)}"
                    if key is not None:
                        stream = self._streams.get(key)
                        if stream is None or not stream.alive:
                            if stream is not None:
                                stream.close()
                            stream = _QueryStream(self, service_date, self.timeout)
                        stream._request_date = service_date
                        self._streams.pop(key, None)
                        self._streams[key] = stream
                        self._stream_users.add(key)
                        break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise VigoTimeoutError("Timed out waiting for an available VIGO Query process")
                self._lock.wait(timeout=remaining)
        try:
            yield stream
        finally:
            with self._lock:
                self._stream_users.remove(key)
                self._lock.notify_all()

    def _execute(self, query: Query, scenario: Scenario | None) -> Result:
        if scenario is not None:
            scenario._check()
        support = self._support(query, scenario)
        if not support.supported:
            raise UnsupportedQuery(support)
        if isinstance(query, Route):
            return self._route(query, scenario)
        if isinstance(query, Matrix):
            return self._matrix(query, scenario)
        if isinstance(query, Reach):
            return self._reach(query, scenario)
        raise TypeError("query must be Route, Matrix, or Reach")

    def _route(self, query: Route, scenario: Scenario | None) -> Result:
        started = time.perf_counter()
        selected_time = (
            query.arrive_by if query.arrive_by is not None else query.depart_at
        )
        clock, service_date = _clock(selected_time, query.service_date)
        request = {
            "origin": _point_payload(query.origin),
            "destination": _point_payload(query.destination),
            "waypoints": [_point_payload(waypoint) for waypoint in query.waypoints],
            "mode": query.mode,
            "time": clock,
            "timePreference": "arrive" if query.arrive_by is not None else "depart",
            "objective": query.objective,
            "maxWalkKm": query.max_walk_km,
            "requireTransitRide": query.require_transit_ride,
            "horizonMinutes": query.horizon_minutes,
            "disableCache": query.disable_cache,
            **({"maxTransfers": query.max_transfers} if query.max_transfers is not None else {}),
            "departureWindowMinutes": query.departure_window_minutes,
            **({"alternatives": query.alternatives} if query.alternatives else {}),
            **({"alternativeRanking": query.alternative_ranking} if query.alternative_ranking is not None else {}),
            **({"alternativeSlackMinutes": query.alternative_slack_minutes} if query.alternative_slack_minutes is not None else {}),
            **(
                {"traffic": _thaw(scenario.traffic), "routingDataMode": "realtime"}
                if scenario and scenario.traffic is not None
                else {}
            ),
        }
        with self._stream(service_date) as stream:
            payload = stream.query({"kind": "route", **request})
        payload.setdefault("timing", {})["endToEndMs"] = round(
            (time.perf_counter() - started) * 1000, 3
        )
        return Result(
            "route",
            MappingProxyType(payload),
            self.revision_id,
            scenario.name if scenario else None,
        )

    def _matrix(self, query: Matrix, scenario: Scenario | None) -> Result:
        selected_time = query.arrive_by if query.arrive_by is not None else query.depart_at
        clock, service_date = _clock(selected_time or "08:00", query.service_date)
        started = time.perf_counter()
        request = {
            "kind": "matrix",
            "requireTransitRide": query.require_transit_ride,
            "disableCache": query.disable_cache,
            "time": clock,
            "timePreference": "arrive" if query.arrive_by is not None else "depart",
            "maxWalkKm": query.max_walk_km,
            **({"maxTransfers": query.max_transfers} if query.max_transfers is not None else {}),
            "origins": _point_rows(query.origins, "origin"),
            "destinations": _point_rows(query.destinations, "destination"),
            "mode": query.mode,
            "objective": query.objective,
            "horizonMinutes": query.horizon_minutes,
            "includeJourneys": query.include_journeys,
            "includeGeometry": query.include_geometry,
            "walkSpeedKph": query.walk_speed_kph,
            **(
                {"maxDistanceKm": query.max_distance_km}
                if query.max_distance_km is not None
                else {}
            ),
            **(
                {"traffic": _thaw(scenario.traffic), "routingDataMode": "realtime"}
                if scenario and scenario.traffic is not None
                else {}
            ),
        }
        with self._stream(service_date) as stream:
            payload = stream.query(request)
        payload.setdefault("timing", {})["endToEndMs"] = round(
            (time.perf_counter() - started) * 1000, 3
        )
        return Result(
            "matrix",
            MappingProxyType(payload),
            self.revision_id,
            scenario.name if scenario else None,
        )

    def _reach(self, query: Reach, scenario: Scenario | None) -> Result:
        started = time.perf_counter()
        arrive = query.arrive_by is not None
        selected_time = query.arrive_by if arrive else query.depart_at
        clock, service_date = _clock(
            "08:00" if selected_time is None else selected_time, query.service_date
        )
        endpoint = query.destination if arrive else query.origin
        assert endpoint is not None, "_support requires the endpoint for this direction"
        request = {
            "mode": query.mode,
            "surfaceSampling": query.surface_sampling,
            "includeStreetEdges": query.include_street_edges,
            "time": clock,
            "maxWalkKm": query.max_walk_km,
            # One request form for both directions, as in the Engine contract.
            "timePreference": "arrive_by" if arrive else "depart_at",
            "destination" if arrive else "origin": _point_payload(endpoint),
            "cutoffsMinutes": list(query.cutoffs_minutes),
            "extentRadiusKm": query.extent_radius_km,
            "rasterSize": query.raster_size,
            "walkSpeedKph": query.walk_speed_kph,
            **(
                {
                    "scenario": {
                        "id": "scenario",
                        "name": scenario.name,
                        "services": _thaw(scenario.services),
                        "excludedRouteIds": list(scenario.without_routes),
                    }
                }
                if scenario and (scenario.services or scenario.without_routes)
                else {}
            ),
        }
        with self._stream(service_date) as stream:
            payload = stream.query({"kind": "reach", **request})
        payload.setdefault("timing", {})["endToEndMs"] = round(
            (time.perf_counter() - started) * 1000, 3
        )
        return Result(
            "reach",
            MappingProxyType(payload),
            self.revision_id,
            scenario.name if scenario else None,
        )

    def close(self) -> None:
        """Release resident runtime resources held by this City."""
        with self._lock:
            while self._closing_streams:
                self._lock.wait()
            self._closing_streams = True
            try:
                while self._stream_users:
                    self._lock.wait()
                _close_query_streams(self._streams)
            finally:
                self._closing_streams = False
                self._lock.notify_all()

    def __enter__(self: _CityT) -> _CityT:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


@dataclass(frozen=True, slots=True, init=False)
class Scenario:
    """An immutable set of changes tied to exactly one City revision."""

    city: City
    city_revision_id: str | None
    name: str
    services: tuple[Mapping[str, Any], ...]
    without_routes: tuple[str, ...]
    live: Mapping[str, Any] | None
    traffic: Mapping[str, Any] | None
    expires_at: dt.datetime | None

    def __init__(
        self,
        city: City,
        name: str,
        *,
        services: Sequence[Mapping[str, Any]] = (),
        without_routes: Sequence[str] = (),
        live: Mapping[str, Any] | None = None,
        traffic: Mapping[str, Any] | None = None,
        expires_at: dt.datetime | None = None,
    ) -> None:
        if not name.strip():
            raise ValueError("Scenario name cannot be empty")
        if isinstance(services, (str, bytes)) or not isinstance(services, Sequence):
            raise TypeError("services must be a sequence of mappings")
        if any(not isinstance(service, Mapping) for service in services):
            raise TypeError("every service must be a mapping")
        if isinstance(without_routes, (str, bytes)) or not isinstance(
            without_routes, Sequence
        ):
            raise TypeError("without_routes must be a sequence of route ids")
        route_ids = tuple(str(route_id).strip() for route_id in without_routes)
        if any(not route_id for route_id in route_ids):
            raise ValueError("without_routes cannot contain an empty route id")
        for label, value in (("live", live), ("traffic", traffic)):
            if value is not None and not isinstance(value, Mapping):
                raise TypeError(f"{label} must be a mapping")
        if expires_at is not None and not isinstance(expires_at, dt.datetime):
            raise TypeError("expires_at must be a datetime")
        object.__setattr__(self, "city", city)
        object.__setattr__(self, "city_revision_id", city.revision_id)
        object.__setattr__(self, "name", name.strip())
        object.__setattr__(self, "services", _freeze(services))
        object.__setattr__(self, "without_routes", tuple(dict.fromkeys(route_ids)))
        object.__setattr__(self, "live", _freeze(live))
        object.__setattr__(self, "traffic", _freeze(traffic))
        object.__setattr__(self, "expires_at", expires_at)

    def _check(self) -> None:
        if self.city.revision_id != self.city_revision_id:
            raise VigoError("Scenario belongs to a different City revision")
        if self.expires_at is not None:
            now = dt.datetime.now(tz=self.expires_at.tzinfo)
            if now >= self.expires_at:
                raise VigoError(f"Scenario {self.name!r} has expired")

    def route(self, origin: Point, destination: Point, **options: Any) -> Result:
        return self.run(Route(origin, destination, **options))

    def matrix(
        self, origins: PointSet, destinations: PointSet, **options: Any
    ) -> Result:
        return self.run(Matrix(origins, destinations, **options))

    def reach(self, origin: Point | None = None, **options: Any) -> Result:
        return self.run(Reach(origin, **options))

    @overload
    def run(self, query: Query, *, workers: int = 1) -> Result: ...

    @overload
    def run(self, query: Sequence[Query], *, workers: int = 1) -> list[Result]: ...

    def run(self, query: Query | Sequence[Query], *, workers: int = 1) -> Result | list[Result]:
        _validate_workers(workers)
        if isinstance(query, Sequence) and not isinstance(query, (str, bytes)):
            return list(self.iter_run(query, workers=workers))
        if not isinstance(query, (Route, Matrix, Reach)):
            raise InvalidQuery("query must be Route, Matrix, or Reach")
        return self.city._execute(query, self)

    def iter_run(self, queries: Iterable[Query], *, workers: int = 1) -> Iterator[Result]:
        """Yield ordered Results using this Scenario for every query."""
        _validate_workers(workers)
        return _iter_results(queries, lambda query: self.city._execute(query, self),
                             min(workers, self.city._stream_limit))

    def supports(self, query: Query) -> Support:
        return self.city._support(query, self)

    def submit(self, query: Query | Sequence[Query]) -> Job:
        return _submit_job(lambda: self.run(query))


def open(
    city: str | os.PathLike[str],
    *,
    runtime: RuntimeInfo | str | os.PathLike[str] | Sequence[str] | None = None,
    timeout: float = 120.0,
) -> City:
    """Open one complete VIGO City directory."""

    path = Path(city).expanduser().resolve()
    manifest_path = path / "network.json"
    routing = path / "routing" / "project.sqlite"
    streets = path / "osm" / "street-index.sqlite"
    if not manifest_path.is_file() or not routing.is_file() or not streets.is_file():
        raise VigoError(
            "City must contain network.json, routing/project.sqlite, and osm/street-index.sqlite"
        )
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise VigoError("City metadata is unreadable") from error
    if (
        manifest.get("schemaVersion") != "vigo.city.v1"
        or manifest.get("cityFormatVersion") != CITY_FORMAT_VERSION
    ):
        raise VigoError(f"VIGO Python requires City format {CITY_FORMAT_VERSION}")
    return City(path, resolve_runtime(runtime), manifest, timeout=timeout)


def build(
    output: str | os.PathLike[str],
    *,
    gtfs: str | os.PathLike[str] | Sequence[str | os.PathLike[str]],
    osm: str | os.PathLike[str],
    private_access: str = "public",
    street_modes: str = "walk,drive",
    replace: bool = False,
    runtime: RuntimeInfo | str | os.PathLike[str] | Sequence[str] | None = None,
    timeout: float = 1_800.0,
    progress: bool = False,
) -> City:
    """Build one City directly from GTFS and OSM, then open it."""

    output_path = Path(output).expanduser().resolve()
    sources = [gtfs] if isinstance(gtfs, (str, os.PathLike)) else list(gtfs)
    if not sources:
        raise ValueError("at least one GTFS ZIP is required")
    runtime_info = resolve_runtime(runtime)
    if private_access not in {"public", "endpoints"}:
        raise ValueError("private_access must be public or endpoints")
    if street_modes not in {"walk", "walk,drive"}:
        raise ValueError("street_modes must be walk or walk,drive")
    if private_access == "endpoints" and "endpoints" not in runtime_info.capabilities.get("city", {}).get("privateAccess", ()):
        raise VigoError("This runtime does not support authorized private endpoint access.")
    arguments = [
        "build",
        *(f"--gtfs={Path(source).expanduser().resolve()}" for source in sources),
        f"--osm={Path(osm).expanduser().resolve()}",
        f"--street-modes={street_modes}",
        *(["--private-access=endpoints"] if private_access == "endpoints" else []),
        f"--output={output_path}",
        *(["--replace"] if replace else []),
    ]
    run_json(runtime_info, arguments, timeout=timeout, progress=progress)
    return open(output_path, runtime=runtime_info)


def _finite(value: Any) -> TypeGuard[int | float]:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def _comparison_counts(pairs: Any, unit: str) -> dict[str, Any]:
    changes = []
    newly_reachable = 0
    no_longer_reachable = 0
    for left, right in pairs:
        left_ready, right_ready = _finite(left), _finite(right)
        newly_reachable += int(not left_ready and right_ready)
        no_longer_reachable += int(left_ready and not right_ready)
        if left_ready and right_ready:
            changes.append(right - left)
    return {
        f"comparable{unit}": len(changes),
        f"faster{unit}": sum(value < -1e-9 for value in changes),
        f"slower{unit}": sum(value > 1e-9 for value in changes),
        f"unchanged{unit}": sum(abs(value) <= 1e-9 for value in changes),
        f"newlyReachable{unit}": newly_reachable,
        f"noLongerReachable{unit}": no_longer_reachable,
        "meanChangeMinutes": round(sum(changes) / len(changes), 3) if changes else None,
    }


def compare(before: Result, after: Result) -> Result:
    """Compare two compatible Results without rerunning either Query."""

    if not isinstance(before, Result) or not isinstance(after, Result):
        raise TypeError("compare requires two Results")
    if before.kind != after.kind or before.kind not in {"route", "matrix", "reach"}:
        raise ValueError("Results must come from the same Query family")
    if before.kind == "route":
        left = before.value or {}
        right = after.value or {}
        left_duration = (
            left.get("durationMinutes") if before.status == "ready" else None
        )
        right_duration = (
            right.get("durationMinutes") if after.status == "ready" else None
        )
        left_transfers = left.get("transfers") if before.status == "ready" else None
        right_transfers = right.get("transfers") if after.status == "ready" else None
        change = {
            "beforeStatus": before.status,
            "afterStatus": after.status,
            "durationChangeMinutes": (
                round(right_duration - left_duration, 3)
                if _finite(left_duration) and _finite(right_duration)
                else None
            ),
            "transferChange": right_transfers - left_transfers
            if _finite(left_transfers) and _finite(right_transfers)
            else None,
        }
    elif before.kind == "matrix":

        def key(row: Mapping[str, Any]) -> tuple[str, str]:
            origin, destination = row.get("originId"), row.get("destinationId")
            if not isinstance(origin, str) or not isinstance(destination, str):
                raise TypeError("Matrix comparison requires originId and destinationId on every row")
            return origin, destination

        left_rows = {key(row): row for row in before.rows}
        pairs = []
        for row in after.rows:
            previous = left_rows.get(key(row))
            if previous is not None:
                pairs.append(
                    (
                        previous.get("durationMinutes")
                        if previous.get("status") != "blocked"
                        else None,
                        row.get("durationMinutes")
                        if row.get("status") != "blocked"
                        else None,
                    )
                )
        change = _comparison_counts(pairs, "Pairs")
    else:
        left_grid = before.to_dict().get("surface", {})
        right_grid = after.to_dict().get("surface", {})
        left_values, right_values = left_grid.get("values"), right_grid.get("values")
        width, height = left_grid.get("width"), left_grid.get("height")
        bounds = left_grid.get("bounds")
        if (
            not isinstance(left_values, list)
            or not isinstance(right_values, list)
            or type(width) is not int
            or type(height) is not int
            or width <= 0
            or height <= 0
            or len(left_values) != len(right_values)
            or len(left_values) != width * height
            or width != right_grid.get("width")
            or height != right_grid.get("height")
            or not isinstance(bounds, list)
            or len(bounds) != 4
            or not all(map(_finite, bounds))
            or bounds != right_grid.get("bounds")
        ):
            raise ValueError("Reach Results must use the same grid")
        change = _comparison_counts(
            zip(left_values, right_values, strict=True), "Cells"
        )

    payload = {
        "schemaVersion": "vigo.result.comparison.v1",
        "productVersion": VERSION,
        "apiVersion": API_VERSION,
        "resultSchemaVersion": RESULT_SCHEMA_VERSION,
        "kind": "comparison",
        "queryKind": before.kind,
        "status": "ready",
        "cities": {
            "before": before.city_revision_id,
            "after": after.city_revision_id,
        },
        "change": change,
    }
    return Result("comparison", _immutable(payload), before.city_revision_id)
