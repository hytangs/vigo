# RFC 0001: VIGO 1.0 architecture

| | |
| --- | --- |
| Status | Draft |
| Branch | `vigo-v1-dev` |
| Opened | 2026-10-18 |
| Replaces | The migration approach and schedule in the October 2026 product vision draft |

## Summary

VIGO 1.0 has one engine, one binary and one contract.

Every computation, from reading a GTFS ZIP to drawing a Reach contour, runs in Rust inside the `vigo` executable. Studio, Python and HTTP callers are clients of that executable. They send the same requests and receive the same Results, because there is only one implementation that can produce them.

Three changes do this:

1. **A pure Rust workspace.** The single kernel crate splits into crates that each own one thing. Routing algorithms stop depending on Node-API types, untyped JSON or file I/O.
2. **`vigo build` in Rust.** The JavaScript compiler is replaced end to end, verified against it at the level of whole Cities. Cities stay readable by the published 0.5.0 runtime and gain an optional pack that opens instantly.
3. **Studio as a pure client of `vigo serve`.** The JavaScript server, the Node addon, and the parity machinery that keeps two runtimes equal are deleted.

On this foundation, [RFC 0002](0002-vigo-1-capabilities.md) adds three capabilities: live multimodal routing, GTFS-Flex, and regional analysis with scenario planning.

## Motivation

### Two runtimes doing one job

VIGO 0.5.2 answers queries in two places:

- **The `vigo` executable** (Rust, about 40K lines) serves the CLI, the HTTP API and Python.
- **The JavaScript server** (about 36K lines) serves Studio's private API, about 25 actions such as `national-route`, `national-matrix` and `reach`. It also serves the `vigo.mjs` compiler's query commands. It drives the same Rust kernel through a Node addon.

Both sit on one crate compiled two ways. The executable build substitutes a stub for Node-API (`use crate::standalone_types as napi`), so the core algorithms still return Node error types and take Node buffer types. `lib.rs` alone mixes the addon boundary, the coordinate kernel, street access and matrix code in 8.7K lines.

Keeping the two runtimes equal costs a lot. It takes parity suites, cross-interface output checks, and much of the 193-script `test/check-*.mjs` chain. Every feature lands twice, or lands once and is bridged. Studio talks only to the private API, so improvements to the public engine reach Studio only through that bridge.

### Where time actually goes

Warm queries already return in low single-digit milliseconds at metropolitan scale. Making them faster is not what 1.0 is about. The slow parts are elsewhere:

- **Building a City.** Large metropolitan Cities take minutes. The two largest stages are GTFS import and OSM import, both JavaScript writing SQLite. Stop-transfer generation and street CCH contraction come next.
- **The first query for a service date.** The engine loads that date's active trips from SQLite and builds a timetable kernel. Dates named with `--prepare-date` at build time ship prepared; any other date pays this cost on first use.
- **Studio interaction.** The time a person waits is set by Studio's request path, serialization and rendering, not by the kernel.
- **Development speed.** Every change has to pass through two runtimes, a JS/Rust boundary and a long chain of bespoke checks.

### What stays

These are already right and must survive the revamp intact:

- The City → Scenario → Query → Result model.
- Explicit outcomes: blocked results, `null` for unreachable cells, walking evidence.
- The exact algorithms: CSA timetable search, CCH street search, the exact constrained drive search, nondominated Reach frontiers.
- The permanent 0.5.0 prepared-data contract.
- The public `vigo.*.v1` schemas and `/v1` HTTP paths.

## Goals

- One implementation of every computation, in Rust.
- A routing core that is pure: typed inputs, typed outputs, no I/O, no global configuration.
- Builds an order of magnitude simpler to run (one executable, no Node), and much faster.
- Opening a City and answering the first query for any covered date with no visible preparation step.
- A Studio whose code is organized by workflow and contains no routing semantics.
- A release gate built on `cargo test`, a golden corpus and a few end-to-end suites, plus the existing 0.5.0 format gate.
- The capabilities in RFC 0002, each opt-in, so a 0.5 request still receives a 0.5 Result.

Proposed targets, to be confirmed against the M0 baselines on the same machine:

