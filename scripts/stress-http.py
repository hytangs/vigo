#!/usr/bin/env python3
"""Bounded open-loop HTTP load generator for an explicitly selected VIGO server.

Uses only the Python standard library. No production endpoint is selected by
this script. Loopback-only unless --allow-remote is supplied. This measures
transport/load behavior, not route optimality. Server memory must be measured
separately. Every scheduled arrival is counted, including client-side drops.
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import ipaddress
import json
import math
import os
import platform
import re
import threading
import time
from collections import Counter
from concurrent import futures
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

MAX_RESPONSE_BYTES = 64 * 1024 * 1024
MAX_CALLS = 100_000


def quantiles(values: list[float]) -> dict[str, float | int | None]:
    ordered = sorted(values)
    return {"count": len(ordered), **{
        label: ordered[math.ceil(len(ordered) * q) - 1] if ordered else None
        for label, q in (("p50_ms", .5), ("p95_ms", .95), ("p99_ms", .99), ("max_ms", 1.))
    }}


def arguments() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--url", required=True, help="Example: http://127.0.0.1:8080")
    p.add_argument("--requests", required=True, type=Path, help="NDJSON public requests with kind: route/matrix/reach")
    p.add_argument("--output", required=True, type=Path)
    p.add_argument("--rate", type=float, default=10., help="Scheduled requests per second")
    p.add_argument("--duration", type=float, default=30., help="Arrival window in seconds")
    p.add_argument("--max-inflight", type=int, default=32, help="Client bound; overflow is counted, never queued invisibly")
    p.add_argument("--timeout", type=float, default=10., help="Total request budget, including response reads")
    p.add_argument("--slo-ms", type=float, default=250.)
    p.add_argument("--allow-remote", action="store_true", help="Explicitly permit a server outside loopback")
    a = p.parse_args()
    for name in ("rate", "duration", "timeout", "slo_ms"):
        value = getattr(a, name)
        if not math.isfinite(value) or value <= 0:
            p.error(f"{name} must be finite and positive")
    if not 1 <= a.max_inflight <= 256:
        p.error("--max-inflight must be 1..256")
    if math.ceil(a.rate * a.duration) > MAX_CALLS:
        p.error(f"At most {MAX_CALLS} scheduled arrivals per run")
    u = urlsplit(a.url)
    if u.scheme not in {"http", "https"} or not u.hostname or u.username or u.password or u.query or u.fragment or u.path not in {"", "/"}:
        p.error("Use an HTTP(S) origin without credentials, path, query or fragment")
    try:
        loopback = ipaddress.ip_address(u.hostname).is_loopback
    except ValueError:
        loopback = u.hostname == "localhost"
    if not loopback and not a.allow_remote:
        p.error("Remote targets require explicit --allow-remote authorization")
    if a.output.exists():
        p.error("Output already exists; refusing to overwrite")
    return a


def main() -> int:
    a = arguments()
    endpoint = urlsplit(a.url)
    raw = a.requests.read_bytes()
    corpus: list[dict[str, Any]] = [json.loads(line) for line in raw.splitlines() if line.strip()]
    if not corpus or len(corpus) > 10_000:
        raise ValueError("Corpus must contain 1..10,000 requests")
    for item in corpus:
        if not isinstance(item, dict) or item.get("kind") not in {"route", "matrix", "reach"}:
            raise ValueError("Each record must have kind: route, matrix, or reach")
        if len(json.dumps(item).encode()) > 8 * 1024 * 1024 - 1024:
            raise ValueError("Request too large for the public transport")
    token = os.environ.get("VIGO_API_TOKEN", "")
    headers = {"Content-Type": "application/json", "Connection": "close"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    slots = threading.BoundedSemaphore(a.max_inflight)
    records: list[dict[str, Any]] = []
    lock = threading.Lock()
    active = peak = 0
    scheduled = math.ceil(a.rate * a.duration)
    start = time.monotonic()
    connection_type = http.client.HTTPSConnection if endpoint.scheme == "https" else http.client.HTTPConnection

    def one(index: int, arrival: float) -> None:
        nonlocal active, peak
        began = time.monotonic()
        with lock:
            active += 1
            peak = max(peak, active)
        base = corpus[index % len(corpus)]
        body = {**base, "id": f"stress_{index}"}
        result: dict[str, Any] = {"index": index, "corpus_index": index % len(corpus), "kind": base["kind"],
            "scheduled_ms": (arrival - start) * 1000, "dispatch_lag_ms": (began - arrival) * 1000}
        conn = connection_type(endpoint.hostname, endpoint.port, timeout=a.timeout)
        deadline = began + a.timeout
        try:
            encoded = json.dumps(body, separators=(",", ":"), allow_nan=False).encode()
            conn.request("POST", f"/v1/{base['kind']}", body=encoded, headers=headers)
            if conn.sock:
                conn.sock.settimeout(max(.001, deadline - time.monotonic()))
            response = conn.getresponse()
            chunks, total = [], 0
            while True:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise TimeoutError("Total response deadline exceeded")
                # HTTPResponse may own the socket after Connection: close is seen.
                sock = conn.sock or getattr(getattr(response.fp, "raw", None), "_sock", None)
                if sock is not None:
                    sock.settimeout(left)
                chunk = response.read1(min(65536, MAX_RESPONSE_BYTES + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > MAX_RESPONSE_BYTES:
                    raise ValueError("Response exceeds 64 MiB client limit")
            payload = b"".join(chunks)
            result.update(http_status=response.status, response_bytes=total,
                          response_sha256=hashlib.sha256(payload).hexdigest())
            timing = response.getheader("Server-Timing", "")
            result["server_timing_ms"] = {key: float(value) for key, value in re.findall(
                r"(?:^|,)\s*([a-zA-Z0-9_-]+);dur=([0-9.]+)", timing)}
            try:
                parsed = json.loads(payload)
            except (ValueError, UnicodeDecodeError):
                parsed = None
            if response.status in (429, 503):
                outcome = "overload_or_unavailable"
            elif response.status == 504:
                outcome = "server_timeout"
            elif not 200 <= response.status < 300:
                outcome = "http_error"
            elif not isinstance(parsed, dict):
                outcome = "invalid_json_response"
            elif parsed.get("status") == "error" or parsed.get("error"):
                outcome = "engine_error"
            else:
                outcome = "http_json_success"
            result["outcome"] = outcome
            if isinstance(parsed, dict) and isinstance(parsed.get("error"), dict):
                result["error_code"] = parsed["error"].get("code")
        except TimeoutError:
            result["outcome"] = "client_timeout"
        except Exception as error:  # noqa: BLE001 - every client failure is a counted outcome
            result.update(outcome="transport_or_client_error", error_type=type(error).__name__)
        finally:
            conn.close()
            ended = time.monotonic()
            result.update(service_wall_ms=(ended-began)*1000, arrival_to_completion_ms=(ended-arrival)*1000)
            with lock:
                active -= 1
                records.append(result)
            slots.release()

    interrupted = False
    offered = 0
    with futures.ThreadPoolExecutor(max_workers=a.max_inflight, thread_name_prefix="vigo-load") as pool:
        try:
            for index in range(scheduled):
                arrival = start + index / a.rate
                remaining = arrival - time.monotonic()
                if remaining > 0:
                    time.sleep(remaining)
                offered += 1
                if not slots.acquire(blocking=False):
                    with lock:
                        records.append({"index": index, "kind": corpus[index % len(corpus)]["kind"],
                            "outcome": "client_capacity_drop", "scheduled_ms": (arrival-start)*1000,
                            "dispatch_lag_ms": (time.monotonic()-arrival)*1000})
                    continue
                try:
                    pool.submit(one, index, arrival)
                except BaseException:
                    slots.release()
                    raise
        except KeyboardInterrupt:
            interrupted = True
    elapsed = time.monotonic() - start
    records.sort(key=lambda row: row["index"])
    counts = Counter(row["outcome"] for row in records)
    success = [row for row in records if row["outcome"] == "http_json_success"]
    slo_count = sum(row["arrival_to_completion_ms"] <= a.slo_ms for row in success)
    report = {"schema": "vigo.audit.open_loop.v1", "target_origin": a.url,
        "client": {"python": platform.python_version(), "platform": platform.platform()},
        "workload_sha256": hashlib.sha256(raw).hexdigest(),
        "configuration": {"rate": a.rate, "arrival_window_seconds": a.duration, "max_inflight": a.max_inflight,
                          "timeout_seconds": a.timeout, "slo_ms": a.slo_ms},
        "scheduled_arrivals": scheduled, "offered_arrivals": offered, "interrupted": interrupted,
        "peak_client_inflight": peak, "outcomes": dict(counts), "elapsed_including_drain_seconds": elapsed,
        "successful_completions_per_total_second": len(success)/elapsed if elapsed else 0,
        "successful_within_slo_fraction_of_offered": slo_count/offered if offered else None,
        "success_arrival_latency": quantiles([row["arrival_to_completion_ms"] for row in success]),
        "all_completed_arrival_latency": quantiles([row["arrival_to_completion_ms"] for row in records if "arrival_to_completion_ms" in row]),
        "client_dispatch_lag": quantiles([row["dispatch_lag_ms"] for row in records]),
        "limitations": ["HTTP/JSON success is not route correctness or structural-schema certification.",
                         "Measure server memory/CPU separately; this client does not infer them.",
                         "Client-capacity drops count against offered load; inspect dispatch lag for generator saturation.",
                         "Fixed-rate arrivals are open-loop; short runs are not a soak or production-capacity certificate."],
        "samples": records}
    a.output.parent.mkdir(parents=True, exist_ok=True)
    with a.output.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2, allow_nan=False)
        stream.write("\n")
    print(json.dumps({"output": str(a.output), "offered": offered, "outcomes": dict(counts),
                      "slo_fraction": report["successful_within_slo_fraction_of_offered"]}))
    return 130 if interrupted else 0


if __name__ == "__main__":
    raise SystemExit(main())
