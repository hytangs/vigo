from __future__ import annotations

import copy
import json
import os
import re
import shutil
import subprocess
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, cast

VERSION = "0.5.2"
API_VERSION = "1.0"
CITY_FORMAT_VERSION = 1
RESULT_SCHEMA_VERSION = 1
_BUNDLED_RUNTIME = Path(__file__).resolve().parent / "_runtime"
PUBLIC_COMMANDS = (
    "build",
    "capabilities",
    "inspect",
    "route",
    "matrix",
    "reach",
    "stream",
    "compare",
)


class VigoError(RuntimeError):
    """A VIGO operation could not be completed."""


class VigoTimeoutError(VigoError, TimeoutError):
    """A VIGO operation exceeded its caller-supplied time limit."""


@dataclass(frozen=True, slots=True)
class RuntimeInfo:
    """The compatible VIGO runtime selected for this Python process."""

    product_version: str
    api_version: str
    source: str
    path: str
    command: tuple[str, ...] = field(repr=False)
    capabilities: Mapping[str, Any] = field(repr=False)


def _app_command(app: Path) -> tuple[str, ...] | None:
    app = app.expanduser().resolve()
    executables = (
        (app,) if app.is_file() else (
            app / "Contents" / "MacOS" / "VIGO Studio",
            app / "VIGO Studio.app" / "Contents" / "MacOS" / "VIGO Studio",
            app / "VIGO Studio.exe",
            app / "VIGO Studio",
        )
    )
    for executable in executables:
        resources = _app_resources(executable)
        program = resources / "app" / "public" / "vigo.mjs"
        kernel = resources / "app" / "server" / "vigo-routing-kernel.node"
        if executable.is_file() and program.is_file() and kernel.is_file():
            return (str(executable), str(program))
    return None


def _app_resources(executable: Path) -> Path:
    if executable.parent.name == "MacOS" and executable.parent.parent.name == "Contents":
        return executable.parent.parent / "Resources"
    return executable.parent / "resources"


def _closed_environment(environment: Mapping[str, str]) -> dict[str, str]:
    return {
        key: value for key, value in environment.items()
        if re.fullmatch(
            r"PATH|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|"
            r"SystemRoot|WINDIR|TEMP|TMP|TMPDIR|XDG_CONFIG_HOME|XDG_CACHE_HOME|"
            r"XDG_DATA_HOME|LANG|LANGUAGE|LC_[A-Z_]+|TZ", key, re.IGNORECASE
        )
    }


def _command_environment(command: Sequence[str]) -> dict[str, str]:
    environment = os.environ.copy()
    executable = Path(command[0])
    # A colocated headless payload is a closed runtime. Host injection/provider
    # settings must not substitute a different Node module or native kernel.
    if len(command) == 2 and executable.name in {"node", "node.exe"}:
        program = Path(command[1])
        kernel = program.parent / "vigo-routing-kernel.node"
        if program.name == "vigo.mjs" and executable.parent == program.parent and kernel.is_file():
            environment = _closed_environment(environment)
            environment["VIGO_NATIVE_ROUTING_KERNEL"] = str(kernel)
            return environment
    app_command = _app_command(executable)
    if app_command and tuple(command[:2]) == app_command:
        environment = _closed_environment(environment)
        environment["ELECTRON_RUN_AS_NODE"] = "1"
        environment["VIGO_NATIVE_ROUTING_KERNEL"] = str(
            _app_resources(executable)
            / "app"
            / "server"
            / "vigo-routing-kernel.node"
        )
    return environment


def _path_command(value: str | os.PathLike[str]) -> tuple[str, ...] | None:
    path = Path(value).expanduser()
    if packaged := _app_command(path):
        return packaged
    if path.is_dir():
        executable = path / ("node.exe" if os.name == "nt" else "node")
        program = path / "vigo.mjs"
        if all(file.is_file() for file in (executable, program, path / "vigo-routing-kernel.node")):
            return (str(executable.resolve()), str(program.resolve()))
        return None
    if path.is_file():
        if path.name in {"VIGO Studio", "VIGO Studio.exe"}:
            return None
        if path.suffix == ".mjs" and (node := shutil.which("node")):
            return (node, str(path.resolve()))
        return (str(path.resolve()),)
    return None


def _candidates(
    explicit: str | os.PathLike[str] | Sequence[str] | None,
) -> Iterator[tuple[str, tuple[str, ...]]]:
    if explicit is not None:
        if isinstance(explicit, Sequence) and not isinstance(
            explicit, (str, bytes, os.PathLike)
        ):
            command = tuple(str(part) for part in explicit)
            if command:
                yield "explicit", command
            return
        candidate = _path_command(cast(str | os.PathLike[str], explicit))
        if candidate:
            yield "explicit", candidate
        return

    configured = os.environ.get("VIGO_RUNTIME")
    if configured:
        configured_command = _path_command(configured)
        if configured_command:
            yield "environment", configured_command
        return

    configured_app = os.environ.get("VIGO_APP")
    if configured_app:
        configured_command = _app_command(Path(configured_app))
        if configured_command:
            yield "studio", configured_command
        return

    bundled = _path_command(_BUNDLED_RUNTIME)
    if bundled:
        yield "bundled", bundled
        return

    for app in (
        Path("/Applications/VIGO Studio.app"),
        Path.home() / "Applications/VIGO Studio.app",
    ):
        app_command = _app_command(app)
        if app_command:
            yield "studio", app_command

    installed = shutil.which("vigo")
    if installed:
        yield "path", (installed,)


