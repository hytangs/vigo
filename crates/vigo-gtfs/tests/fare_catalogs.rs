//! Fare catalogs in built, merged and multi-feed City stores (the store side
//! of test/check-gtfs-fares.mjs, which no longer reads ZIPs itself).
mod support;

use rusqlite::Connection;
use std::path::Path;
use support::{entry, scratch, write_zip};
use vigo_format::js::Js;
use vigo_gtfs::{BuildOptions, Feed, StoreSource, build_city_store, build_store, merge_stores};

const TABLES: &[(&str, &str)] = &[
    (
        "agency.txt",
        "agency_id,agency_timezone,agency_fare_url,agency_name,agency_url\nA,America/New_York,https://example.com/fares,Fixture,https://example.com\n",
    ),
    (
        "routes.txt",
        "route_id,agency_id,network_id,route_type,route_short_name\nR,A,N,3,R\n",
    ),
    (
        "stops.txt",
        "stop_id,stop_name,stop_lat,stop_lon\nS,Start,42.35,-71.06\nT,End,42.4,-71.01\n",
    ),
    (
        "stop_areas.txt",
        "stop_id,area_id\nP,origin\nT,destination\n",
    ),
    (
        "fare_products.txt",
        "fare_product_id,fare_product_name,amount,currency,fare_media_id\nadult,Single ride,2.40,USD,card\nfree,Transfer,0.00,USD,\n",
    ),
    (
        "fare_media.txt",
        "fare_media_id,fare_media_name\ncard,Transit card\n",
    ),
    (
        "fare_leg_rules.txt",
        "network_id,from_area_id,to_area_id,fare_product_id,transfer_only\nN,,,adult,\nN,,,free,1\n",
    ),
    ("trips.txt", "trip_id,route_id,service_id\nTR,R,WKD\n"),
    (
        "stop_times.txt",
        "trip_id,stop_id,stop_sequence,arrival_time,departure_time\nTR,S,1,08:00:00,08:00:00\nTR,T,2,08:10:00,08:10:00\n",
    ),
    (
        "calendar_dates.txt",
        "service_id,date,exception_type\nWKD,20260914,1\n",
    ),
];

fn catalogs(store: &Path) -> Vec<(String, Js)> {
    let db = Connection::open(store).unwrap();
    db.prepare("SELECT scope, data FROM fare_catalogs ORDER BY scope")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap()
        .map(|row| {
            let (scope, data) = row.unwrap();
            (scope, vigo_gtfs::jsval::parse_json(&data).unwrap())
        })
        .collect()
}

fn adult_amount(catalog: &Js) -> Option<&str> {
    match catalog.get("tables")?.get("fare_products")? {
        Js::Array(products) => products.first()?.get("amount")?.as_str(),
        _ => None,
    }
}

#[test]
fn fare_catalogs_are_kept_per_feed_scope() {
    let directory = scratch("fares");
    let entries: Vec<_> = TABLES
        .iter()
        .map(|(name, content)| entry(name, content.as_bytes()))
        .collect();
    let zip = write_zip(&directory, "fare.zip", &entries);
    let store = directory.join("fare.sqlite");
    let options = BuildOptions::default();
    let metadata = build_store(&zip, &store, &options, false, &mut |_| {}).unwrap();
    assert_eq!(
        metadata
            .get("fareData")
            .and_then(|fare| fare.get("standard"))
            .and_then(Js::as_str),
        Some("GTFS Fares v2")
    );
    let single = catalogs(&store);
    assert_eq!(single.len(), 1);
    assert_eq!(single[0].0, "");
    assert_eq!(
        single[0].1.get("source").and_then(Js::as_str),
        Some("fare.zip")
    );
    assert_eq!(adult_amount(&single[0].1), Some("2.40"));

    let merged = directory.join("merge.sqlite");
    let sources: Vec<StoreSource> = ["one", "two"]
        .map(|scope| StoreSource {
            scope: scope.into(),
            store_path: store.clone(),
        })
        .to_vec();
    merge_stores(&sources, &merged, false, false, &mut |_| {}).unwrap();
    let city = directory.join("city.sqlite");
    let feeds: Vec<Feed> = ["one", "two"]
        .map(|scope| Feed {
            scope: scope.into(),
            path: zip.clone(),
        })
        .to_vec();
    build_city_store(&feeds, &city, &options, &mut |_| {}).unwrap();
    for output in [&merged, &city] {
        let scoped = catalogs(output);
        assert_eq!(
            scoped
                .iter()
                .map(|(scope, _)| scope.as_str())
                .collect::<Vec<_>>(),
            ["one", "two"],
            "{}",
            output.display()
        );
        for (_, catalog) in &scoped {
            assert_eq!(adult_amount(catalog), Some("2.40"));
        }
    }
    let _ = std::fs::remove_dir_all(&directory);
}