| Measure | Target |
| --- | --- |
| Metropolitan City build, wall time | At most one third of 0.5.2 |
| Packed City: open plus first query for any covered date | Under one second |
| Warm Route, Matrix and Reach latency | No regression from 0.5.2 at p50 and p95 |
| Peak memory during build | No regression from 0.5.2 |

## Non-goals

- Changing an existing answer. A 0.5 request gets the same Result unless a deliberate bug fix is recorded. New behavior from RFC 0002 appears only when a request asks for it.
- A new required City format, or rebuilding valid 0.5 Cities.
- National-scale resident routing.
- An AI agent framework. VIGO computes; downstream products interpret.
- Any fixed release date. 1.0 ships when the exit criteria below are met.

## Design

### Process architecture

```text
 Studio (React + MapLibre)        Python            any HTTP client
          │                          │                     │
 desktop shell relay (stdio)    stream / serve       HTTP /v1/…
          │                          │                     │
          └──────────────┬───────────┴─────────────────────┘
                         ▼
                 vigo  (one Rust executable)
   build · pack · inspect · route · matrix · reach · compare · stream · serve
                         │
          vigo-server ── vigo-engine ── vigo-route
                         │
                    vigo-format
                         │
       City directory: 0.5 layout (+ optional pack/)
```

Node remains only as Studio's build tool. It does not run at query time or build time.

### Workspace and crates

The repository root becomes a Cargo workspace. Crates live in `crates/`; the vendored CCH crate moves with them.

| Crate | Owns | Depends on |
| --- | --- | --- |
| `vigo-model` | Public request and Result types, validation, JSON Schema, error codes | — |
| `vigo-route` | Algorithms: timetable search (forward, reverse, profile, alternatives, and Range RAPTOR for regional analysis), street search (CCH, exact drive, surfaces), access and egress producers including flex, station and terminal access, Reach propagation, overlays, fare computation | `cch` |
| `vigo-gtfs` | GTFS ZIP reading and validation into a columnar feed, including GTFS-Flex; calendars; fare tables; GTFS-Realtime decoding | — |
| `vigo-osm` | PBF decoding; walk, bicycle and drive graphs with traffic stress; parking facilities; stations, entrances and pathways; basemap features | — |
| `vigo-format` | Reading and writing Cities: the 0.5 layout, the optional pack, identities, scenario collections | `vigo-model` |
| `vigo-prepare` | Turning a feed and a street graph into a City: transfers, station access, coordinate access, topology, CCH contraction, timetable snapshots | `vigo-gtfs`, `vigo-osm`, `vigo-route`, `vigo-format` |
| `vigo-engine` | The City runtime: open, residency, caches, scenarios, realtime overlays, query execution, materialization into Results | `vigo-route`, `vigo-format`, `vigo-model` |
| `vigo-live` | Feed polling and admission; immutable live snapshots of trip updates, alerts, trip modifications and traffic | `vigo-gtfs`, `vigo-model` |
| `vigo-analysis` | Opportunity datasets, studies, regional analysis jobs, accessibility indicators and equity reduction | `vigo-engine`, `vigo-model` |
| `vigo-server` | HTTP and stdio transports, authentication, admission, request cancellation, build and analysis jobs | `vigo-engine`, `vigo-prepare`, `vigo-live`, `vigo-analysis` |
| `vigo-cli` | The `vigo` executable | `vigo-server` |
| `vigo-node` | Temporary Node addon over `vigo-engine`, kept only until M6 | `vigo-engine` |

Rules every crate follows:

- **`vigo-route` is pure.** No `napi`, no `serde_json::Value`, no filesystem, no environment variables, no threads it did not receive. Times are `u32` seconds and entities are dense `u32` indexes. String IDs exist only at the edges, in `vigo-format` and `vigo-model`.
- **Configuration is passed in.** Cache budgets and thread counts currently read from `VIGO_*` variables inside kernel code. They become fields of an engine configuration that `vigo-cli` builds from flags and environment.
- **Errors are typed** with a stable error code each. Messages are for people; codes are for programs.
- **Workspaces are reusable and per-thread.** An opened City is `Send + Sync` and shared; per-query scratch memory is pooled.

