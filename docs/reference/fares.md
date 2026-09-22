# Published fares on itineraries

Route and Ask show boarding prices from the imported GTFS feed. Expand the fare line to see ticket names, payment methods and the agency's fare link. JSON routing results carry the same information in `plan.legs[].fare`.

These are prices for a **new boarding**, not an optimized journey fare. Multi-leg results deliberately have no total: joining legs, transfer discounts, passes and existing tickets can change what a rider pays. A missing quote does not mean free travel. Path selection continues to use the existing routing engine and does not consider price.

## Data and matching

The importer retains fare tables and their route, station, agency and calendar references in an optional `fare_catalogs` SQLite table. Catalogs travel with a City and stay separate when feeds are merged, including feeds that reuse the same route IDs. Existing Cities built before this addition need their original GTFS reimported to retain fare data.

- **Fares v2 takes precedence** when `fare_products.txt` is present. Matching uses route networks, station areas, rule priorities, fare timeframes and the default rider category. Product names and media come from the feed. MBTA's `transfer_only` extension is honored so a free-transfer product never becomes a free new boarding.
- **Fares v1** supports flat, route and origin/destination-zone boarding prices. Zone-traversal (`contains_id`) rules are left unquoted.
- Fare timeframes use the civil date and time at the validation stop, including its timezone, daylight-saving changes, times beyond midnight, and calendar exceptions. The conversion starts from GTFS's local-noon-minus-twelve-hours service clock. For a realtime-adjusted leg, the original scheduled stop sequence must be uniquely recoverable before applying timed rules.
- Explicit platform fare areas override inherited station areas. Ambiguous network assignments, conflicting products, missing references and unsupported conditions are left unquoted. An unreadable optional fare catalog never discards an already-computed route.
- The fare layer does not implement transfer totals, effective joined fare legs, pass selection, non-default rider eligibility or fare-based route optimization. Separate boarding options remain visible even when those products would change the journey total.

The matching rules follow the [GTFS Schedule reference](https://gtfs.org/documentation/schedule/reference/#fare_leg_rulestxt). No agency prices or route-name lookup rules are embedded in code. Prices reflect the saved feed, rather than a separate live fare service.

## Verification

`node test/check-gtfs-fares.mjs` covers exact matching, missing data, published zero fares, invalid prices, transfer-only products, default rider categories, area inheritance, empty-rule semantics, priority rules, after-midnight date changes, time-window boundaries, scoped multi-feed import and merge, and non-mutating itinerary annotation. Existing import safety, ordered routing and Ask journey checks remain applicable.

## Performance

Fare lookup happens only after route selection. No fare code runs in the routing search, matrix or accessibility calculations. Catalogs are loaded by feed scope, then indexed once. Products, calendars and currency formatters are reused. Quote, candidate, catalog and scheduled-trip caches have explicit entry or memory bounds and are released with their database/catalog. Replacing a catalog invalidates its caches.

Fare annotations with cached catalogs and trip sequences perform no SQL. A live-adjusted ride reads the timetable only if its matching fare depends on time; alternative plans reuse that trip's scheduled sequence. Loop matching takes linear time and rejects ambiguous sequences. The UI mounts ticket details only when expanded and imports only the small currency-formatting module.

This does **not** mean zero end-to-end cost: first-use catalog parsing/indexing, response serialization and rendering still take time. Measure separately from routing:

```sh
node scripts/benchmark-fares.mjs FEED.zip STORE.sqlite YYYY-MM-DD report.json
```

Use the original, unscoped SQLite store for the supplied feed. The script reports cold, first-pass and warm fare lookup times over representative trip spans; it neither runs a routing benchmark nor proves that the selected trips are active on that date. SQL-count assertions in the fare test protect the warm path independently of machine-speed fluctuations.
