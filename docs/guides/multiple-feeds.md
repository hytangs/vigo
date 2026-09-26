# Combine timetables and live feeds

A City can contain several static GTFS feeds and several GTFS-Realtime endpoints. Static feeds supply the scheduled network. Live feeds supply observations and predictions for that network; they do not replace the timetable.

## Build a City from multiple GTFS files

In Studio, open **City → Data sources** and add each GTFS ZIP. VIGO imports each source, then builds the combined routing store. Add an overlapping OSM PBF for walking, driving, and coordinate-based transit access. Wait for preparation to finish before querying.

For Engine, repeat `--gtfs` and give each input a stable, unique scope:

```bash
node public/vigo.mjs build \
  --gtfs ./rail.zip --gtfs-scope rail \
  --gtfs ./bus.zip --gtfs-scope bus \
  --osm ./region.osm.pbf \
  --out ./city
```

A scope identifies a **source feed**, not a route number. The merged store namespaces stops, routes, trips, services, and transfer references so identical IDs in different feeds cannot overwrite one another. Use the same scope names when rebuilding the same sources. Removing a source in Studio rebuilds the surviving combined store.

Before combining feeds:

- Use compatible service dates. A trip is usable only when its source calendar and exceptions activate it for the requested service day.
- Keep agencies in one timezone. Cross-timezone routing stores are currently rejected.
- Avoid importing two editions of the same agency timetable as separate networks unless that duplication is intentional.
- Retain declared transfers and verify street coverage. Close coordinates alone do not prove a usable station connection.

## Connect multiple GTFS-RT endpoints

1. Open **City → Data sources → GTFS-RT live feeds**, or feed settings in **Network**.
2. Paste an endpoint URL and choose what it contains. A combined endpoint may contain multiple entity types.
3. Select its matching **Timetable** when the City has multiple static sources.
4. Choose **Add feed** for each additional endpoint, then **Connect live**.
5. Expand **Feed status** to inspect individual failures and freshness.

Trip Updates can be connected without Vehicle Positions. The MBTA preset fills three public endpoints; select the MBTA timetable when using it in a combined City. A failed endpoint does not discard successful endpoints. Reimporting or merging a timetable invalidates the active retained observation until a fresh fetch binds to the new City. Old records from a failed endpoint are not carried into a newly received snapshot.

| Data | What VIGO uses it for |
| --- | --- |
| Trip Updates | Supported predictions and cancellations in transit Route; trip and station inspection |
| Vehicle Positions | Reported map locations, vehicle details and qualified service observations |
| Alerts | Scoped notices and evidence; text does not automatically close a route |

Studio allows up to **16 distinct endpoints**. Repeated URLs with the same timetable are fetched once. Assigning one URL to conflicting timetables is rejected. A refresh has a 30-second overall deadline, a 20 MB per-feed limit, and a 40 MB combined limit. Batches also reject more than 200,000 entities or 500,000 stop predictions. At most four feed downloads run concurrently across inspections. Oversized or failed sources are disclosed individually.

The declared type is descriptive: all supported entities present in the protobuf are decoded. A source timestamp and timetable identity travel with each record. Unscoped IDs can match only when unambiguous; a bare trip ID never resolves by selecting the first agency.

## Supply observations to Engine

The public CLI accepts a retained normalized `realtimeSnapshot` in a Route request with `--data-mode realtime`. It does not open feed URLs. For a combined City, each record can carry `sourceScope` equal to its build scope, alongside the original `tripId`, `sourceFeedTimestamp`, service date and stop predictions. A single-source City uses raw GTFS IDs; omit `sourceScope` there.

Keep source timestamps intact. Changing a capture's timestamps to make it look current changes the input and is not a replay of that observation. A repeated snapshot ages out of the routing cache.

Continue with [realtime routing and admission](../reference/realtime-routing.md), [GTFS feature support](../reference/gtfs-support-matrix.md), and [traffic input](../reference/street-routing.md#supplied-traffic).