### The contract: `vigo-model`

`vigo-model` is the single definition of what VIGO accepts and returns:

- Request and Result types for Route, Matrix, Reach, Compare and Info, with serde attributes that reproduce today's JSON exactly. It also has types for the new server resources described below.
- JSON Schema derived from those types. The OpenAPI document is generated from it, replacing today's script, which pattern-matches `pub struct` blocks in Rust source.
- TypeScript types for Studio and Python typed dictionaries, both generated from the same schema.

`/v1/native` remains served for compatibility. Its types are frozen and documented as diagnostic, not as an application interface.

### The engine surface

The CLI keeps every 0.5.2 command and flag, and gains three:

| Command | Purpose |
| --- | --- |
| `vigo build` | Build a City from GTFS and OSM. Accepts the same flags as `vigo.mjs build`, so scripts port by changing the executable name. |
| `vigo pack <city>` | Add or refresh the optional pack in an existing City, atomically. Changes nothing else in the directory. |
| `vigo inspect <city>` | Report identity, sources, coverage, prepared artifacts, the read path in use (pack or SQLite), and verify hashes on request. |

`vigo serve` keeps every existing `/v1` path and response. Studio's needs become public, documented resources:

| Resource | Replaces in 0.5.2 |
| --- | --- |
| `GET/POST /v1/cities`, `GET/DELETE /v1/cities/{id}` | Studio project library |
| `POST /v1/builds`, `GET /v1/builds/{id}` (with progress events), `DELETE /v1/builds/{id}` | GTFS/OSM import, upload, merge and job actions |
| `GET /v1/cities/{id}/network` | Network preview, route analysis, transport atlas |
| `GET /v1/cities/{id}/timetable` | Stop boards, trip timetables |
| `GET /v1/cities/{id}/basemap` | Local OSM basemap |
| `POST /v1/realtime/inspect` | Realtime inspection |
| `POST /v1/scenarios/compile` | Scenario validation and road geometry, now compiled in Rust |

Resources that are new in 1.0 carry an explicit stability marker in the OpenAPI document until they are declared stable.

**HTTP stack.** The hand-written HTTP/1.1 server moves to `hyper` with `axum` routing. That brings keep-alive, streaming responses, graceful shutdown, and cancellation when a client disconnects. Computation runs on a dedicated `rayon` pool, never on async worker threads. Today's admission semantics carry over unchanged: request-byte leases, body limits, resident-memory ceilings and bearer authentication. The existing HTTP checks are ported before the switch, so every edge behavior is pinned first.

**Desktop transport.** Packaged Studio has no TCP listener today, and it keeps none. The desktop shell starts `vigo serve --stdio`, which speaks framed HTTP-equivalent messages through the same handlers. The shell relays the renderer's `vigo://api/…` requests to it. Browser development uses ordinary loopback HTTP against the same server.

### City data: 0.5 layout plus an optional pack

The contract has two directions, and both stay:

- 1.0 readers open every valid 0.5 City without rebuilding it.
- Cities written by 1.0 open in the published 0.5.0 runtime.

The published 0.5.0 readers, both the Rust executable and the JavaScript CLI, open fixed paths under a City (`network.json`, `routing/…`, `osm/…`). They look in `osm/` only for files matching their CCH manifest prefix, and they ignore every other entry. The optional pack therefore lives in its own directory and is invisible to them:

```text
city/
├── network.json              0.5 manifest, unchanged
├── routing/…                 0.5 layout, unchanged
├── osm/…                     0.5 layout, unchanged
└── pack/
    ├── pack.json             identity, section table, writer version
    └── city.pack             one memory-mapped file of aligned sections
```

**Contents.** The pack holds the same information as the 0.5 layout, arranged for direct use:

