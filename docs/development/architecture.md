# VIGO internal architecture

VIGO presents one product model while keeping computation, application state, and interfaces separated.

```text
+---------------- VIGO Studio ----------------+
| Electron main | isolated renderer            |
| Explore | Route | Analyze | City              |
+----------------------+-----------------------+
                       | memory messages
+---------------- VIGO Engine ----------------+
| dedicated utility process                    |
+----------------------+-----------------------+
                       |
+-------------- Command-line interface --------+
| VIGO command                                 |
+----------------------+-----------------------+
                       |
             City -> Scenario -> Query
                       |
          +------------+------------+
          | Route      | Matrix     | Reach
          +------------+------------+
                       |
                    Result
                       |
             inspect | compare | export
                       |
          native timetable and street work
```

## Build

Build validates GTFS and OSM, creates the timetable and street data, readies native query files, writes City metadata, and publishes one complete directory. An incomplete Build never replaces the previous City.

Only current routing and street formats are accepted. Old stores must be rebuilt from their source GTFS and OSM PBF; merging, compaction, and derived-index preparation cannot upgrade them in place. SQLite compaction precedes transfer topology and native access preparation. Compaction retires indexes bound to the previous SQLite generation, and publication rejects a stale topology.

## Open

Open checks the City revision and loads only the data required for a Query. Repeated work may keep native data open. This lifecycle is automatic and is not part of the public product model.

Studio checks the stored format before reporting an index as ready. An obsolete street store retains its admission error instead of appearing as a missing native kernel. Store-admission, City-publication, CLI-build, and preparation-lifecycle tests cover these boundaries.

## Compute

Rust owns timetable propagation, street search, Matrix work, and Reach surfaces. JavaScript owns validation, local application coordination, and Result shaping.

## Studio

Electron owns the window, native dialogs, menus, and the `vigo://studio` resource
scheme. The renderer is isolated and has no Node access. A preload exposes only the
small set of desktop actions Studio needs.

VIGO Engine runs in a utility process. Studio sends requests through memory messages;
the packaged application does not bind a TCP port. Browser development may still use
the loopback-only development server. Both paths reach the same request handlers and
the same Rust kernels.

## Storage

The City directory is the public unit of movement. Individual database and native files are internal parts of that directory. A City revision is immutable once published.

## Timing

Build, Open, Compute, and End-to-end durations remain distinct in code and Results. The first Query may include Open work. Repeated Queries may reuse already-open native data.
