"""Optional acceleration for JSON received from Engine (encoding stays strict)."""

from __future__ import annotations

import json
from collections.abc import Callable
from importlib import import_module
from typing import Any

loads: Callable[[str], Any]
try:
    loads = import_module("orjson").loads
except ImportError:
    loads = json.loads


def copy_json(value: Any) -> Any:
    """Copy a decoded JSON tree without deepcopy's object-graph bookkeeping.

    Engine responses have no cycles or shared mutable references. Immutable
    leaves can be reused; every dict/list returned to a caller must be new.
    Result payloads must contain JSON values.
    """
    kind = type(value)
    if kind is dict:
        return {key: copy_json(item) for key, item in value.items()}
    if kind is list:
        return [copy_json(item) for item in value]
    if kind in (str, int, float, bool, type(None)):
        return value
    raise TypeError(f"Result contains a non-JSON value: {kind.__name__}")
