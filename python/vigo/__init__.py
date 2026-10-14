"""VIGO Python.

VIGO has one model across Studio, Python, and the command line:
City -> Scenario -> Route, Matrix, or Reach -> Result.
"""

from .model import (
    City,
    InvalidQuery,
    Job,
    Matrix,
    Query,
    Reach,
    Result,
    Route,
    Scenario,
    Support,
    UnsupportedQuery,
    build,
    compare,
    open,
)
from .runtime import (
    API_VERSION,
    CITY_FORMAT_VERSION,
    RESULT_SCHEMA_VERSION,
    VERSION,
    RuntimeInfo,
    VigoError,
    VigoTimeoutError,
    resolve_runtime,
)

__version__ = VERSION

__all__ = [
    "API_VERSION",
    "CITY_FORMAT_VERSION",
    "RESULT_SCHEMA_VERSION",
    "City",
    "InvalidQuery",
    "Job",
    "Matrix",
    "Query",
    "Reach",
    "Result",
    "Route",
    "RuntimeInfo",
    "Scenario",
    "Support",
    "UnsupportedQuery",
    "VigoError",
    "VigoTimeoutError",
    "__version__",
    "build",
    "compare",
    "open",
    "resolve_runtime",
]
