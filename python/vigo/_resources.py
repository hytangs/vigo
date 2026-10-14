"""Conservative process capacity; swap is never counted as resident memory."""

from __future__ import annotations

import os
from pathlib import Path


def _read(path: Path) -> str:
    try:
        with path.open(encoding="ascii") as source:
            return source.read(4096).strip()
    except (OSError, UnicodeError):
        return ""


def _positive(value: str) -> int | None:
    try:
        number = int(value)
        return number if number > 0 else None
    except ValueError:
        return None


def _ancestors(root: Path, relative: str):
    parts = Path(relative.lstrip("/")).parts
    if ".." in parts:
        return
    path = root.joinpath(*parts)
    while True:
        yield path
        if path == root:
            break
        path = path.parent


def _linux_limits(root: Path = Path("/sys/fs/cgroup"),
                  membership: Path = Path("/proc/self/cgroup")) -> tuple[list[int], list[int]]:
    memory, cpus = [], []
    unified = {root}
    legacy_memory = {root / "memory"}
    legacy_cpu = {root / "cpu", root / "cpu,cpuacct", root / "cpuacct,cpu"}
    for line in _read(membership).splitlines():
        fields = line.split(":", 2)
        if len(fields) != 3:
            continue
        _, controllers, relative = fields
        if not controllers:
            unified.update(_ancestors(root, relative))
        if "memory" in controllers.split(","):
            legacy_memory.update(_ancestors(root / "memory", relative))
        if "cpu" in controllers.split(","):
            for name in ("cpu", "cpu,cpuacct", "cpuacct,cpu"):
                legacy_cpu.update(_ancestors(root / name, relative))
    for path in unified:
        for name in ("memory.max", "memory.high"):
            raw = _read(path / name)
            limit = _positive(raw)
            if limit is not None or raw == "0":
                memory.append(limit or 0)
        quota = _read(path / "cpu.max").split()
        if len(quota) == 2:
            amount, period = map(_positive, quota)
            if amount and period:
                cpus.append(max(1, amount // period))
    for path in legacy_memory:
        if limit := _positive(_read(path / "memory.limit_in_bytes")):
            memory.append(limit)
    for path in legacy_cpu:
        amount = _positive(_read(path / "cpu.cfs_quota_us"))
        period = _positive(_read(path / "cpu.cfs_period_us"))
        if amount and period:
            cpus.append(max(1, amount // period))
    return memory, cpus


def worker_count() -> int:
    cpu_limits = [os.cpu_count() or 1]
    affinity = getattr(os, "sched_getaffinity", None)
    if affinity is not None:
        try:
            cpu_limits.append(max(1, len(affinity(0))))
        except OSError:
            pass
    memory_limits = []
    try:
        sysconf = getattr(os, "sysconf", None)
        if sysconf is not None:
            memory_limits.append(int(sysconf("SC_PHYS_PAGES")) * int(sysconf("SC_PAGE_SIZE")))
    except (AttributeError, OSError, TypeError, ValueError):
        pass
    if Path("/proc/self/cgroup").is_file():
        memory, cpus = _linux_limits()
        memory_limits.extend(memory)
        cpu_limits.extend(cpus)
    if not memory_limits or min(memory_limits) <= 0:
        return 1
    return max(1, min(4, min(cpu_limits) // 2, min(memory_limits) // (6 * 1024**3)))