| Section | Holds | Removes at runtime |
| --- | --- | --- |
| Strings | Stop, route, trip and agency IDs and names as offset tables | Building hash maps from SQLite rows |
| Stops | Coordinate columns, parents, location types, a spatial grid | Parsing stop records from the access context |
| Calendar | Service patterns as bitsets over the feed's date range; a pattern per trip | Calendar resolution per date |
| Timetable | All connections in departure order, trip boundaries, per-stop departure index, transfer adjacency and rules, for every service date | Per-date SQLite load, sort and index build |
| Station access | Compiled directed station paths and witnesses | JSON-in-binary decoding |
| Shapes | Coordinate columns, distance prefixes, distinct-position indexes | SQLite reads during materialization |
| Display and fares | Typed route and trip display columns; fare tables | `HashMap<String, Value>` metadata |

Street data is not copied. The pack refers to the existing street accelerator and CCH files by their manifests and adds only the indexes that are missing.

**Activating a date** becomes computing the active-pattern bitset for that date and the day before, the latter for trips that run past midnight. That takes microseconds. Measurement in M2 decides between two ways of using the bitset: scanning all connections with an activity check, or materializing one filtered connection array per date. The existing exact-date and cross-midnight semantics are reproduced exactly, and the calendar-boundary fixtures are part of the corpus.

**Rules for the pack:**

1. **Optional.** A City without a pack, or with an invalid one, opens through the SQLite path exactly as in 0.5.2. A bad pack is reported by `vigo inspect` and ignored. It never makes a City unreadable.
2. **Derived from the 0.5 layout, except declared extensions.** Derived sections need only the City, so `vigo pack` can always rebuild them, and they stay cache-like with a single source of truth. Extension sections (bicycle graph, parking facilities, Flex; see RFC 0002) need the original sources and are written by `vigo build`. `network.json` lists them. A request that needs a missing extension fails with a typed error rather than answering without it.
3. **Bound to its source.** `pack.json` records the hash of `network.json` and the SQLite generations it was built from. On any mismatch the pack is ignored.
4. **Cheap to validate.** Opening checks the header checksum and the structural bounds of every section. Full content hashing runs only with `vigo inspect --verify`.
5. **Written last and atomically.** `vigo build` writes the complete 0.5 layout first, then the pack (on by default, `--no-pack` skips it). `vigo pack` stages the new directory and renames it into place.
6. **Self-describing in collections.** A scenario collection's `checksums.json` is written by the compiler but never read by the 0.5.0 runtime. `vigo build` lists pack files in it. `vigo pack` added later leaves it unchanged, because `pack.json` carries the pack's own hashes.

**Cost.** Cities grow on disk by roughly the pack's size, which M2 measures for every fixture and metropolitan City. Read-only media can skip the pack and lose nothing but speed.

### Studio

Studio is rebuilt on the same stack (React, TypeScript, MapLibre, Vite) as a client of `vigo serve`. The aim is a new architecture, not restyled components.

**Structure:**

| Layer | Responsibility |
| --- | --- |
| Shell | Window, navigation, panel layout, workspace lifecycle |
| Engine client | Generated types, request cancellation (an aborted request also cancels it on the server), progress events, error codes |
| Query store | Results cached by request; one store per workspace; no application-wide state component |
| Map | One MapLibre instance; workspaces register their layers, legends and selection through a layer registry |
| Presentation | Color scales, contour styling, formatting, in one tested module that never changes an answer |
| Design system | Tokens, components, typography, keyboard and accessibility |

**Workspaces:**

| Workspace | Covers |
| --- | --- |
| Network | Routes, stops, timetables, line diagrams, live vehicles, alerts and feed health |
| Journey | Route queries, alternatives, itinerary and leg inspection, walking evidence, exports |
| Accessibility | Point Reach, Matrix runs, regional analysis, opportunity datasets, equity by population group |
| Scenarios | Modification editor, drafts, side-by-side comparison on shared scales across every query kind |
| Cities | Library, sources, builds with stage progress, integrity |

A request inspector is a drawer available in every workspace, not a separate workspace. It shows the exact request and Result JSON behind anything on screen, with timing split into engine, serialization and transport.

**Rules:**

- Studio computes nothing that changes an answer. It never interprets timetables or recomputes durations.
- Large Results never block interaction. Decoding and geometry preparation happen in Web Workers, and large lists are virtualized.
- Workflow tests (Playwright, against `vigo serve` and fixture Cities) are the primary Studio tests.

