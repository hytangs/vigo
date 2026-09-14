# Agency efficiency audit

This pass reviews the additions since `[START OF VIGO AGENCY]`, with implementation changes concentrated on repeated Agency work. The review followed network state, station boards, line diagrams, Ask/provider handling, retained observations, fare annotation, CLI entry points and desktop packaging. It is a focused performance review, not a claim that every line or deployment configuration has been independently certified. Routing and accessibility algorithms are unchanged.

## Changes

- **Timetable window reuse.** Network comparisons previously issued a stop-window SQL query for every route/direction/stop group on every read. They now retain active-service rows from whole service-clock hours, keyed by route, direction, stop, date and interval. Every result still applies the exact inclusive request bounds. This is query overfetching, not a change to the measurement window.
- **Indexed stop matching.** Realtime departures and station/vehicle calls reuse indexes of immutable scheduled sequences. Duplicate identities, conflicting sequences, repeated stops and unknown terminal sequences retain their previous outcomes. Alert references build one route/stop index per assessment instead of scanning the full stop list for every alert.
- **Bounded working sets.** Scheduled trips are limited to 4,096 entries, 250,000 connections and 32 MiB of estimated data. Timetable windows are limited to 16,384 entries, 100,000 rows and 16 MiB of estimated data. Each cache evicts when any limit is reached; later reads reload the same timetable. Derived sequence indexes use weak references. These weights are not process-RSS limits.
- **Clock and calendar reuse.** Date formatters and service-day anchors have bounded caches. Static calendar extent is computed once per City context. Active-service caching accommodates the overlapping dates used by station boards. Freshness and current-time checks still run at the requested instant.
- **One observation refresh effect.** A snapshot or selection change now starts one Agency refresh, replacing two overlapping React effects. Cleanup cancels the obsolete request and timer.

## Saved-feed measurement

The comparison used the saved MBTA observation at **2026-09-14 19:37:06.766 UTC**, with 2,162 trip updates, 790 vehicles and 126 alerts, and its indexed timetable. Each view ran once, then 12 measured warm repetitions in one shared City context. Platform: macOS arm64, Node 26.7.0. The comparison baseline was commit `3f78004`.

| View | Before warm median | After warm median | Before warm p95 | After warm p95 |
| --- | ---: | ---: | ---: | ---: |
| Network state | 908 ms | 103 ms | 1,118 ms | 125 ms |
| Park Street board | 170 ms | 29 ms | 194 ms | 32 ms |
| Red Line diagram | 2.84 ms | 0.66 ms | 51.6 ms | 1.45 ms |

Full network, station and line outputs matched the baseline with deep equality. A separate rerun measured warm medians of 123 ms, 36 ms and 0.98 ms; these are local measurements under variable machine load, not universal latency guarantees. Twelve repetitions give only a coarse tail estimate.

The profiled network refresh initially made 8,044 reference queries. The new cache retained those windows in roughly 9.8 MB of estimated payload; scheduled trip rows occupied roughly 14.1 MB. Neither cache evicted entries in this replay. Eviction is separately exercised in the regression test.

Cold loading remains material: in the paired comparison, first network derivation took 1.27 seconds and the first station board took 654 ms. The repeat run was slower under concurrent machine load. These timings exclude feed retrieval, HTTP serialization, browser rendering, route search and model inference. The audit does not establish LLM quality or field performance.

## Reproduce and check

```sh
node scripts/benchmark-agency-state.mjs STORE.sqlite SNAPSHOT.json STOP_ID ROUTE_ID report.json
node test/check-agency-efficiency.mjs
npm run check:agency
```

The benchmark opens the timetable read-only and replays the supplied snapshot at its saved timestamp. It makes no model or network requests and rejects a timetable that does not cover the snapshot date. Do not use these results as a report of current service.

The efficiency regression checks exact SQL equivalence as a window advances, day/direction isolation, cache eviction and reload, formatter reuse, indexed versus linear call matching, and freshness expiry after caches warm. Existing Agency checks cover stop/route identity, daylight saving, calendars, headway evidence, provider/stream lifecycle, notebook retention, operational records and LAMP data limits.

No extra result cache was placed around realtime assessments or LLM answers. This avoids turning a faster response into an older observation.

## Follow-up: active calendars and station reads

The next pass used `faca1dc` as its baseline and the same saved observation. Profiling separated the station's SQL lookup from live-trip matching and also measured the schedule window used by network diagnosis and service outlooks.

- **Resolve identity before loading stop times.** `matchTripIdentity` retains the complete matcher’s date, source scope, route, direction, ambiguity and frequency checks. Station boards, prediction admission and evidence checks use it when they only need trip identity. The full matcher adds scheduled calls and the service-day anchor when requested. A board filters to its station only after resolving against the whole feed, so an ambiguous trip in another source cannot become a false match.
- **Visit active calendars.** Station schedules and network trip spans are grouped once by their declared GTFS service IDs. Each read still resolves current calendar exceptions and exact time intersections. Service-window output retains its original ordering, overnight dates and frequency exclusions. The retained rows replace the previous flat rows; this does not add a cache of live results or another database.
- **Expose cold costs.** The benchmark now includes a 30-minute service window and separately measures each view with a fresh Agency context. Cold here means empty application caches, not an empty operating-system disk cache.

With one fresh context per measured function and 12 warm repetitions:

| Work | Before warm median | After warm median |
| --- | ---: | ---: |
| Park Street, timetable only | 13.8 ms | 3.3 ms |
| Park Street, live board | 24.9 ms | 13.9 ms |
| Network scheduled-service window | 108.7 ms | 1.0 ms |

The live station read loaded **134 trip schedules instead of 2,161**. Full station results with and without live data, the service window, and the prior network/line replay outputs passed deep equality. The independent shared-context benchmark measured an 8.4 ms warm station median and a 0.74 ms service-window median. Results vary with laptop load and execution order; these are computation measurements, not end-to-end app or model latency.

Cold work remains: the station query must include incoming connections for terminal arrivals, and the current store has no incoming-stop index. Its query plan scans the connections table. The isolated live board remained around 0.7 seconds; the first service-window calculation was around 0.6 seconds. This pass does not claim a cold-start improvement or change the routing store to obtain one.

Regression coverage now also compares identity-only and complete admission, checks cross-feed ambiguity before station filtering, verifies that unrelated reports do not load stop times, and compares service windows with the previous full-scan definition across calendar exceptions, time boundaries and timezones. Existing overnight and DST fixtures remain in the Agency suite.

Validation passed: Agency, GTFS/fare, security, CLI, UI and map suites; TypeScript, web, CLI and native desktop build; packaged macOS arm64 runtime and City portability/route parity. The rebuilt application and ZIP are in the ignored `release/` directory. Protected assessment documents and routing/accessibility algorithms were not edited.
