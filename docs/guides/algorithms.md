# Computation internals

This page explains implementation. Users do not need these details to operate VIGO.

VIGO compiles scheduled transit and directed street data once, then opens compact native data for queries. Rust owns timetable propagation, street search, matrix work, and Reach surfaces. JavaScript validates requests, manages local application state, and shapes Results. Studio and the command line do not implement separate routers.

## Route

Transit Route scans scheduled connections for the selected service date and attaches directed walking access and egress for coordinate points. Arrive-by uses its own reverse-time operation. Departure windows evaluate selected departure minutes and retain distinct alternatives.

Walk and Drive Route search their respective directed street graphs. Drive can apply supplied traffic weights without rebuilding road topology.

## Matrix

Transit Matrix shares forward work across destinations when valid. Street Matrix computes directed scalar distance and duration in native batches. Transit Matrix can also render its selected journeys, including geometry, without repeating timetable searches.

## Reach

Reach combines a timetable range scan with directed street propagation and writes one travel-time surface. Contours are derived from that surface. Planned service changes are merged into the selected timetable operation without editing the City source.

## Ownership

SQLite is durable Build output. Query execution uses native in-memory or mapped data opened from the City. JavaScript delegates graph search to the native kernels.