**Existing Studio data.** A 0.5.2 Studio project (`.vigo/project.json` beside `routing/` and `osm/`) appears in the library and opens read-only through an adapter in `vigo-format`. Converting it into a standard City is an explicit action and leaves the original untouched.

**Desktop shell.** Studio stays on Electron through M5. Once Studio is a thin client, the shell is cheap to replace, and Tauri becomes worth evaluating: no bundled Node, a much smaller download. The decision rests on MapLibre's WebGL behavior in WebKitGTK on Linux, code signing, and the size of the update.

### Python

The wheel bundles the `vigo` executable and nothing else. `vigo.build()` runs `vigo build`; queries keep using `vigo stream`. Neither Node nor the `.node` addon ships. Python types are generated from `vigo-model`. Source-wheel and release rules stay as `python/AGENTS.md` defines them.

### Removals and simplifications

- **JavaScript runtime:** `src/server/`, the JavaScript CLI, the route worker pool, the Node addon, and the parity suites that existed to keep two runtimes equal.
- **Research surfaces inside Studio:** the agency module (operations briefings, model providers, notebook, holding replay, LAMP study). Data they stored is left in place and never deleted.
- **Internal naming:** "national" stores, routes and jobs take the names of the public model: City, Route, Matrix, Reach, Build.
- **Identity encoding:** profile keys and identities stored as percent-encoded JSON strings become typed structures in new artifacts. Existing encodings stay readable.
- **Documentation:** pages describe what VIGO does. Limits sit together in one Known limits section instead of qualifying every sentence.

## Verification

**Golden corpus.** Before M1, 0.5.2 records request → Result pairs:

- Public synthetic fixtures, including the frozen 0.5.0 fixture, calendar-boundary, station, wheelchair, scenario-collection and realtime cases. These are committed in this repository.
- Metropolitan workloads in the private benchmark workspace. These are run there and never copied into this repository.

Every phase replays the corpus. Comparison ignores only fields declared as varying, such as timings and build IDs. Any other difference is either a bug or a recorded, deliberate fix.

**Compiler equivalence.** `vigo build` and the JavaScript compiler build the same inputs, and the resulting Cities are compared three ways:

- Normalized table contents and prepared-snapshot semantics.
- Corpus answers.
- The published 0.5.0 runtime opening the result.

Byte-identical SQLite files are not required; identical answers and 0.5.0 readability are.

**Format gate.** `npm run check:format-050` stays the release gate until it is ported to `cargo test` with the same frozen archive and the same published reference binary. It gains three cases: a packed City opened by 0.5.0, answers with and without a pack, and corrupted-pack fallback.

**Tests.** M1 classifies each of the 193 `test/check-*.mjs` scripts as one of:

- Port to a crate test.
- Fold into an end-to-end suite (CLI, HTTP, Python, Studio).
- Delete together with the JavaScript code it covered.

The independent synthetic oracles behind `npm run check:accuracy` are ported first.

**Performance reporting** keeps these separate, from M0 onward:

- Build wall time and peak memory per stage.
- City open time.
- First query per date.
- Warm p50 and p95 per query kind, split into engine, materialization, serialization and transport.
- Studio time to first map and time to first rendered journey.

## Migration order

```text
M0 ──► M1 ──┬──► M2 (pack)
 │          ├──► M3 (vigo build) ──────────────┐
 │          └──► M4 (server surface) ──► M5 ───┴──► M6 (removal)
 └──────────────────────────────────────► M5 starts on a mock server
```

RFC 0002's capability milestones, C1 to C6, start from M1 and run alongside: overlays, street modes, live data, Flex, regional analysis and the scenario modification set. 1.0 needs both the platform and the capability exits.

### M0: Contract and baseline

- Create `vigo-model` covering every public request and Result; generate JSON Schema, OpenAPI, TypeScript and Python types.
- Record the golden corpus and performance baselines from 0.5.2.

Exit: the generated OpenAPI matches `docs/standalone-openapi.json`, or every difference is reviewed. The corpus replays clean on 0.5.2.

### M1: Workspace and pure kernel

- Create the Cargo workspace and move the kernel modules into `vigo-route`, `vigo-format`, `vigo-engine`, `vigo-server` and `vigo-cli`.
- Replace the Node-API stub in the algorithms with plain Rust types; move the addon exports into `vigo-node`.
- Classify the check scripts.

