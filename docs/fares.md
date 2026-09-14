# Published fares on itineraries

Route and Ask show boarding prices from the imported GTFS feed. Expand the fare line to see ticket names, payment methods and the agency's fare link. JSON routing results carry the same information in `plan.legs[].fare`.

These are prices for a **new boarding**, not an optimized journey fare. Multi-leg results deliberately have no total: joining legs, transfer discounts, passes and existing tickets can change what a rider pays. A missing quote does not mean free travel. Path selection continues to use the existing routing engine and does not consider price.

## Data and matching

The importer retains fare tables and their route, station, agency and calendar references in an optional `fare_catalogs` SQLite table. Catalogs travel with a City and stay separate when feeds are merged, including feeds that reuse the same route IDs. Existing Cities built before this addition need their original GTFS reimported to retain fare data.

- **Fares v2 takes precedence** when `fare_products.txt` is present. Matching uses route networks, station areas, rule priorities, fare timeframes and the default rider category. Product names and media come from the feed. MBTA's `transfer_only` extension is honored so a free-transfer product never becomes a free new boarding.
- **Fares v1** supports flat, route and origin/destination-zone boarding prices. Zone-traversal (`contains_id`) rules are left unquoted.
- Fare timeframes use the calendar day at the validation event, including service times beyond midnight, and calendar exceptions. For a realtime-adjusted leg, the original scheduled stop sequence must be uniquely recoverable before applying timed rules. Cross-timezone validation events are left unquoted.
- The fare layer does not implement transfer totals, effective joined fare legs, pass selection, non-default rider eligibility or fare-based route optimization. Separate boarding options remain visible even when those products would change the journey total.

The matching rules follow the [GTFS Schedule reference](https://gtfs.org/documentation/schedule/reference/#fare_leg_rulestxt). No agency prices or route-name lookup rules are embedded in code. Prices reflect the saved feed, rather than a separate live fare service.

## Verification

`node test/check-gtfs-fares.mjs` covers exact matching, missing data, published zero fares, invalid prices, transfer-only products, default rider categories, area inheritance, empty-rule semantics, priority rules, after-midnight date changes, time-window boundaries, scoped multi-feed import and merge, and non-mutating itinerary annotation. Existing import safety, ordered routing and Ask journey checks remain applicable.