def _run(
    command: Sequence[str], *arguments: str, timeout: float = 30.0, progress: bool = False
) -> subprocess.CompletedProcess[str]:
    try:
        if progress:
            from .progress import run_with_progress

            return run_with_progress(
                [*command, *arguments], timeout=timeout,
                environment=_command_environment(command),
            )
        return subprocess.run(
            [*command, *arguments],
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
            timeout=timeout,
            env=_command_environment(command),
        )
    except subprocess.TimeoutExpired as error:
        raise VigoTimeoutError(
            f"VIGO did not respond within {timeout:g} seconds"
        ) from error


def _command_identity(command: tuple[str, ...]) -> tuple[tuple[object, ...], ...]:
    identities = []
    executable = shutil.which(command[0]) or command[0]
    environment = _command_environment(command)
    kernel = environment.get("VIGO_NATIVE_ROUTING_KERNEL")
    for part in (executable, *command[1:], *((kernel,) if kernel else ())):
        path = Path(part)
        try:
            stat = path.stat()
        except OSError:
            continue
        identities.append(
            (
                str(path.resolve()),
                stat.st_dev,
                stat.st_ino,
                stat.st_size,
                stat.st_mtime_ns,
                stat.st_ctime_ns,
            )
        )
    return tuple(identities)


@lru_cache(maxsize=8)
def _runtime_capabilities(
    command: tuple[str, ...],
    identity: tuple[tuple[object, ...], ...],
) -> dict[str, Any]:
    # The identity invalidates a successful handshake after a rebuild or upgrade.
    response = _run(command, "capabilities")
    try:
        capabilities = json.loads(response.stdout) if response.returncode == 0 else None
    except json.JSONDecodeError:
        capabilities = None
    if (
        not isinstance(capabilities, dict)
        or capabilities.get("schemaVersion") != "vigo.capabilities.v3"
        or capabilities.get("apiVersion") != API_VERSION
        or not re.match(r"^0\.5\.\d+(?:$|[-+])", str(capabilities.get("productVersion", "")))
        or capabilities.get("cityFormatVersion") != CITY_FORMAT_VERSION
        or capabilities.get("resultSchemaVersion") != RESULT_SCHEMA_VERSION
        or not isinstance(capabilities.get("publicCliCommands"), list)
        or any(
            name not in capabilities["publicCliCommands"] for name in PUBLIC_COMMANDS
        )
    ):
        raise VigoError("VIGO Python 0.5 requires a VIGO 0.5 runtime and the current stream API")
    output = capabilities.get("output")
    if (
        not isinstance(output, dict)
        or not isinstance(output.get("diagnostics"), list)
        or "trace" not in output["diagnostics"]
    ):
        raise VigoError("VIGO 0.5 must advertise trace output for detailed Python Results")
    return capabilities


def resolve_runtime(
    runtime: RuntimeInfo | str | os.PathLike[str] | Sequence[str] | None = None,
    *,
    verify: bool = True,
) -> RuntimeInfo:
    """Find a VIGO runtime whose public API is compatible with this package."""

    if isinstance(runtime, RuntimeInfo):
        return runtime
    failures: list[str] = []
    for source, command in _candidates(runtime):
        if not verify:
            return RuntimeInfo("unknown", API_VERSION, source, command[-1], command, {})
        try:
            capabilities = copy.deepcopy(
                _runtime_capabilities(command, _command_identity(command))
            )
        except (OSError, VigoError):
            failures.append(" ".join(command))
            continue
        return RuntimeInfo(
            product_version=capabilities["productVersion"],
            api_version=str(capabilities["apiVersion"]),
            source=source,
            path=command[-1],
            command=command,
            capabilities=capabilities,
        )

    detail = f" Checked: {', '.join(failures)}." if failures else ""
    raise VigoError(
        "No VIGO 0.5 runtime with the current stream API is available. "
        "Install a VIGO 0.5 platform wheel or set VIGO_RUNTIME to an Engine 0.5 runtime." + detail
    )


def run_json(
    runtime: RuntimeInfo,
    arguments: Sequence[str],
    *,
    timeout: float,
    progress: bool = False,
) -> str:
    completed = _run(runtime.command, *arguments, timeout=timeout, progress=progress)
    if completed.returncode != 0:
        message = (
            completed.stderr.strip() or completed.stdout.strip() or "unknown error"
        )
        raise VigoError(message)
    return completed.stdout