Exit: the executable passes `npm run check:standalone` and the corpus. The addon passes `npm run check:rust-routing-kernel`. `vigo-route` contains no `napi` and no `serde_json::Value`.

### M2: Pack

- Add the pack writer and reader to `vigo-format`, and `vigo pack` and `vigo inspect` to the CLI.
- Make the engine prefer a valid pack.

Exit: identical corpus answers with and without the pack. The extended format gate passes. Open time and first-query-per-date time are measured against the M0 baseline, along with pack size.

### M3: `vigo build`

Stages are implemented in order of cost: GTFS import, OSM import, stop transfers, coordinate and terminal access, topology, then manifest and atomic publication. CCH contraction is already native. Rust orchestrates every stage from the start; JavaScript never calls into a stage. Until `vigo build` is complete, its intermediate stores are compared against the JavaScript compiler's.

Exit: City equivalence on all public fixtures and the private metropolitan inputs. The format gate passes in both directions. Build time and peak memory are reported per stage against the M0 baseline. The JavaScript compiler accepts only bug fixes from this point.

### M4: Server surface

- Add the City library, builds, network, timetable, basemap, realtime and scenario resources, and the `--stdio` transport.
- Port the HTTP checks, then move to `hyper` and `axum`.

Exit: every action Studio 0.5.2 uses has a documented Rust equivalent with tests.

### M5: Studio

Work starts right after M0 against a mock server that replays the corpus, and switches to `vigo serve` when M4 lands.

Exit: these Playwright workflows pass against `vigo serve`:

1. Open or build a City.
2. Plan and inspect a journey.
3. Compute Reach and a Matrix.
4. Compare two scenarios.
5. Export.
6. Open a 0.5.2 Studio project.

Every 0.5.2 export format is still available.

### M6: Removal

- Delete the JavaScript server and CLI, `vigo-node`, and the parity suites. npm remains only to build Studio.
- The Python wheel bundles only `vigo`.

Exit: the release gate is `cargo test`, the end-to-end suites, the corpus and the format gate. 1.0.0 is tagged when its maintainer decides, not on a calendar.

## Compatibility summary

| Surface | 1.0 behavior |
| --- | --- |
| 0.5 Cities | Open without rebuilding; packs optional |
| Cities written by 1.0 | Open in published 0.5.0; the pack is ignored there |
| `vigo.*.v1` Results | Unchanged meanings, units and time conventions; additions optional |
| `/v1` HTTP paths | Unchanged; new resources added |
| `vigo` commands | Unchanged; `build`, `pack` and `inspect` added |
| `vigo.mjs build` | Replaced by `vigo build` with the same flags |
| Studio 0.5.2 projects | Open read-only; explicit conversion |
| Removed Studio features | Removed; their stored data is untouched |

## Risks

- **The JavaScript compiler holds years of edge-case policy:** pathways, inferred transfers, wheelchair rules, untimed gaps, multi-feed merges. Mitigation: City-level equivalence, the corpus, and porting each policy's tests with its code.
- **Two read paths, SQLite and pack, mean two places for bugs.** Mitigation: derived pack sections come only from the 0.5 layout, the SQLite path remains the reference for them, and every corpus run executes both.
- **Studio scope can grow without limit.** Mitigation: five workspaces, an explicit parity list, and the removals above.
- **Replacing the HTTP server can change edge behavior.** Mitigation: port the HTTP checks before switching.
- **The stdio relay adds a moving part to the desktop shell.** Mitigation: it uses the same handlers as HTTP and is covered by the Studio workflow suite.

## Open questions

1. Do 0.5.2 Studio project stores use exactly the City store layouts, so the adapter can be a thin mapping?
2. Should packs in a scenario collection share baseline sections, or stay one per scenario?
3. Should Reach surfaces gain a binary response encoding alongside JSON?
4. Electron or Tauri after M5?
5. Should crate versions become 1.0.0 while City format 1, API 1.0 and Result schema 1 keep their own numbers? The proposal is yes: product and format versions are independent.
